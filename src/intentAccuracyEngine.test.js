import { describe, expect, it } from "vitest";
import { normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import { applyIntentAccuracyGate, evaluateIntentAccuracy } from "./intentAccuracyEngine.js";

function plan(input, draft) {
  return normalizeHcmPlannerDraft(input, draft, createHarnessScenarioHome());
}

describe("intent accuracy engine", () => {
  it("accepts precise state queries without forcing device-control checks", () => {
    const home = createHarnessScenarioHome();
    const normalized = plan("玄关人体目前是什么状态", {
      intent_type: "state_query",
      intent: "query_entry_motion",
      confidence: 0.92,
      query: { device_id: "entry_motion", reason: "查询玄关人体" },
      actions: [],
    });

    const analysis = evaluateIntentAccuracy({ input: normalized.input, plan: normalized, home });

    expect(analysis.ok).toBe(true);
    expect(analysis.issues).toEqual([]);
  });

  it("does not treat normal cross-room scenes as a context mismatch", () => {
    const home = createHarnessScenarioHome();
    const normalized = plan("我要晾衣服", {
      intent_type: "scene",
      intent: "prepare_laundry_drying",
      confidence: 0.88,
      actions: [{ device_id: "balcony_drying_rack", capability: "drying_rack_position", value: 100 }],
    });

    const analysis = evaluateIntentAccuracy({
      input: normalized.input,
      plan: normalized,
      home,
      context: { likelySpace: { id: "study", name: "书房", confidence: 0.92 } },
    });

    expect(analysis.ok).toBe(true);
    expect(analysis.issues).toEqual([]);
  });

  it("requires confirmation when an explicit room is mapped to the wrong target room", () => {
    const home = createHarnessScenarioHome();
    const normalized = {
      input: "主卧空调调到 26 度",
      intentType: "device_control",
      intent: "set_ac_temperature",
      confidence: 0.9,
      summary: "错误地把主卧空调映射到了客厅风扇。",
      needsConfirmation: false,
      actions: [{ thingId: "living_fan", capabilityId: "fan_percentage", value: 26 }],
    };

    const analysis = evaluateIntentAccuracy({ input: normalized.input, plan: normalized, home });
    const gated = applyIntentAccuracyGate(normalized, analysis);

    expect(analysis.requiresConfirmation).toBe(true);
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ code: "explicit_room_mismatch", severity: "high" }),
    );
    expect(gated.plan.needsConfirmation).toBe(true);
  });

  it("requires confirmation when an ambiguous local comfort command ignores occupancy context", () => {
    const home = createHarnessScenarioHome();
    const normalized = plan("这边有点热", {
      intent_type: "device_control",
      intent: "cool_down",
      confidence: 0.82,
      actions: [{ device_id: "master_ac", capability: "set_temperature", value: 24 }],
    });

    const analysis = evaluateIntentAccuracy({
      input: normalized.input,
      plan: normalized,
      home,
      context: { likelySpace: { id: "study", name: "书房", confidence: 0.92 } },
    });

    expect(analysis.requiresConfirmation).toBe(true);
    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ code: "context_room_mismatch", severity: "high" }),
    );
  });

  it("keeps low-confidence execution visible for review", () => {
    const home = createHarnessScenarioHome();
    const normalized = plan("随便弄一下", {
      intent_type: "device_control",
      intent: "unclear_control",
      confidence: 0.3,
      actions: [{ device_id: "living_light", capability: "living_light_switch", value: true }],
    });

    const analysis = evaluateIntentAccuracy({ input: normalized.input, plan: normalized, home });

    expect(analysis.issues).toContainEqual(expect.objectContaining({ code: "low_model_confidence" }));
    expect(analysis.requiresConfirmation).toBe(false);
  });

  it("blocks a short follow-up when the model changes the conversation target", () => {
    const home = createHarnessScenarioHome();
    const normalized = plan("关一下", {
      intent_type: "device_control",
      intent: "关闭书房吊灯",
      confidence: 0.95,
      actions: [{ device_id: "living_light", capability: "living_light_switch", value: false }],
    });
    const analysis = evaluateIntentAccuracy({
      input: "关一下",
      plan: normalized,
      home,
      conversation: { focusedTargets: [{ id: "asset_dining_餐厅射灯", name: "餐厅射灯" }] },
    });

    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ code: "conversation_target_mismatch", severity: "critical" }),
    );
    expect(analysis.requiresConfirmation).toBe(true);
  });

  it("blocks a room-scoped follow-up when the model jumps away from the recent room", () => {
    const home = createHarnessScenarioHome();
    const normalized = plan("吊灯", {
      intent_type: "device_control",
      intent: "打开客厅灯",
      confidence: 0.9,
      actions: [{ device_id: "living_light", capability: "living_light_switch", value: true }],
    });
    const analysis = evaluateIntentAccuracy({
      input: "吊灯",
      plan: normalized,
      home,
      conversation: { focusedRooms: [{ id: "study", name: "书房" }] },
    });

    expect(analysis.issues).toContainEqual(
      expect.objectContaining({ code: "conversation_room_mismatch", severity: "critical" }),
    );
    expect(analysis.requiresConfirmation).toBe(true);
  });

  it("lets recent conversation room override passive occupancy for comfort follow-ups", () => {
    const home = createHarnessScenarioHome();
    const normalized = plan("还是有点暗", {
      intent_type: "device_control",
      intent: "打开客厅灯",
      confidence: 0.9,
      actions: [{ device_id: "living_light", capability: "living_light_switch", value: true }],
    });
    const analysis = evaluateIntentAccuracy({
      input: "还是有点暗",
      plan: normalized,
      home,
      context: { likelySpace: { id: "study", name: "书房", confidence: 0.92 } },
      conversation: {
        focusedTargets: [{ id: "living_light", name: "客厅灯", roomId: "living" }],
        focusedRooms: [{ id: "living", name: "客厅" }],
      },
    });

    expect(analysis.issues).not.toContainEqual(expect.objectContaining({ code: "conversation_target_mismatch" }));
    expect(analysis.issues).not.toContainEqual(expect.objectContaining({ code: "context_room_mismatch" }));
    expect(analysis.requiresConfirmation).toBe(false);
  });
});
