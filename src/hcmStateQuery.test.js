import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { attachHcmControlGraph } from "./hcmControlGraph.js";
import {
  answerHcmOccupancyStateQuery,
  answerHcmRoomLightStateQuery,
  answerHcmStateQuery,
  looksLikeStateQuery,
} from "./hcmStateQuery.js";

function createStateHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [
      { id: "entry", name: "入户" },
      { id: "living", name: "客厅" },
    ],
    things: [
      {
        id: "ha_entry_motion",
        name: "入户传感器",
        type: "motion_sensor",
        spaceId: "living",
        online: true,
        policy: { risk: "sensitive", confirmation: "always", autoExecutable: false },
        state: { readable: 4, autoExecutable: 0 },
        capabilities: [
          {
            id: "motion",
            name: "移动检测传感器 检测到移动",
            kind: "sensor",
            valueType: "event",
            state: "2026-06-14T13:08:14.678+00:00",
            binding: { entityId: "event.motion_detected", domain: "event" },
          },
          {
            id: "no_motion",
            name: "移动检测传感器 无移动状态持续时间",
            kind: "sensor",
            valueType: "unknown",
            state: "5 Minutes",
            binding: { entityId: "sensor.no_motion_duration", domain: "sensor" },
          },
          {
            id: "battery",
            name: "充电电池 电池电量",
            kind: "sensor",
            valueType: "unknown",
            state: 80,
            binding: { entityId: "sensor.battery", domain: "sensor" },
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

function createStudyLightHome() {
  return attachHcmControlGraph(createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [{ id: "study", name: "书房" }],
    things: [
      {
        id: "study_panel",
        name: "书房开关",
        type: "switch_panel",
        spaceId: "study",
        capabilities: [
          control("study_spot", "书房射灯 开关中键", "switch.study_spot", true),
          control("study_ceiling", "书房吊灯 开关左键", "switch.study_ceiling", false),
        ],
      },
    ],
  }));
}

function createOccupancyHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [{ id: "kitchen", name: "厨房" }],
    things: [
      {
        id: "kitchen_presence",
        name: "小米人在传感器-厨房",
        type: "presence_sensor",
        spaceId: "kitchen",
        capabilities: [
          {
            id: "occupancy",
            name: "存在传感器 有人无人状态",
            kind: "sensor",
            valueType: "boolean",
            state: false,
            binding: { entityId: "binary_sensor.kitchen_occupancy", domain: "binary_sensor" },
          },
          {
            id: "illuminance",
            name: "存在传感器 光照度",
            kind: "sensor",
            valueType: "number",
            state: 43,
            binding: { entityId: "sensor.kitchen_illuminance", domain: "sensor" },
          },
          {
            id: "no_one_duration",
            name: "存在传感器 无人持续时长",
            kind: "sensor",
            valueType: "unknown",
            state: "10 Minutes",
            binding: { entityId: "sensor.kitchen_no_one_duration", domain: "sensor" },
          },
        ],
      },
    ],
  });
}

describe("HCM state query", () => {
  it("recognizes read-only state questions", () => {
    expect(looksLikeStateQuery("玄关人体目前是什么状态")).toBe(true);
    expect(looksLikeStateQuery("厨房有人不")).toBe(true);
    expect(looksLikeStateQuery("打开玄关灯")).toBe(false);
  });

  it("answers room occupancy questions from presence sensors", () => {
    const answer = answerHcmOccupancyStateQuery("厨房有人不", createOccupancyHome(), "查询厨房人在状态");

    expect(answer).toMatchObject({
      path: "hcm-occupancy-state",
      thingId: "kitchen_presence",
      thingName: "小米人在传感器-厨房",
      roomId: "kitchen",
      state: false,
      available: true,
    });
    expect(answer.summary).toBe("厨房无人。数据来自小米人在传感器-厨房。");
  });

  it("does not mix stale no-one duration into an occupied presence answer", () => {
    const home = createOccupancyHome();
    home.things[0].capabilities.find((capability) => capability.id === "occupancy").state = true;
    const answer = answerHcmStateQuery("厨房有人不", home, "查询厨房人在状态");

    expect(answer.summary).toContain("有人");
    expect(answer.summary).not.toContain("无人持续");
  });

  it("answers a specific entry motion sensor instead of a whole-home summary", () => {
    const answer = answerHcmStateQuery("玄关人体目前是什么状态", createStateHome());

    expect(answer).toMatchObject({
      path: "hcm-state",
      thingId: "ha_entry_motion",
      thingName: "入户传感器",
    });
    expect(answer.summary).toContain("入户传感器");
    expect(answer.summary).toContain("玄关的入户传感器");
    expect(answer.summary).toContain("无移动持续 5 分钟");
    expect(answer.summary).toContain("电量 80%");
  });

  it("answers room-level light state questions as an aggregate", () => {
    const answer = answerHcmRoomLightStateQuery("书房灯开着吗", createStudyLightHome(), "查询书房灯光");

    expect(answer).toMatchObject({
      path: "hcm-room-light-state",
      thingId: null,
      thingName: "书房灯光",
      roomId: "study",
    });
    expect(answer.summary).toContain("书房射灯开");
    expect(answer.summary).toContain("书房吊灯关");
  });
});
