import { describe, expect, it } from "vitest";
import { finishCommandTrace, createCommandTrace } from "./commandRuntime.js";
import { buildHcmExecutionPlan } from "./hcmExecutor.js";
import { compileHcmForPlanner, normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import { compilePersonalSemanticsForPlanner } from "./personalSemantics.js";

function normalizeDraft(input, draft) {
  return normalizeHcmPlannerDraft(input, draft, createHarnessScenarioHome());
}

describe("HCM intent benchmark", () => {
  it("exposes executable controls and read-only state without leaking protected capabilities", () => {
    const plannerHome = compileHcmForPlanner(createHarnessScenarioHome(), { selectedRoomId: "living" });
    const thingIds = plannerHome.map((thing) => thing.id);

    expect(thingIds).toEqual(expect.arrayContaining(["entry_motion", "balcony_drying_rack", "xiaoai_speaker"]));
    expect(thingIds).not.toContain("cat_camera");
    expect(thingIds).not.toContain("gas_water_heater");

    const logicalLivingLight = plannerHome.find((thing) => thing.id === "asset_living_客厅灯");
    expect(logicalLivingLight.capabilities.map((capability) => capability.id)).toEqual(["power"]);
    const livingLightControls = plannerHome.find((thing) => thing.id === "living_light");
    expect(livingLightControls.capabilities.map((capability) => capability.id)).toEqual(["living_light_brightness"]);
    expect(livingLightControls.capabilities.map((capability) => capability.id)).not.toContain("living_light_binding");
  });

  it.each([
    {
      name: "entry motion state query",
      input: "玄关人体目前是什么状态",
      draft: {
        intent_type: "state_query",
        intent: "query_entry_motion",
        confidence: 0.92,
        query: { device_id: "entry_motion", reason: "询问玄关人体传感器状态" },
        actions: [],
      },
      expected: {
        kind: "hcm_state_query",
        intentType: "state_query",
        stateThingId: "entry_motion",
        actionCount: 0,
      },
    },
    {
      name: "speaker stop playback",
      input: "小爱音箱停止播放音乐",
      draft: {
        intent_type: "device_control",
        intent: "pause_music",
        confidence: 0.94,
        actions: [{ device_id: "xiaoai_speaker", capability: "speaker_playback", value: false, reason: "停止播放" }],
      },
      expected: {
        kind: "real_hcm",
        intentType: "device_control",
        action: ["xiaoai_speaker", "speaker_playback", false],
      },
    },
    {
      name: "laundry drying scene",
      input: "我要晾衣服",
      draft: {
        intent_type: "scene",
        intent: "prepare_laundry_drying",
        confidence: 0.88,
        actions: [
          { device_id: "balcony_drying_rack", capability: "drying_rack_position", value: 100, reason: "降下阳台晾衣杆" },
        ],
      },
      expected: {
        kind: "real_hcm",
        intentType: "scene",
        action: ["balcony_drying_rack", "drying_rack_position", 100],
      },
    },
    {
      name: "movie scene",
      input: "准备看电影",
      draft: {
        intent_type: "scene",
        intent: "movie_mode",
        confidence: 0.86,
        actions: [
          { device_id: "living_tv", capability: "tv_power", value: true, reason: "打开电视" },
          { device_id: "living_curtain", capability: "curtain_position", value: 0, reason: "关闭窗帘" },
          { device_id: "living_light", capability: "living_light_brightness", value: 20, reason: "调暗客厅灯" },
        ],
      },
      expected: {
        kind: "real_hcm",
        intentType: "scene",
        actionCount: 3,
      },
    },
    {
      name: "master bedroom AC temperature",
      input: "主卧空调调到 26 度",
      draft: {
        intent_type: "device_control",
        intent: "set_ac_temperature",
        confidence: 0.91,
        actions: [{ device_id: "master_ac", capability: "set_temperature", value: 26, reason: "设置主卧温度" }],
      },
      expected: {
        kind: "real_hcm",
        intentType: "device_control",
        action: ["master_ac", "set_temperature", 26],
      },
    },
  ])("normalizes $name", ({ input, draft, expected }) => {
    const plan = normalizeDraft(input, draft);

    expect(plan.kind).toBe(expected.kind);
    expect(plan.intentType).toBe(expected.intentType);
    expect(plan.actions).toHaveLength(expected.actionCount ?? (expected.action ? 1 : 0));
    if (expected.stateThingId) expect(plan.stateQuery.thingId).toBe(expected.stateThingId);
    if (expected.action) {
      expect(plan.actions[0]).toMatchObject({
        thingId: expected.action[0],
        capabilityId: expected.action[1],
        value: expected.action[2],
      });
    }
    expect(plan.resolution.targetResolution.status).toBe("resolved");
  });

  it.each([
    {
      name: "invented device",
      input: "打开地下室灯",
      draft: {
        intent_type: "device_control",
        intent: "turn_on_basement_light",
        confidence: 0.4,
        actions: [{ device_id: "basement_light", capability: "power", value: true }],
      },
      rejected: "未知设备 basement_light",
    },
    {
      name: "camera privacy action",
      input: "打开猫猫监控",
      draft: {
        intent_type: "device_control",
        intent: "open_camera",
        confidence: 0.8,
        actions: [{ device_id: "cat_camera", capability: "camera_snapshot", value: true }],
      },
      rejected: "猫猫监控 监控截图 不是可执行控制能力",
    },
    {
      name: "gas water heater activation",
      input: "打开燃气热水器",
      draft: {
        intent_type: "device_control",
        intent: "turn_on_water_heater",
        confidence: 0.82,
        actions: [{ device_id: "gas_water_heater", capability: "heater_power", value: true }],
      },
      rejected: "燃气热水器 热水器电源 不是可执行控制能力",
    },
    {
      name: "read-only sensor as action",
      input: "让玄关人体变成有人",
      draft: {
        intent_type: "device_control",
        intent: "bad_sensor_mutation",
        confidence: 0.5,
        actions: [{ device_id: "entry_motion", capability: "motion_event", value: true }],
      },
      rejected: "入户传感器 移动检测传感器 检测到移动 不是可执行控制能力",
    },
  ])("rejects unsafe or impossible intent: $name", ({ input, draft, rejected }) => {
    const plan = normalizeDraft(input, draft);

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.actions).toEqual([]);
    expect(plan.rejected).toContain(rejected);
    expect(plan.resolution.targetResolution.status).toBe("unresolved");
  });

  it("uses valid actions instead of a redundant query when model output is noisy", () => {
    const plan = normalizeDraft("小爱音箱停止播放音乐", {
      intent_type: "device_control",
      intent: "pause_music",
      confidence: 0.93,
      query: { device_id: "xiaoai_speaker", reason: "冗余 query" },
      actions: [{ device_id: "xiaoai_speaker", capability: "speaker_playback", value: false }],
    });

    expect(plan.kind).toBe("real_hcm");
    expect(plan.stateQuery).toBeNull();
    expect(plan.actions).toEqual([
      expect.objectContaining({
        thingId: "xiaoai_speaker",
        capabilityId: "speaker_playback",
        value: false,
      }),
    ]);
  });

  it("provides personal semantic hints for household phrases used by the planner", () => {
    const home = createHarnessScenarioHome();

    expect(compilePersonalSemanticsForPlanner("我要晾衣服", home)).toEqual([
      expect.objectContaining({
        phrase: "晾衣服",
        intent: "prepare_laundry_drying",
        candidates: [expect.objectContaining({ thingId: "balcony_drying_rack" })],
      }),
    ]);
    expect(compilePersonalSemanticsForPlanner("准备看电影", home)[0]).toMatchObject({
      phrase: "看电影",
      intent: "movie_mode",
    });
  });

  it("compiles normalized control plans into deterministic Home Assistant service calls", () => {
    const home = createHarnessScenarioHome();
    const plan = normalizeHcmPlannerDraft(
      "准备看电影",
      {
        intent_type: "scene",
        intent: "movie_mode",
        actions: [
          { device_id: "living_tv", capability: "tv_power", value: true },
          { device_id: "living_curtain", capability: "curtain_position", value: 0 },
          { device_id: "living_light", capability: "living_light_brightness", value: 20 },
          { device_id: "living_fan", capability: "fan_percentage", value: 30 },
          { device_id: "master_ac", capability: "set_temperature", value: 26 },
        ],
      },
      home,
    );
    const execution = buildHcmExecutionPlan(plan.actions, home);

    expect(execution.ok).toBe(true);
    expect(execution.rejected).toEqual([]);
    expect(execution.accepted.map((item) => item.serviceCall)).toEqual([
      { domain: "media_player", service: "turn_on", serviceData: { entity_id: "media_player.living_tv" } },
      { domain: "cover", service: "set_cover_position", serviceData: { entity_id: "cover.living_curtain", position: 0 } },
      { domain: "light", service: "turn_on", serviceData: { entity_id: "light.living_light", brightness_pct: 20 } },
      { domain: "fan", service: "set_percentage", serviceData: { entity_id: "fan.living_fan", percentage: 30 } },
      { domain: "climate", service: "set_temperature", serviceData: { entity_id: "climate.master_ac", temperature: 26 } },
    ]);
  });

  it("preserves intent resolution in audit traces", () => {
    const plan = normalizeDraft("玄关人体目前是什么状态", {
      intent_type: "state_query",
      intent: "query_entry_motion",
      confidence: 0.92,
      query: { device_id: "entry_motion", reason: "询问玄关人体传感器状态" },
      actions: [],
    });
    const trace = createCommandTrace({ input: plan.input, dryRun: true, now: () => 1000 });
    const audit = finishCommandTrace(
      trace,
      {
        status: "answered",
        plan,
        execution: { status: "answered", dryRun: true, accepted: [], rejected: [], results: [] },
        model: "test-model",
        planner: { deviceCount: 10, capabilityCount: 12 },
      },
      () => 1100,
    );

    expect(audit.plan).toMatchObject({
      kind: "hcm_state_query",
      intentType: "state_query",
      stateQuery: { thingId: "entry_motion", thingName: "入户传感器" },
      resolution: {
        type: "state_query",
        targetStatus: "resolved",
        capabilityStatus: "read_only",
      },
    });
    expect(audit.safety).toMatchObject({
      dryRun: true,
      executableCount: 0,
      rejectedCount: 0,
    });
  });
});
