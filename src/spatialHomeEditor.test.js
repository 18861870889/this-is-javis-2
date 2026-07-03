import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { attachHcmControlGraph } from "./hcmControlGraph.js";
import { createHouseSceneModel } from "./houseSceneModel.js";
import {
  addSpatialRoom,
  assignSpatialDevice,
  applySpatialEditorToScene,
  applySpatialSuggestion,
  clearSpatialPlacement,
  createSpatialEditorModel,
  createSpatialEditorState,
  dismissSpatialSuggestion,
  findSpatialRoomAtPoint,
  hasSpatialEditorEdits,
  migrateSpatialEditorStateToImageCoordinates,
  NAMING_MODES,
  placeSpatialDevice,
  removeSpatialRoom,
  SPATIAL_DEVICE_STATUS,
  updateSpatialRoomRect,
  updateSpatialDeviceName,
  updateSpatialRoomName,
} from "./spatialHomeEditor.js";

function createSwitchControlledHome() {
  return attachHcmControlGraph(createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [
      { id: "entry", name: "玄关" },
      { id: "dining", name: "餐厅" },
      { id: "study", name: "书房" },
    ],
    things: [
      {
        id: "entry_switch_1",
        name: "入户一号开关",
        type: "switch_panel",
        spaceId: "entry",
        online: true,
        capabilities: [
          {
            id: "left",
            name: "餐厅射灯 开关左键",
            kind: "control",
            valueType: "boolean",
            state: true,
            policy: { risk: "low", confirmation: "never", autoExecutable: true },
            binding: { provider: "home_assistant", domain: "switch", entityId: "switch.entry_on_p_2_1" },
          },
          {
            id: "right",
            name: "餐厅吊灯 开关右键",
            kind: "control",
            valueType: "boolean",
            state: false,
            policy: { risk: "low", confirmation: "never", autoExecutable: true },
            binding: { provider: "home_assistant", domain: "switch", entityId: "switch.entry_on_p_4_1" },
          },
        ],
      },
    ],
  }));
}

describe("spatial home editor", () => {
  it("detects whether an editor state contains user spatial edits", () => {
    expect(hasSpatialEditorEdits(createSpatialEditorState())).toBe(false);
    expect(hasSpatialEditorEdits(createSpatialEditorState({ floorPlanImageName: "户型图.png" }))).toBe(true);
    expect(hasSpatialEditorEdits(updateSpatialRoomName(createSpatialEditorState(), "study", "工作间"))).toBe(true);
    expect(hasSpatialEditorEdits(placeSpatialDevice(createSpatialEditorState(), "desk_light", { x: 10, y: 20 }))).toBe(true);
    expect(hasSpatialEditorEdits(createSpatialEditorState({ namingMode: NAMING_MODES.ROOM_CUSTOM }))).toBe(true);
  });

  it("keeps uploaded floor plan metadata in local editor state", () => {
    const state = createSpatialEditorState({
      floorPlanImage: "data:image/png;base64,abc",
      floorPlanImageName: "户型图.png",
      floorPlanImageSize: 2048,
      floorPlanImageAspectRatio: 0.5625,
      floorPlanCoordinateMode: "image",
      floorPlanImageUpdatedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      floorPlanImage: "data:image/png;base64,abc",
      floorPlanImageName: "户型图.png",
      floorPlanImageSize: 2048,
      floorPlanImageAspectRatio: 0.5625,
      floorPlanCoordinateMode: "image",
      floorPlanImageUpdatedAt: "2026-06-23T00:00:00.000Z",
    });
  });

  it("migrates legacy container coordinates into floor-plan image coordinates", () => {
    const state = createSpatialEditorState({
      roomRects: {
        study: { left: 20, top: 30, width: 20, height: 10 },
      },
      devicePlacements: {
        lamp: { placed: true, x: 30, y: 35, roomId: "study" },
      },
    });

    const migrated = migrateSpatialEditorStateToImageCoordinates(state, {
      containerWidth: 100,
      containerHeight: 200,
      imageAspectRatio: 1,
    });

    expect(migrated).toMatchObject({
      floorPlanImageAspectRatio: 1,
      floorPlanCoordinateMode: "image",
      roomRects: {
        study: { left: 20, top: 10, width: 20, height: 20, centerX: 30, centerY: 20 },
      },
      devicePlacements: {
        lamp: { placed: true, x: 30, y: 20, roomId: "study" },
      },
    });
  });

  it("keeps logical assets separate from physical switch controllers", () => {
    const hcmHome = createSwitchControlledHome();
    const sceneModel = createHouseSceneModel({ hcmHome });
    const model = createSpatialEditorModel({ hcmHome, sceneModel });

    expect(model.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "餐厅射灯",
          role: "logical_asset",
          assignedRoomId: "dining",
          providerThingId: "entry_switch_1",
          spatialStatus: SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED,
          placement: expect.objectContaining({ auto: true, placed: true }),
        }),
        expect.objectContaining({
          id: "entry_switch_1",
          name: "入户一号开关",
          role: "physical_controller",
          assignedRoomId: "entry",
          statusLabel: "2 通道",
        }),
      ]),
    );
    expect(model.groups[SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED].length).toBe(2);
  });

  it("moves a device through placement and assignment states without provider writes", () => {
    const sceneModel = {
      source: "test",
      rooms: [{ id: "study", name: "书房", x: 0, z: 0, width: 2, depth: 2 }],
      devices: [{ id: "desk_light", name: "台灯", type: "light", roomId: null }],
    };
    let state = createSpatialEditorState();

    let model = createSpatialEditorModel({ sceneModel, state });
    expect(model.devices[0].spatialStatus).toBe(SPATIAL_DEVICE_STATUS.UNORGANIZED);

    state = placeSpatialDevice(state, "desk_light", { x: 120, y: -5 });
    model = createSpatialEditorModel({ sceneModel, state });
    expect(model.devices[0]).toMatchObject({
      spatialStatus: SPATIAL_DEVICE_STATUS.PLACED_UNASSIGNED,
      placement: { placed: true, x: 100, y: 0, roomId: null },
    });

    state = assignSpatialDevice(state, "desk_light", "study");
    model = createSpatialEditorModel({ sceneModel, state });
    expect(model.devices[0]).toMatchObject({
      assignedRoomId: "study",
      spatialStatus: SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED,
      placement: { roomId: "study" },
    });

    state = clearSpatialPlacement(state, "desk_light");
    model = createSpatialEditorModel({ sceneModel, state });
    expect(model.devices[0]).toMatchObject({
      assignedRoomId: "study",
      spatialStatus: SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED,
    });
    expect(model.devices[0].placement?.auto).toBe(true);
  });

  it("uses edited room rectangles for placement suggestions and 3D projection", () => {
    const sceneModel = {
      source: "test",
      rooms: [
        { id: "study", name: "书房", x: 0, z: 0, width: 2, depth: 2 },
        { id: "living", name: "客厅", x: 4, z: 0, width: 2, depth: 2 },
      ],
      devices: [{ id: "desk_light", name: "台灯", type: "light", roomId: "study", sceneX: 0, sceneZ: 0 }],
    };
    const state = updateSpatialRoomRect(createSpatialEditorState(), "study", {
      left: 50,
      top: 25,
      width: 30,
      height: 20,
    });

    const model = createSpatialEditorModel({ sceneModel, state });
    const study = model.rooms.find((room) => room.id === "study");
    const device = model.devices.find((d) => d.id === "desk_light");
    const projected = applySpatialEditorToScene(sceneModel, model);

    expect(study).toMatchObject({
      mapRect: { left: 50, top: 25, width: 30, height: 20, centerX: 65, centerY: 35 },
      spatialSource: "editor",
    });
    expect(device.placement).toMatchObject({ auto: true, placed: true, x: 65, y: 35 });
    expect(projected.rooms.find((room) => room.id === "study")).toMatchObject({
      x: 2.9,
      z: -0.3,
      width: 1.8,
      depth: 0.4,
      spatialSource: "editor",
    });
  });

  it("adds custom rooms and can assign devices by point containment", () => {
    const sceneModel = {
      source: "test",
      rooms: [{ id: "living", name: "客厅", x: 0, z: 0, width: 4, depth: 3 }],
      devices: [{ id: "new_light", name: "新灯", type: "light", roomId: null }],
    };
    let state = addSpatialRoom(createSpatialEditorState(), {
      id: "tea_room",
      name: "茶室",
      mapRect: { left: 60, top: 20, width: 18, height: 16 },
    });
    let model = createSpatialEditorModel({ sceneModel, state });
    const room = findSpatialRoomAtPoint(model.rooms, 65, 25);

    expect(room).toMatchObject({ id: "tea_room", custom: true, editorName: "茶室" });

    state = placeSpatialDevice(state, "new_light", { x: 65, y: 25, roomId: room.id });
    model = createSpatialEditorModel({ sceneModel, state });
    const projected = applySpatialEditorToScene(sceneModel, model);

    expect(model.devices.find((device) => device.id === "new_light")).toMatchObject({
      assignedRoomId: "tea_room",
      spatialStatus: SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED,
    });
    expect(projected.rooms.find((item) => item.id === "tea_room")).toMatchObject({
      name: "茶室",
      spatialSource: "editor",
      deviceCount: 1,
    });

    state = removeSpatialRoom(state, "tea_room");
    model = createSpatialEditorModel({ sceneModel, state });
    expect(model.rooms.some((item) => item.id === "tea_room")).toBe(false);
    expect(model.devices.find((device) => device.id === "new_light")).toMatchObject({
      assignedRoomId: null,
      spatialStatus: SPATIAL_DEVICE_STATUS.PLACED_UNASSIGNED,
    });
  });

  it("applies custom room names and naming modes", () => {
    const sceneModel = {
      source: "test",
      rooms: [{ id: "dining", name: "餐厅", x: 0, z: 0, width: 2, depth: 2 }],
      devices: [{ id: "dining_spot", name: "餐厅射灯", type: "light", roomId: "dining" }],
    };
    let state = createSpatialEditorState({ namingMode: NAMING_MODES.ROOM_CUSTOM });
    state = updateSpatialRoomName(state, "dining", "餐区");
    state = updateSpatialDeviceName(state, "dining_spot", "射灯");

    const model = createSpatialEditorModel({ sceneModel, state });

    expect(model.rooms[0].editorName).toBe("餐区");
    expect(model.devices[0].displayName).toBe("餐区射灯");
  });

  it("auto-places assigned devices and supports suggestion dismissal", () => {
    const hcmHome = createSwitchControlledHome();
    const sceneModel = createHouseSceneModel({ hcmHome });
    let state = createSpatialEditorState();
    let model = createSpatialEditorModel({ hcmHome, sceneModel, state });

    // Auto-place: assigned devices are placed at room center automatically
    const asset = model.devices.find((d) => d.role === "logical_asset");
    expect(asset).toMatchObject({
      spatialStatus: SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED,
      placement: expect.objectContaining({ auto: true, placed: true }),
    });

    // Explicit placement overrides auto-place
    state = placeSpatialDevice(state, asset.id, { x: 80, y: 20, roomId: asset.assignedRoomId });
    model = createSpatialEditorModel({ hcmHome, sceneModel, state });
    const updated = model.devices.find((d) => d.id === asset.id);
    expect(updated.placement).toMatchObject({ placed: true, x: 80, y: 20 });
    expect(updated.placement?.auto).toBeFalsy();

    // Suggestions can be dismissed
    if (model.suggestions.length > 0) {
      const suggestionId = model.suggestions[0].id;
      state = dismissSpatialSuggestion(state, suggestionId);
      model = createSpatialEditorModel({ hcmHome, sceneModel, state });
      expect(model.suggestions.some((item) => item.id === suggestionId)).toBe(false);
    }
  });

  it("projects accepted spatial edits into the 3D scene without changing provider data", () => {
    const sceneModel = {
      source: "test",
      rooms: [
        { id: "study", name: "书房", x: 0, z: 0, width: 2, depth: 2 },
        { id: "living", name: "客厅", x: 4, z: 0, width: 2, depth: 2 },
      ],
      devices: [{ id: "desk_light", name: "台灯", type: "light", roomId: "study", sceneX: 0, sceneZ: 0 }],
    };
    let state = createSpatialEditorState({ namingMode: NAMING_MODES.ROOM_CUSTOM });
    state = updateSpatialRoomName(state, "living", "起居");
    state = updateSpatialDeviceName(state, "desk_light", "工作灯");
    state = placeSpatialDevice(state, "desk_light", { x: 100, y: 50, roomId: "living" });

    const spatialModel = createSpatialEditorModel({ sceneModel, state });
    const projected = applySpatialEditorToScene(sceneModel, spatialModel);

    expect(sceneModel.devices[0]).toMatchObject({ name: "台灯", roomId: "study", sceneX: 0 });
    expect(projected.rooms.find((room) => room.id === "living")).toMatchObject({
      name: "起居",
      deviceCount: 1,
      spatialSource: "editor",
    });
    expect(projected.devices[0]).toMatchObject({
      name: "起居工作灯",
      roomId: "living",
      sceneX: 5,
      sceneZ: 0,
      spatialSource: "editor",
    });
    expect(projected.spatialProjection).toMatchObject({ applied: true, placedDeviceCount: 1 });
  });

  it("suggests resolving room mismatches between map placement and assignment", () => {
    const sceneModel = {
      source: "test",
      rooms: [
        { id: "study", name: "书房", x: 0, z: 0, width: 2, depth: 2 },
        { id: "living", name: "客厅", x: 4, z: 0, width: 2, depth: 2 },
      ],
      devices: [{ id: "light", name: "灯", type: "light", roomId: "study" }],
    };
    const state = createSpatialEditorState({
      devicePlacements: { light: { placed: true, x: 80, y: 50, roomId: "living" } },
    });

    const model = createSpatialEditorModel({ sceneModel, state });
    const suggestion = model.suggestions.find((item) => item.type === "review_room_mismatch");

    expect(suggestion).toMatchObject({
      deviceId: "light",
      roomId: "living",
      title: "检查客厅归属",
    });
  });
});
