import { createHcmHome } from "./hcm.js";

export function createHarnessScenarioHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [
      { id: "entry", name: "玄关", aliases: ["入户", "门口"] },
      { id: "living", name: "客厅" },
      { id: "study", name: "书房" },
      { id: "kitchen", name: "厨房" },
      { id: "balcony", name: "阳台" },
      { id: "master", name: "主卧" },
      { id: "cat_room", name: "猫猫房" },
    ],
    things: [
      {
        id: "entry_motion",
        name: "入户传感器",
        type: "motion_sensor",
        spaceId: "entry",
        capabilities: [
          sensorCapability({
            id: "motion_event",
            name: "移动检测传感器 检测到移动",
            valueType: "event",
            state: "2026-06-15T14:02:03.646+00:00",
            domain: "event",
            entityId: "event.entry_motion_detected",
            risk: "sensitive",
          }),
          sensorCapability({
            id: "no_motion",
            name: "移动检测传感器 无移动状态持续时间",
            state: "5 Minutes",
            entityId: "sensor.entry_no_motion_duration",
          }),
          sensorCapability({
            id: "battery",
            name: "充电电池 电池电量",
            valueType: "number",
            state: 80,
            unit: "%",
            entityId: "sensor.entry_motion_battery",
          }),
        ],
      },
      {
        id: "study_presence",
        name: "书房人在传感器",
        type: "presence_sensor",
        spaceId: "study",
        capabilities: [
          sensorCapability({
            id: "occupancy",
            name: "书房人在传感器 有人无人状态",
            valueType: "boolean",
            state: true,
            domain: "binary_sensor",
            entityId: "binary_sensor.study_occupancy",
            risk: "sensitive",
          }),
        ],
      },
      {
        id: "balcony_drying_rack",
        name: "阳台晾衣杆",
        type: "drying_rack",
        spaceId: "balcony",
        aliases: ["晾衣杆", "晾衣服", "晒衣服"],
        capabilities: [
          controlCapability({
            id: "drying_rack_position",
            name: "晾衣杆升降",
            valueType: "number",
            domain: "cover",
            entityId: "cover.balcony_drying_rack",
          }),
        ],
      },
      {
        id: "living_light",
        name: "客厅灯",
        type: "switch_panel",
        spaceId: "living",
        capabilities: [
          controlCapability({
            id: "living_light_switch",
            name: "客厅灯开关",
            valueType: "boolean",
            domain: "switch",
            entityId: "switch.living_light",
          }),
          controlCapability({
            id: "living_light_brightness",
            name: "客厅灯亮度",
            valueType: "number",
            domain: "light",
            entityId: "light.living_light",
          }),
          configCapability({
            id: "living_light_binding",
            name: "互控配置",
            domain: "text",
            entityId: "text.living_light_binding",
          }),
        ],
      },
      {
        id: "living_curtain",
        name: "客厅窗帘",
        type: "curtain",
        spaceId: "living",
        capabilities: [
          controlCapability({
            id: "curtain_position",
            name: "窗帘位置",
            valueType: "number",
            domain: "cover",
            entityId: "cover.living_curtain",
          }),
        ],
      },
      {
        id: "living_tv",
        name: "客厅电视",
        type: "tv",
        spaceId: "living",
        capabilities: [
          controlCapability({
            id: "tv_power",
            name: "电视电源",
            valueType: "boolean",
            domain: "media_player",
            entityId: "media_player.living_tv",
          }),
        ],
      },
      {
        id: "xiaoai_speaker",
        name: "小爱音箱Pro",
        type: "tv",
        spaceId: "living",
        aliases: ["小爱音箱", "音箱", "音乐"],
        capabilities: [
          controlCapability({
            id: "speaker_playback",
            name: "音箱",
            valueType: "boolean",
            domain: "media_player",
            entityId: "media_player.xiaoai",
          }),
        ],
      },
      {
        id: "master_ac",
        name: "主卧空调",
        type: "ac",
        spaceId: "master",
        capabilities: [
          controlCapability({
            id: "set_temperature",
            name: "设置温度",
            valueType: "number",
            domain: "climate",
            entityId: "climate.master_ac",
          }),
        ],
      },
      {
        id: "living_fan",
        name: "客厅风扇",
        type: "fan",
        spaceId: "living",
        capabilities: [
          controlCapability({
            id: "fan_percentage",
            name: "风扇风量",
            valueType: "number",
            domain: "fan",
            entityId: "fan.living_fan",
          }),
        ],
      },
      {
        id: "cat_camera",
        name: "猫猫监控",
        type: "camera",
        spaceId: "cat_room",
        capabilities: [
          actionCapability({
            id: "camera_snapshot",
            name: "监控截图",
            valueType: "event",
            domain: "button",
            entityId: "button.cat_camera_snapshot",
            risk: "sensitive",
            confirmation: "always",
            autoExecutable: false,
          }),
        ],
      },
      {
        id: "gas_water_heater",
        name: "燃气热水器",
        type: "water_heater",
        spaceId: "kitchen",
        capabilities: [
          controlCapability({
            id: "heater_power",
            name: "热水器电源",
            valueType: "boolean",
            domain: "switch",
            entityId: "switch.gas_water_heater",
            risk: "high",
            confirmation: "always",
            autoExecutable: false,
          }),
        ],
      },
    ],
  });
}

function controlCapability({
  id,
  name,
  valueType,
  domain,
  entityId,
  risk = "low",
  confirmation = "never",
  autoExecutable = true,
}) {
  return {
    id,
    name,
    kind: "control",
    valueType,
    policy: { risk, confirmation, autoExecutable },
    binding: { provider: "home_assistant", domain, entityId },
  };
}

function actionCapability({
  id,
  name,
  valueType,
  domain,
  entityId,
  risk = "low",
  confirmation = "never",
  autoExecutable = true,
}) {
  return {
    id,
    name,
    kind: "action",
    valueType,
    policy: { risk, confirmation, autoExecutable },
    binding: { provider: "home_assistant", domain, entityId },
  };
}

function sensorCapability({
  id,
  name,
  valueType = "unknown",
  state,
  unit,
  domain = "sensor",
  entityId,
  risk = "low",
}) {
  return {
    id,
    name,
    kind: "sensor",
    valueType,
    state,
    unit,
    policy: { risk, confirmation: risk === "low" ? "never" : "always", autoExecutable: false },
    binding: { provider: "home_assistant", domain, entityId },
  };
}

function configCapability({ id, name, domain, entityId }) {
  return {
    id,
    name,
    kind: "config",
    valueType: "text",
    policy: { risk: "high", confirmation: "always", autoExecutable: false },
    binding: { provider: "home_assistant", domain, entityId },
  };
}
