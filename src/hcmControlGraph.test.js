import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import {
  ENDPOINT_MAPPING_STATUS,
  attachHcmControlGraph,
  buildHcmControlGraph,
  resolveControlAsset,
} from "./hcmControlGraph.js";
import { compileHcmForPlanner, normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { answerHcmThingStateQuery } from "./hcmStateQuery.js";

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

function createMultiGangHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [
      { id: "entry", name: "入户" },
      { id: "dining", name: "餐厅" },
      { id: "study", name: "书房" },
    ],
    things: [
      {
        id: "entry_panel",
        name: "入户1号开关",
        type: "switch_panel",
        spaceId: "entry",
        capabilities: [
          control("dining_spot", "餐厅射灯 开关左键", "switch.entry_left", true),
          control("sideboard_strip", "餐边柜灯带 开关右键", "switch.entry_right", false),
        ],
      },
      {
        id: "study_panel",
        name: "书房开关",
        type: "switch_panel",
        spaceId: "study",
        capabilities: [
          control("study_spot", "书房射灯 开关左键", "switch.study_left", true),
          control("study_ceiling", "书房吊灯 开关中键", "switch.study_middle", false),
          control("study_unused", "右键-书房开关（右键未绑定", "switch.study_right", false),
        ],
      },
    ],
  });
}

describe("HCM control graph", () => {
  it("separates physical controllers, relay endpoints, logical lights, and rooms", () => {
    const graph = buildHcmControlGraph(createMultiGangHome());

    expect(graph.controllers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "入户1号开关",
          installedSpaceId: "entry",
          endpointIds: expect.arrayContaining([
            "endpoint_switch_entry_left",
            "endpoint_switch_entry_right",
          ]),
        }),
      ]),
    );
    expect(graph.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "餐厅射灯", spaceId: "dining" }),
        expect.objectContaining({ name: "餐边柜灯带", spaceId: "dining" }),
        expect.objectContaining({ name: "书房射灯", spaceId: "study" }),
        expect.objectContaining({ name: "书房吊灯", spaceId: "study" }),
      ]),
    );
    expect(graph.assets.some((asset) => asset.name.includes("未绑定"))).toBe(false);
    expect(graph.endpoints).toContainEqual(
      expect.objectContaining({
        entityId: "switch.study_right",
        status: ENDPOINT_MAPPING_STATUS.UNBOUND,
        assetId: null,
      }),
    );
  });

  it("uses explicit load-room semantics even when the controller is installed elsewhere", () => {
    const home = createMultiGangHome();
    const inferred = buildHcmControlGraph(home);
    expect(inferred.endpoints).toContainEqual(
      expect.objectContaining({
        entityId: "switch.entry_left",
        status: ENDPOINT_MAPPING_STATUS.BOUND,
        targetSpaceId: "dining",
        relationType: "relay_control",
      }),
    );

    const confirmedHome = attachHcmControlGraph(home, {
      mappings: {
        "switch.entry_left": { status: "bound", assetName: "餐厅射灯", spaceId: "dining" },
      },
    });
    const resolved = resolveControlAsset(confirmedHome, "asset_dining_餐厅射灯");
    expect(resolved).toMatchObject({
      asset: { name: "餐厅射灯", spaceId: "dining", mappingStatus: "confirmed" },
      endpoint: { entityId: "switch.entry_left", mappingSource: "user_override" },
      thing: { id: "entry_panel" },
      capability: { id: "dining_spot" },
    });
  });

  it("marks relay state as inferred rather than claiming the lamp is observed", () => {
    const graph = buildHcmControlGraph(createMultiGangHome());
    const asset = graph.assets.find((item) => item.name === "书房射灯");

    expect(asset.state).toEqual({
      commandedState: true,
      observedState: "unknown",
      confidence: "inferred_from_relay",
    });
  });

  it("plans room-wide lighting through two independent channels and ignores the unused key", () => {
    const home = attachHcmControlGraph(createMultiGangHome());
    const plannerDevices = compileHcmForPlanner(home);
    const studyLights = plannerDevices.filter((device) => device.logicalAsset && device.roomId === "study");

    expect(studyLights.map((device) => device.name).sort()).toEqual(["书房吊灯", "书房射灯"]);
    const plan = normalizeHcmPlannerDraft(
      "关闭书房灯",
      {
        intent_type: "scene",
        intent: "turn_off_study_lights",
        confidence: 0.96,
        actions: studyLights.map((device) => ({ device_id: device.id, capability: "power", value: false })),
      },
      home,
    );

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ thingId: "study_panel", capabilityId: "study_spot", logicalRoomId: "study" }),
        expect.objectContaining({ thingId: "study_panel", capabilityId: "study_ceiling", logicalRoomId: "study" }),
      ]),
    );
    expect(plan.actions).toHaveLength(2);
  });

  it("answers logical light state without claiming direct observation", () => {
    const home = attachHcmControlGraph(createMultiGangHome());
    const answer = answerHcmThingStateQuery("书房射灯现在开着吗", home, "asset_study_书房射灯", "查询灯光");

    expect(answer).toMatchObject({
      path: "hcm-control-asset-state",
      thingId: "asset_study_书房射灯",
      roomId: "study",
      controllerId: "controller_study_panel",
    });
    expect(answer.summary).toContain("控制回路已开启");
    expect(answer.summary).toContain("未独立确认灯具实际发光");
  });

  it("reports an unknown logical light state when its controller is offline", () => {
    const home = createMultiGangHome();
    home.things[0].online = false;
    home.things[0].capabilities[0].state = "unavailable";
    const answer = answerHcmThingStateQuery(
      "餐厅射灯现在开着吗",
      attachHcmControlGraph(home),
      "asset_dining_餐厅射灯",
      "查询灯光",
    );

    expect(answer).toMatchObject({ available: false, state: "unknown" });
    expect(answer.summary).toContain("状态未知");
    expect(answer.summary).toMatch(/当前离线|尚未确认控制通道/);
    expect(answer.summary).not.toContain("已开启");
  });

  it("expands an unnumbered command to every numbered light in the same room", () => {
    const home = createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "entry", name: "入户" }],
      things: [{
        id: "hall_panel",
        name: "入户开关",
        type: "switch_panel",
        spaceId: "entry",
        capabilities: [
          control("spot_1", "过道射灯1 开关左键", "switch.hall_1", true),
          control("spot_2", "过道射灯2 开关右键", "switch.hall_2", true),
        ],
      }],
    });
    const plan = normalizeHcmPlannerDraft(
      "过道射灯关一下",
      {
        intent_type: "device_control",
        intent: "关闭过道射灯",
        confidence: 0.95,
        actions: [{ device_id: "asset_entry_过道射灯1", capability: "power", value: false }],
      },
      attachHcmControlGraph(home),
    );

    expect(plan.groupResolution.mode).toBe("numbered_group");
    expect(plan.actions.map((action) => action.logicalAssetName).sort()).toEqual(["过道射灯1", "过道射灯2"]);
  });

  it("targets only the remaining on member for a corrective group command", () => {
    const home = attachHcmControlGraph(createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "entry", name: "入户" }],
      things: [{
        id: "hall_panel",
        name: "入户开关",
        type: "switch_panel",
        spaceId: "entry",
        capabilities: [
          control("spot_1", "过道射灯1 开关左键", "switch.hall_1", false),
          control("spot_2", "过道射灯2 开关右键", "switch.hall_2", true),
        ],
      }],
    }));
    const plan = normalizeHcmPlannerDraft(
      "过道射灯还有一个没关",
      {
        intent_type: "device_control",
        intent: "关闭剩余过道射灯",
        confidence: 0.9,
        actions: [{ device_id: "asset_entry_过道射灯1", capability: "power", value: false }],
      },
      home,
    );

    expect(plan.groupResolution.groups[0].residualOnly).toBe(true);
    expect(plan.actions.map((action) => action.logicalAssetName)).toEqual(["过道射灯2"]);
  });

  it("blocks the whole group when one member has no confirmed primary actuator", () => {
    const home = attachHcmControlGraph(createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "entry", name: "入户" }],
      things: [{
        id: "hall_panel",
        name: "入户开关",
        type: "switch_panel",
        spaceId: "entry",
        capabilities: [
          control("spot_1", "过道射灯1 开关左键", "switch.hall_1", true),
          control("spot_2", "绑定（过道射灯2） 开关右键", "switch.hall_2", true),
        ],
      }],
    }));
    const plan = normalizeHcmPlannerDraft(
      "过道射灯关一下",
      {
        intent_type: "device_control",
        intent: "关闭过道射灯",
        confidence: 0.9,
        actions: [{ device_id: "asset_entry_过道射灯1", capability: "power", value: false }],
      },
      home,
    );

    expect(plan.kind).toBe("unresolved_control");
    expect(plan.actions).toEqual([]);
    expect(plan.groupResolution.blocked).toBe(true);
    expect(plan.groupResolution.unresolved).toContainEqual(expect.objectContaining({ name: "过道射灯2" }));
  });

  it("keeps remote bindings separate from the primary relay endpoint", () => {
    const home = createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "entry", name: "入户" }, { id: "master", name: "主卧" }],
      things: [
        {
          id: "entry_panel",
          name: "入户四号开关",
          type: "switch_panel",
          spaceId: "master",
          capabilities: [control("spot_2", "过道射灯2 开关右键", "switch.entry_right", true)],
        },
        {
          id: "master_panel",
          name: "主卧入户开关",
          type: "switch_panel",
          spaceId: "master",
          capabilities: [control("remote_spot_2", "绑定（过道射灯2） 开关中键", "switch.master_middle", true)],
        },
      ],
    });
    const graphHome = attachHcmControlGraph(home);
    const resolved = resolveControlAsset(graphHome, "asset_entry_过道射灯2");
    const remote = graphHome.controlGraph.endpoints.find((endpoint) => endpoint.entityId === "switch.master_middle");

    expect(resolved.endpoint.entityId).toBe("switch.entry_right");
    expect(remote).toMatchObject({ relationType: "remote_control", status: "review" });
  });
});
