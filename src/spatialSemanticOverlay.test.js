import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { attachHcmControlGraph, findExplicitRoomIds } from "./hcmControlGraph.js";
import { answerHcmInventoryQuery } from "./hcmKnowledgeQuery.js";
import { compileHcmForPlanner, normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { answerHcmRoomLightStateQuery } from "./hcmStateQuery.js";
import { applySpatialSemanticOverlay } from "./spatialSemanticOverlay.js";

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

function createEntryHallHome() {
  return attachHcmControlGraph(createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [{ id: "entry", name: "入户" }],
    things: [{
      id: "entry_panel",
      name: "入户三号开关",
      type: "switch_panel",
      spaceId: "entry",
      capabilities: [
        control("hall_spot_1", "过道射灯1 开关左键", "switch.hall_spot_1", true),
        control("hall_spot_2", "过道射灯2 开关右键", "switch.hall_spot_2", false),
        control("hall_strip", "过道灯带 开关中键", "switch.hall_strip", false),
        control("entry_light", "入户灯 开关右键", "switch.entry_light", false),
      ],
    }],
  }));
}

function createHallSpatialRecord() {
  return {
    updatedAt: "2026-07-03T20:02:31.123Z",
    source: "browser",
    state: {
      customRooms: [{ id: "custom_hall", name: "过道", type: "generic" }],
      roomNames: { custom_hall: "过道" },
      deviceAssignments: {
        "asset_entry_过道射灯1": "custom_hall",
        "asset_entry_过道射灯2": "custom_hall",
        "asset_entry_过道灯带": "custom_hall",
        "asset_entry_入户灯": "entry",
      },
    },
  };
}

describe("spatial semantic overlay", () => {
  it("promotes map-confirmed rooms into HCM semantics without changing logical asset ids", () => {
    const home = applySpatialSemanticOverlay(createEntryHallHome(), createHallSpatialRecord());

    expect(home.spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "entry", name: "入户" }),
        expect.objectContaining({ id: "custom_hall", name: "过道" }),
      ]),
    );
    expect(findExplicitRoomIds("关过道射灯", home)).toEqual(["custom_hall"]);
    expect(findExplicitRoomIds("关入户灯", home)).toEqual(["entry"]);

    const hallSpot = home.controlGraph.assets.find((asset) => asset.id === "asset_entry_过道射灯1");
    const entryLight = home.controlGraph.assets.find((asset) => asset.id === "asset_entry_入户灯");

    expect(hallSpot).toMatchObject({
      id: "asset_entry_过道射灯1",
      name: "过道射灯1",
      spaceId: "custom_hall",
      roomName: "过道",
      baseSpaceId: "entry",
      spatialRoomName: "过道",
    });
    expect(entryLight).toMatchObject({ spaceId: "entry", roomName: "入户" });
  });

  it("uses spatial room assignments in planner, state, and inventory resolution", () => {
    const home = applySpatialSemanticOverlay(createEntryHallHome(), createHallSpatialRecord());

    const plannerDevices = compileHcmForPlanner(home, { input: "关过道射灯" });
    const hallDeviceNames = plannerDevices.filter((device) => device.roomId === "custom_hall").map((device) => device.name);
    expect(hallDeviceNames).toEqual(expect.arrayContaining([
      "过道射灯1",
      "过道射灯2",
      "过道灯带",
    ]));
    expect(plannerDevices.some((device) => device.name === "入户灯")).toBe(false);

    const plan = normalizeHcmPlannerDraft(
      "关过道射灯",
      {
        intent_type: "device_control",
        intent: "关闭过道射灯",
        confidence: 0.95,
        actions: [{ device_id: "asset_entry_过道射灯1", capability: "power", value: false }],
      },
      home,
    );
    expect(plan.groupResolution.mode).toBe("numbered_group");
    expect(plan.actions.map((action) => action.logicalRoomId)).toEqual(["custom_hall", "custom_hall"]);
    expect(plan.actions.map((action) => action.logicalAssetName).sort()).toEqual(["过道射灯1", "过道射灯2"]);

    const roomLightState = answerHcmRoomLightStateQuery("过道灯开着吗", home, "查询过道灯光");
    expect(roomLightState).toMatchObject({
      mode: "room_light_state",
      roomId: "custom_hall",
      roomName: "过道",
    });
    expect(roomLightState.items.map((item) => item.thingName).sort()).toEqual(["过道射灯1", "过道射灯2", "过道灯带"]);

    const inventory = answerHcmInventoryQuery("过道有哪些灯", home, "查询过道设备");
    expect(inventory).toMatchObject({ roomId: "custom_hall", count: 3 });
    expect(inventory.items.map((item) => item.name).sort()).toEqual(["过道射灯1", "过道射灯2", "过道灯带"]);
  });
});
