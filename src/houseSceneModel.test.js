import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { attachHcmControlGraph } from "./hcmControlGraph.js";
import { createHouseSceneModel, getSceneRoomName } from "./houseSceneModel.js";

describe("house scene model", () => {
  it("builds room and device points from HCM spaces and things", () => {
    const home = createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [
        { id: "living", name: "客厅" },
        { id: "cat_room", name: "猫猫房" },
        { id: "master_bath", name: "主卧卫生间" },
      ],
      things: [
        {
          id: "ha_tv",
          name: "电视",
          type: "tv",
          spaceId: "living",
          online: true,
          policy: { risk: "low", confirmation: "never", autoExecutable: true },
          capabilities: [],
          state: { autoExecutable: 3, controllable: 3, readable: 0 },
        },
        {
          id: "ha_feeder",
          name: "猫粮机",
          type: "pet_feeder",
          spaceId: "cat_room",
          online: true,
          policy: { risk: "medium", confirmation: "always", autoExecutable: false },
          capabilities: [],
          state: { autoExecutable: 0, controllable: 2, readable: 5 },
        },
        {
          id: "ha_master_bath_switch",
          name: "主卫开关",
          type: "switch_panel",
          spaceId: "master_bath",
          online: true,
          policy: { risk: "low", confirmation: "never", autoExecutable: true },
          capabilities: [],
          state: { autoExecutable: 2, controllable: 4, readable: 0 },
        },
      ],
    });

    const model = createHouseSceneModel({ hcmHome: home });

    expect(model.source).toBe("hcm");
    expect(model.rooms.map((room) => room.id)).toEqual(["living", "cat_room", "master_bath"]);
    expect(getSceneRoomName("cat_room", model.rooms)).toBe("猫猫房");
    expect(model.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ha_feeder",
          roomId: "cat_room",
          statusLabel: "只读 5 项",
          source: "hcm",
        }),
        expect.objectContaining({
          id: "ha_master_bath_switch",
          roomId: "master_bath",
          statusLabel: "自动 2/4",
        }),
      ]),
    );
    expect(model.devices.every((device) => typeof device.sceneX === "number" && typeof device.sceneZ === "number")).toBe(true);
  });

  it("falls back to simulator rooms and devices when HCM is unavailable", () => {
    const model = createHouseSceneModel({
      simulatorRooms: [{ id: "study", name: "书房", x: 0, z: 0, width: 1, depth: 1 }],
      simulatorDevices: {
        light: { id: "light", name: "书房灯", roomId: "study", type: "light" },
      },
    });

    expect(model).toMatchObject({
      source: "simulator",
      rooms: [expect.objectContaining({ id: "study" })],
      devices: [expect.objectContaining({ id: "light" })],
    });
  });

  it("projects HCM sensor readings into the scene model", () => {
    const home = createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [
        { id: "entry", name: "玄关" },
        { id: "study", name: "书房" },
      ],
      things: [
        {
          id: "study_presence",
          name: "书房人在传感器",
          type: "presence_sensor",
          spaceId: "study",
          online: true,
          capabilities: [
            {
              id: "occupancy",
              name: "有人无人状态",
              kind: "sensor",
              valueType: "boolean",
              state: false,
              binding: { domain: "binary_sensor", currentState: "off" },
            },
            {
              id: "no_one_duration",
              name: "无人持续时长",
              kind: "sensor",
              state: "30分钟持续无人",
            },
          ],
          state: { autoExecutable: 0, controllable: 0, readable: 2 },
        },
        {
          id: "front_door",
          name: "大门守卫",
          type: "door_sensor",
          spaceId: "entry",
          online: true,
          capabilities: [
            {
              id: "contact",
              name: "门窗传感器 接触状态",
              kind: "sensor",
              valueType: "boolean",
              state: false,
              binding: { domain: "binary_sensor", currentState: "off" },
            },
          ],
          state: { autoExecutable: 0, controllable: 0, readable: 1 },
        },
      ],
    });

    const model = createHouseSceneModel({ hcmHome: home });

    expect(model.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "study_presence",
          detected: false,
          statusLabel: "无人 · 30分钟持续无人",
        }),
        expect.objectContaining({
          id: "front_door",
          open: false,
          statusLabel: "关闭",
        }),
      ]),
    );
  });

  it("projects HCM robot vacuum state instead of falling back to simulator defaults", () => {
    const home = createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "living", name: "客厅" }],
      things: [
        {
          id: "living_robot",
          name: "扫地机器人",
          type: "robot_vacuum",
          spaceId: "living",
          online: true,
          capabilities: [
            {
              id: "vacuum_state",
              name: "扫地机器人",
              kind: "control",
              valueType: "unknown",
              state: "cleaning",
              binding: { domain: "vacuum", entityId: "vacuum.living_robot", currentState: "cleaning" },
              policy: { risk: "medium", confirmation: "always", autoExecutable: false },
            },
            {
              id: "battery",
              name: "电池电量",
              kind: "sensor",
              valueType: "number",
              state: 42,
              unit: "%",
              binding: { domain: "sensor", entityId: "sensor.living_robot_battery", currentState: "42" },
              policy: { risk: "low", confirmation: "never", autoExecutable: false },
            },
          ],
          state: { autoExecutable: 0, controllable: 1, readable: 1 },
        },
      ],
    });

    const model = createHouseSceneModel({ hcmHome: home });

    expect(model.devices).toContainEqual(
      expect.objectContaining({
        id: "living_robot",
        type: "robot_vacuum",
        status: "cleaning",
        battery: 42,
        statusLabel: "清扫中 · 42%",
      }),
    );
  });

  it("shows logical lights in their semantic room instead of the physical switch panel", () => {
    const home = attachHcmControlGraph(createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [
        { id: "entry", name: "入户" },
        { id: "dining", name: "餐厅" },
      ],
      things: [
        {
          id: "entry_panel",
          name: "入户1号开关",
          type: "switch_panel",
          spaceId: "dining",
          online: true,
          capabilities: [
            {
              id: "dining_spot",
              name: "餐厅射灯 开关左键",
              kind: "control",
              valueType: "boolean",
              state: true,
              policy: { risk: "low", confirmation: "never", autoExecutable: true },
              binding: {
                provider: "home_assistant",
                domain: "switch",
                entityId: "switch.entry_panel_on_p_2_1",
              },
            },
          ],
        },
      ],
    }));

    const model = createHouseSceneModel({ hcmHome: home });

    expect(model.devices).toContainEqual(
      expect.objectContaining({
        id: "asset_dining_餐厅射灯",
        name: "餐厅射灯",
        roomId: "dining",
        logicalAsset: true,
        providerThingId: "entry_panel",
        statusLabel: "回路开启",
      }),
    );
    expect(model.devices.some((device) => device.id === "entry_panel")).toBe(false);
  });
});
