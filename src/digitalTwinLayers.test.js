import { describe, expect, it } from "vitest";
import { createHouseSceneModel } from "./houseSceneModel.js";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import { applyDigitalTwinLayersToScene, buildDigitalTwinLayers } from "./digitalTwinLayers.js";

describe("digital twin layers", () => {
  it("keeps selected room and occupied room as separate layers", () => {
    const sceneModel = createHouseSceneModel({ hcmHome: createHarnessScenarioHome() });
    const layers = buildDigitalTwinLayers({
      sceneModel,
      selectedRoomId: "living",
      context: {
        spaces: [
          { id: "study", name: "书房", occupied: true, confidence: 0.92 },
          { id: "living", name: "客厅", occupied: false, confidence: 0 },
        ],
      },
    });
    const layered = applyDigitalTwinLayersToScene(sceneModel, layers);

    expect(layers.layers.selection.roomIds).toEqual(["living"]);
    expect(layers.layers.occupancy.roomIds).toEqual(["study"]);
    expect(layered.rooms.find((room) => room.id === "living")).toMatchObject({
      selected: true,
      occupied: false,
      layers: ["selection"],
    });
    expect(layered.rooms.find((room) => room.id === "study")).toMatchObject({
      selected: false,
      occupied: true,
      layers: ["occupancy"],
    });
  });

  it("marks dry-run targets as preview and executed targets as execution", () => {
    const sceneModel = createHouseSceneModel({ hcmHome: createHarnessScenarioHome() });
    const dryRunLayers = buildDigitalTwinLayers({
      sceneModel,
      plan: {
        commandResult: { status: "dry_run" },
        steps: [{ deviceId: "asset_living_客厅灯" }],
      },
    });
    const executedLayers = buildDigitalTwinLayers({
      sceneModel,
      plan: {
        commandResult: { status: "executed" },
        steps: [{ deviceId: "asset_living_客厅灯" }],
      },
    });

    expect(dryRunLayers.layers.preview.deviceIds).toEqual(["asset_living_客厅灯"]);
    expect(dryRunLayers.layers.execution.deviceIds).toEqual([]);
    expect(executedLayers.layers.execution.deviceIds).toEqual(["asset_living_客厅灯"]);
    expect(executedLayers.layers.preview.deviceIds).toEqual([]);
  });

  it("marks needs-confirmation targets as preview instead of execution", () => {
    const sceneModel = createHouseSceneModel({ hcmHome: createHarnessScenarioHome() });
    const layers = buildDigitalTwinLayers({
      sceneModel,
      plan: {
        commandResult: { status: "needs_confirmation" },
        steps: [{ deviceId: "asset_living_客厅灯" }],
      },
    });

    expect(layers.layers.preview.deviceIds).toEqual(["asset_living_客厅灯"]);
    expect(layers.layers.execution.deviceIds).toEqual([]);
  });

  it("marks diagnostic targets as alert without inventing devices", () => {
    const sceneModel = createHouseSceneModel({ hcmHome: createHarnessScenarioHome() });
    const layers = buildDigitalTwinLayers({
      sceneModel,
      diagnostics: {
        findings: [
          {
            severity: "high",
            targets: [{ thingId: "cat_camera" }, { thingId: "missing_device" }],
          },
        ],
      },
    });

    expect(layers.layers.alert.deviceIds).toEqual(["cat_camera"]);
    expect(layers.layers.alert.roomIds).toEqual(["cat_room"]);
  });
});
