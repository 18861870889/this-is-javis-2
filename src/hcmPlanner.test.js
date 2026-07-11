import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { attachHcmControlGraph } from "./hcmControlGraph.js";
import { buildNoPlannerDevicesDraft, compileHcmForPlanner, normalizeHcmPlannerDraft } from "./hcmPlanner.js";

function createPlannerHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [{ id: "living", name: "客厅" }],
    things: [
      {
        id: "ha_light",
        name: "客厅灯",
        type: "switch_panel",
        spaceId: "living",
        capabilities: [
          {
            id: "living_light",
            name: "客厅灯开关",
            kind: "control",
            valueType: "boolean",
            policy: { risk: "low", confirmation: "never", autoExecutable: true },
            binding: { provider: "home_assistant", domain: "switch", entityId: "switch.living_light" },
          },
          {
            id: "config",
            name: "互控配置",
            kind: "config",
            valueType: "text",
            policy: { risk: "high", confirmation: "always", autoExecutable: false },
            binding: { provider: "home_assistant", domain: "text", entityId: "text.config" },
          },
        ],
      },
      {
        id: "entry_motion",
        name: "入户传感器",
        type: "motion_sensor",
        spaceId: "living",
        capabilities: [
          {
            id: "motion",
            name: "检测到移动",
            kind: "sensor",
            valueType: "boolean",
            state: false,
            policy: { risk: "sensitive", confirmation: "always", autoExecutable: false },
            binding: { provider: "home_assistant", domain: "binary_sensor", entityId: "binary_sensor.entry_motion" },
          },
          {
            id: "battery",
            name: "电池电量",
            kind: "sensor",
            valueType: "number",
            state: 80,
            unit: "%",
            policy: { risk: "low", confirmation: "never", autoExecutable: false },
            binding: { provider: "home_assistant", domain: "sensor", entityId: "sensor.entry_motion_battery" },
          },
        ],
      },
    ],
  });
}

function control(id, name, entityId, state = false) {
  return {
    id,
    name,
    kind: "control",
    valueType: "boolean",
    state,
    policy: { risk: "low", confirmation: "never", autoExecutable: true },
    binding: { provider: "home_assistant", domain: "switch", entityId },
  };
}

function createStudyPlannerHome({ spot = false, ceiling = false } = {}) {
  return attachHcmControlGraph(createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [
      { id: "living", name: "客厅" },
      { id: "study", name: "书房" },
    ],
    things: [
      {
        id: "study_panel",
        name: "书房开关",
        type: "switch_panel",
        spaceId: "study",
        capabilities: [
          control("study_spot", "书房射灯 开关中键", "switch.study_spot", spot),
          control("study_ceiling", "书房吊灯 开关左键", "switch.study_ceiling", ceiling),
        ],
      },
      {
        id: "living_panel",
        name: "客厅开关",
        type: "switch_panel",
        spaceId: "living",
        capabilities: [control("living_ceiling", "客厅吊灯 开关左键", "switch.living_ceiling", false)],
      },
    ],
  }));
}

function createBedroomAmbiguityHome() {
  return attachHcmControlGraph(createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [
      { id: "卧室", name: "卧室" },
      { id: "master", name: "主卧" },
      { id: "second", name: "次卧" },
    ],
    things: [
      {
        id: "master_panel",
        name: "主卧开关",
        type: "switch_panel",
        spaceId: "master",
        capabilities: [control("master_light", "主卧主灯 开关左键", "switch.master_light", true)],
      },
      {
        id: "second_panel",
        name: "次卧开关",
        type: "switch_panel",
        spaceId: "second",
        capabilities: [control("second_light", "次卧吸顶灯 开关左键", "switch.second_light", true)],
      },
    ],
  }));
}

describe("hcm planner compiler", () => {
  it("exposes only auto executable HCM capabilities to the planner", () => {
    const devices = compileHcmForPlanner(createPlannerHome());

    expect(devices).toEqual(
      expect.arrayContaining([
      expect.objectContaining({
        id: "asset_living_客厅灯",
        logicalAsset: true,
        roomId: "living",
        capabilities: [
          expect.objectContaining({
            id: "power",
            operation: "on_off",
          }),
        ],
      }),
      expect.objectContaining({
        id: "entry_motion",
        capabilities: [
          expect.objectContaining({
            id: "motion",
            access: "read",
            operation: "read_state",
          }),
          expect.objectContaining({
            id: "battery",
            access: "read",
            operation: "read_state",
          }),
        ],
      }),
      ]),
    );
  });

  it("turns device capability questions into read-only capability answers", () => {
    const home = createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "cat_room", name: "猫猫房" }],
      things: [
        {
          id: "cat_feeder",
          name: "猫粮机",
          type: "pet_feeder",
          spaceId: "cat_room",
          capabilities: [
            {
              id: "food_out",
              name: "宠物喂食器 喂食机出粮",
              kind: "sensor",
              valueType: "unknown",
              state: "unknown",
              policy: { risk: "low", confirmation: "never", autoExecutable: false },
              binding: { provider: "home_assistant", domain: "notify", entityId: "notify.food_out" },
            },
          ],
        },
      ],
    });

    const plan = normalizeHcmPlannerDraft("猫粮机如何控制", {
      intent_type: "inventory_query",
      intent: "查询猫粮机控制方式",
      confidence: 0.9,
      actions: [],
    }, home);

    expect(plan).toMatchObject({
      kind: "hcm_capability_query",
      intentType: "inventory_query",
      actions: [],
      stateQuery: {
        path: "hcm-capability-query",
        thingId: "cat_feeder",
      },
    });
    expect(plan.summary).toContain("当前不能直接执行：喂食机出粮");
  });

  it("narrows a referential follow-up prompt to the focused logical target", () => {
    const devices = compileHcmForPlanner(createPlannerHome(), {
      input: "关一下",
      focusTargetIds: ["asset_living_客厅灯"],
    });

    expect(devices.map((device) => device.id)).toEqual(["asset_living_客厅灯"]);
  });

  it("narrows partial-execution confirmations to the executable pending targets", () => {
    const devices = compileHcmForPlanner(createStudyPlannerHome(), {
      input: "执行其他可执行设备",
      focusTargetIds: ["asset_study_书房吊灯"],
    });

    expect(devices.map((device) => device.id)).toEqual(["asset_study_书房吊灯"]);
  });

  it("uses room focus for short follow-up prompts after room-level queries", () => {
    const devices = compileHcmForPlanner(createStudyPlannerHome(), {
      input: "开一下",
      currentRoomId: "living",
      focusRoomIds: ["study"],
    });

    expect(devices.map((device) => device.name)).toEqual(["书房射灯", "书房吊灯"]);
  });

  it("narrows a bare clarification answer to the focused room and selected lamp type", () => {
    const devices = compileHcmForPlanner(createStudyPlannerHome(), {
      input: "吊灯",
      focusRoomIds: ["study"],
    });

    expect(devices.map((device) => device.name)).toEqual(["书房吊灯"]);
  });

  it("narrows brightness follow-ups to the recent target room instead of all learned rooms", () => {
    const devices = compileHcmForPlanner(createStudyPlannerHome(), {
      input: "不够亮啊",
      focusTargetIds: ["asset_study_书房射灯"],
    });

    expect(devices.map((device) => device.name)).toEqual(["书房射灯", "书房吊灯"]);
    expect(devices.map((device) => device.name)).not.toContain("客厅吊灯");
  });

  it("asks for clarification when a generic bedroom area has no executable lights", () => {
    const home = createBedroomAmbiguityHome();
    const devices = compileHcmForPlanner(home, { input: "卧室灯关一下" });
    expect(devices).toEqual([]);

    const draft = buildNoPlannerDevicesDraft("卧室灯关一下", home);
    const plan = normalizeHcmPlannerDraft("卧室灯关一下", draft, home);

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.requiresClarification).toBe(true);
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toContain("主卧");
    expect(plan.summary).toContain("次卧");
  });

  it("uses trusted room context for a generic bedroom command", () => {
    const devices = compileHcmForPlanner(createBedroomAmbiguityHome(), {
      input: "卧室灯关一下",
      currentRoomId: "second",
    });

    expect(devices.map((device) => device.name)).toEqual(["次卧吸顶灯"]);
  });

  it("lets an explicit room override conflicting current room context", () => {
    const home = createBedroomAmbiguityHome();
    const devices = compileHcmForPlanner(home, {
      input: "关主卧灯",
      currentRoomId: "second",
    });
    const plan = normalizeHcmPlannerDraft(
      "关主卧灯",
      {
        intent: "lighting",
        confidence: 0.9,
        actions: [{ target: "主卧灯", capability: "power", value: false }],
      },
      home,
    );

    expect(devices.map((device) => device.name)).toContain("主卧主灯");
    expect(devices.map((device) => device.name)).not.toContain("次卧吸顶灯");
    expect(plan.actions).toEqual([
      expect.objectContaining({
        logicalRoomId: "master",
        value: false,
      }),
    ]);
  });

  it("resolves a logical light back to its physical switch channel", () => {
    const plan = normalizeHcmPlannerDraft(
      "打开客厅灯",
      {
        intent: "lighting",
        confidence: 0.9,
        actions: [{ device_id: "asset_living_客厅灯", capability: "power", value: true }],
      },
      createPlannerHome(),
    );

    expect(plan.actions).toEqual([
      expect.objectContaining({
        thingId: "ha_light",
        thingName: "客厅灯",
        providerThingName: "客厅灯",
        logicalAssetId: "asset_living_客厅灯",
        logicalRoomId: "living",
        capabilityId: "living_light",
        value: true,
      }),
    ]);
  });

  it("rejects a logical light from a room that conflicts with the explicit user room", () => {
    const plan = normalizeHcmPlannerDraft(
      "打开书房的灯",
      {
        intent: "lighting",
        confidence: 0.7,
        actions: [{ device_id: "asset_living_客厅灯", capability: "power", value: true }],
      },
      createPlannerHome(),
    );

    expect(plan.actions).toEqual([]);
    expect(plan.rejected).toContain("客厅灯 不在用户指定的房间");
  });

  it("normalizes model drafts into HCM actions", () => {
    const plan = normalizeHcmPlannerDraft(
      "打开客厅灯",
      {
        intent: "lighting",
        confidence: 0.8,
        summary: "打开客厅灯",
        actions: [{ device_id: "ha_light", capability: "living_light", value: true }],
      },
      createPlannerHome(),
    );

    expect(plan.kind).toBe("real_hcm");
    expect(plan.actions).toEqual([
      expect.objectContaining({
        thingId: "ha_light",
        capabilityId: "living_light",
        value: true,
      }),
    ]);
  });

  it("normalizes model state queries into read-only HCM answers", () => {
    const plan = normalizeHcmPlannerDraft(
      "玄关人体目前是什么状态",
      {
        intent_type: "state_query",
        intent: "query_motion_sensor",
        confidence: 0.9,
        summary: "查询玄关传感器",
        actions: [],
        query: { device_id: "entry_motion", reason: "用户询问玄关人体状态" },
      },
      createPlannerHome(),
    );

    expect(plan.kind).toBe("hcm_state_query");
    expect(plan.intentType).toBe("state_query");
    expect(plan.stateQuery).toEqual(
      expect.objectContaining({
        thingId: "entry_motion",
        thingName: "入户传感器",
      }),
    );
    expect(plan.resolution).toMatchObject({
      type: "state_query",
      targetResolution: { status: "resolved" },
      capabilityResolution: { status: "read_only" },
    });
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toBe(plan.stateQuery.summary);
    expect(plan.summary).not.toBe("查询玄关传感器");
  });

  it("resolves Brain HomeIntent state query targets before room light aggregates", () => {
    const plan = normalizeHcmPlannerDraft(
      "书房射灯开着吗",
      {
        intent_type: "state_query",
        intent: "查询书房射灯状态",
        confidence: 0.9,
        summary: "查询书房射灯状态",
        actions: [],
        query: { mode: "state", target: "书房射灯", room_id: "study", reason: "用户询问具体灯具状态" },
      },
      createStudyPlannerHome({ spot: true, ceiling: false }),
    );

    expect(plan.kind).toBe("hcm_state_query");
    expect(plan.stateQuery).toMatchObject({
      thingId: "asset_study_书房射灯",
      thingName: "书房射灯",
    });
    expect(plan.summary).toContain("书房射灯");
    expect(plan.summary).not.toContain("书房吊灯");
  });

  it("answers inventory questions with an aggregate result", () => {
    const plan = normalizeHcmPlannerDraft(
      "客厅有几个灯",
      {
        intent_type: "inventory_query",
        intent: "count_lights",
        confidence: 0.9,
        query: { mode: "count", reason: "统计客厅灯" },
        actions: [],
      },
      createPlannerHome(),
    );

    expect(plan.kind).toBe("hcm_inventory_query");
    expect(plan.stateQuery).toMatchObject({ mode: "count", count: 1, roomId: "living" });
    expect(plan.actions).toEqual([]);
  });

  it("treats preference feedback as learning input instead of a device command", () => {
    const plan = normalizeHcmPlannerDraft(
      "建议默认开射灯，如果我觉得还是暗了就再开一下吊灯",
      {
        intent_type: "device_control",
        intent: "建议默认开射灯",
        confidence: 0.8,
        actions: [{ device_id: "asset_study_书房射灯", capability: "power", value: true }],
      },
      createStudyPlannerHome(),
    );

    expect(plan.kind).toBe("hcm_preference_feedback");
    expect(plan.intentType).toBe("preference");
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toContain("这次不会操作设备");
  });

  it("treats user corrections as feedback without changing mappings or executing devices", () => {
    const plan = normalizeHcmPlannerDraft(
      "你说错了吧 我看厨房只有灯带",
      {
        intent_type: "state_query",
        intent: "确认厨房只有灯带",
        confidence: 0.9,
        summary: "用户指出厨房只有灯带",
        actions: [],
      },
      createStudyPlannerHome(),
    );

    expect(plan.kind).toBe("hcm_correction_feedback");
    expect(plan.intentType).toBe("correction");
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toContain("不会自动改设备映射");
  });

  it("uses the lighting preference order for ambiguous room light turn-on", () => {
    const plan = normalizeHcmPlannerDraft(
      "书房灯开一下",
      {
        intent_type: "device_control",
        intent: "打开书房灯",
        confidence: 0.9,
        actions: [{ device_id: "asset_study_书房吊灯", capability: "power", value: true }],
      },
      createStudyPlannerHome(),
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      logicalAssetName: "书房射灯",
      capabilityId: "study_spot",
      value: true,
    });
  });

  it("normalizes intent_frame semantic actions into executable HCM actions", () => {
    const plan = normalizeHcmPlannerDraft(
      "打开书房射灯",
      {
        intent_frame: {
          intent_type: "device_control",
          intent: "turn_on_study_spot",
          confidence: 0.91,
          goal: {
            domain: "lighting",
            desired_outcome: "turn_on_light",
            space_refs: ["书房"],
            target_refs: ["书房射灯"],
          },
          grounding: {
            candidate_targets: [{ target_ref: "书房射灯", confidence: 0.86, reason: "用户明确点名" }],
          },
          ambiguity: { level: "low", needs_clarification: false },
          decision: {
            mode: "execute",
            actions: [{ target: "书房射灯", capability: "power", value: true, reason: "用户明确点名书房射灯" }],
          },
        },
        summary: "打开书房射灯",
      },
      createStudyPlannerHome(),
    );

    expect(plan.kind).toBe("real_hcm");
    expect(plan.intentFrame).toMatchObject({
      source: "llm_intent_frame",
      goal: { domain: "lighting", outcome: "turn_on_light" },
      decision: { mode: "execute" },
    });
    expect(plan.grounding).toMatchObject({
      version: "0.21",
      status: "resolved",
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({
        logicalAssetId: "asset_study_书房射灯",
        capabilityId: "study_spot",
        value: true,
      }),
    ]);
  });

  it("keeps high-ambiguity intent frames in clarification instead of guessing", () => {
    const plan = normalizeHcmPlannerDraft(
      "开灯",
      {
        intent_frame: {
          intent_type: "device_control",
          intent: "turn_on_light",
          confidence: 0.52,
          goal: { domain: "lighting", desired_outcome: "turn_on_light" },
          ambiguity: {
            level: "high",
            needs_clarification: true,
            ambiguous_terms: ["灯"],
            alternatives: ["书房射灯", "书房吊灯", "客厅吊灯"],
          },
          decision: { mode: "ask_clarification", reason: "缺少房间和具体灯" },
        },
        summary: "需要确认要打开哪盏灯",
      },
      createStudyPlannerHome(),
    );

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.requiresClarification).toBe(true);
    expect(plan.actions).toEqual([]);
    expect(plan.grounding).toMatchObject({
      status: "needs_clarification",
      ambiguity: { level: "high" },
    });
  });

  it("carries explicit room focus on unresolved controls for the next clarification turn", () => {
    const plan = normalizeHcmPlannerDraft(
      "书房灯关一个",
      {
        intent_type: "device_control",
        intent: "关闭书房的一个灯",
        confidence: 0.82,
        summary: "需要确认书房哪盏灯",
        actions: [],
      },
      createStudyPlannerHome(),
    );

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.contextFocus.rooms).toEqual([{ id: "study", name: "书房" }]);
  });

  it("opens another off light when the user says the room is still too dark", () => {
    const plan = normalizeHcmPlannerDraft(
      "还是有点暗",
      {
        intent_type: "device_control",
        intent: "调亮书房",
        confidence: 0.86,
        actions: [{ device_id: "asset_study_书房射灯", capability: "power", value: true }],
      },
      createStudyPlannerHome({ spot: true, ceiling: false }),
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      logicalAssetName: "书房吊灯",
      capabilityId: "study_ceiling",
      value: true,
    });
  });

  it("does not claim a brightness fix when every room light is already on", () => {
    const plan = normalizeHcmPlannerDraft(
      "还是有点暗",
      {
        intent_type: "device_control",
        intent: "调亮书房",
        confidence: 0.86,
        summary: "打开书房吊灯",
        actions: [{ device_id: "asset_study_书房吊灯", capability: "power", value: true }],
      },
      createStudyPlannerHome({ spot: true, ceiling: true }),
    );

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.actions).toEqual([]);
    expect(plan.summary).toContain("没有继续执行");
    expect(plan.summary).toContain("没有可继续打开的关闭灯光");
  });

  it("never degrades a rejected control action into a state answer", () => {
    const plan = normalizeHcmPlannerDraft(
      "关闭客厅灯",
      {
        intent_type: "device_control",
        intent: "turn_off_living_light",
        confidence: 0.9,
        query: { mode: "state", device_id: "asset_living_客厅灯" },
        actions: [{ device_id: "asset_living_客厅灯", capability: "power_state", value: false }],
      },
      createPlannerHome(),
    );

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.stateQuery).toBeNull();
    expect(plan.requiresClarification).toBe(true);
    expect(plan.rejected).toContain("客厅灯 不支持 power_state");
  });

  it("does not allow read-only sensor capabilities as executable actions", () => {
    const plan = normalizeHcmPlannerDraft(
      "玄关人体目前是什么状态",
      {
        intent_type: "device_control",
        intent: "bad_sensor_action",
        confidence: 0.7,
        actions: [{ device_id: "entry_motion", capability: "motion", value: true }],
      },
      createPlannerHome(),
    );

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.requiresClarification).toBe(true);
    expect(plan.rejected).toEqual(["入户传感器 检测到移动 不是可执行控制能力"]);
  });

  it("treats valid actions as control even when the model also emits a query object", () => {
    const plan = normalizeHcmPlannerDraft(
      "打开客厅灯",
      {
        intent_type: "device_control",
        intent: "turn_on_light",
        confidence: 0.8,
        query: { device_id: "ha_light", reason: "模型附带的冗余 query" },
        actions: [{ device_id: "ha_light", capability: "living_light", value: true }],
      },
      createPlannerHome(),
    );

    expect(plan.kind).toBe("real_hcm");
    expect(plan.stateQuery).toBeNull();
    expect(plan.actions).toHaveLength(1);
  });
});
