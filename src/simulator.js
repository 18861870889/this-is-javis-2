import {
  describeStep as describeSimulatorStep,
  executePlan as executeSimulatorPlan,
  tick as tickSimulatorDevices,
} from "./adapters/simulatorAdapter.js";
import { validatePlanDraft } from "./planValidator.js";

export const rooms = [
  {
    id: "entry",
    name: "玄关",
    type: "entry",
    x: -1.4,
    z: -3.2,
    width: 2.5,
    depth: 1.4,
    presence: true,
  },
  {
    id: "living",
    name: "客厅",
    type: "living",
    x: 1.4,
    z: -1.1,
    width: 4.4,
    depth: 3.1,
    presence: false,
  },
  {
    id: "dining",
    name: "餐厅",
    type: "dining",
    x: -1.6,
    z: -1.1,
    width: 2.1,
    depth: 2.4,
    presence: false,
  },
  {
    id: "kitchen",
    name: "厨房",
    type: "kitchen",
    x: -3.9,
    z: -0.6,
    width: 2.2,
    depth: 3.2,
    presence: true,
  },
  {
    id: "study",
    name: "书房",
    type: "study",
    x: 4.1,
    z: 1.6,
    width: 2.3,
    depth: 2.7,
    presence: true,
  },
  {
    id: "master",
    name: "主卧",
    type: "bedroom",
    x: 1.8,
    z: 2.2,
    width: 2.8,
    depth: 2.7,
    presence: false,
  },
  {
    id: "second",
    name: "次卧",
    type: "bedroom",
    x: -0.9,
    z: 2.35,
    width: 2.2,
    depth: 2.4,
    presence: false,
  },
  {
    id: "bath",
    name: "浴室",
    type: "bath",
    x: -4.15,
    z: -3.0,
    width: 1.7,
    depth: 1.7,
    presence: false,
  },
  {
    id: "balcony",
    name: "阳台",
    type: "balcony",
    x: -4.25,
    z: 1.95,
    width: 1.8,
    depth: 2.5,
    presence: false,
  },
];

export const roomAliases = {
  玄关: "entry",
  门口: "entry",
  客厅: "living",
  餐厅: "dining",
  厨房: "kitchen",
  书房: "study",
  主卧: "master",
  卧室: "master",
  次卧: "second",
  浴室: "bath",
  卫生间: "bath",
  阳台: "balcony",
};

export const deviceTypeNames = {
  light: "灯",
  switch: "开关",
  switch_panel: "开关面板",
  ac: "空调",
  fan: "风扇",
  curtain: "窗帘",
  tv: "电视",
  gas_heater: "燃气热水器",
  presence_sensor: "人在传感器",
  motion_sensor: "人体传感器",
  door_sensor: "门窗传感器",
  pet_feeder: "猫粮机",
  drying_rack: "晾衣杆",
  robot_vacuum: "扫地机器人",
  washer: "洗衣机",
  dryer: "烘干机",
  camera: "监控",
  hub: "网关",
  scale: "体脂秤",
  generic_sensor: "只读传感器",
  generic_entity: "只读实体",
};

const now = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

export const initialDevices = {
  entry_light: {
    id: "entry_light",
    name: "玄关灯",
    roomId: "entry",
    type: "light",
    risk: "low",
    on: true,
    brightness: 70,
  },
  entry_motion: {
    id: "entry_motion",
    name: "玄关人体传感器",
    roomId: "entry",
    type: "motion_sensor",
    risk: "sensitive",
    detected: true,
  },
  front_door: {
    id: "front_door",
    name: "入户门传感器",
    roomId: "entry",
    type: "door_sensor",
    risk: "sensitive",
    open: false,
  },
  living_light: {
    id: "living_light",
    name: "客厅主灯",
    roomId: "living",
    type: "light",
    risk: "low",
    on: true,
    brightness: 82,
  },
  living_tv: {
    id: "living_tv",
    name: "客厅电视",
    roomId: "living",
    type: "tv",
    risk: "low",
    on: false,
    channel: "HDMI 1",
  },
  living_curtain: {
    id: "living_curtain",
    name: "客厅窗帘",
    roomId: "living",
    type: "curtain",
    risk: "low",
    position: 78,
  },
  living_camera: {
    id: "living_camera",
    name: "客厅监控",
    roomId: "living",
    type: "camera",
    risk: "sensitive",
    on: true,
    privacyMode: false,
  },
  robot: {
    id: "robot",
    name: "扫地机器人",
    roomId: "living",
    type: "robot_vacuum",
    risk: "medium",
    status: "docked",
    battery: 86,
  },
  cat_feeder: {
    id: "cat_feeder",
    name: "猫粮机",
    roomId: "dining",
    type: "pet_feeder",
    risk: "medium",
    portionsToday: 1,
    lastFeed: "08:10",
  },
  kitchen_light: {
    id: "kitchen_light",
    name: "厨房灯",
    roomId: "kitchen",
    type: "light",
    risk: "low",
    on: true,
    brightness: 65,
  },
  kitchen_fan: {
    id: "kitchen_fan",
    name: "厨房风扇",
    roomId: "kitchen",
    type: "fan",
    risk: "low",
    on: false,
    speed: 0,
  },
  kitchen_presence: {
    id: "kitchen_presence",
    name: "厨房人在传感器",
    roomId: "kitchen",
    type: "presence_sensor",
    risk: "sensitive",
    detected: true,
  },
  study_light: {
    id: "study_light",
    name: "书房灯",
    roomId: "study",
    type: "light",
    risk: "low",
    on: true,
    brightness: 58,
  },
  study_ac: {
    id: "study_ac",
    name: "书房空调",
    roomId: "study",
    type: "ac",
    risk: "medium",
    on: true,
    temperature: 26,
    mode: "cool",
  },
  study_fan: {
    id: "study_fan",
    name: "书房风扇",
    roomId: "study",
    type: "fan",
    risk: "low",
    on: false,
    speed: 0,
  },
  study_presence: {
    id: "study_presence",
    name: "书房人在传感器",
    roomId: "study",
    type: "presence_sensor",
    risk: "sensitive",
    detected: true,
  },
  master_light: {
    id: "master_light",
    name: "主卧灯",
    roomId: "master",
    type: "light",
    risk: "low",
    on: false,
    brightness: 0,
  },
  master_ac: {
    id: "master_ac",
    name: "主卧空调",
    roomId: "master",
    type: "ac",
    risk: "medium",
    on: false,
    temperature: 25,
    mode: "cool",
  },
  master_curtain: {
    id: "master_curtain",
    name: "主卧窗帘",
    roomId: "master",
    type: "curtain",
    risk: "low",
    position: 55,
  },
  second_light: {
    id: "second_light",
    name: "次卧灯",
    roomId: "second",
    type: "light",
    risk: "low",
    on: false,
    brightness: 0,
  },
  second_ac: {
    id: "second_ac",
    name: "次卧空调",
    roomId: "second",
    type: "ac",
    risk: "medium",
    on: false,
    temperature: 25,
    mode: "cool",
  },
  bath_light: {
    id: "bath_light",
    name: "浴室灯",
    roomId: "bath",
    type: "light",
    risk: "low",
    on: false,
    brightness: 0,
  },
  gas_heater: {
    id: "gas_heater",
    name: "燃气热水器",
    roomId: "bath",
    type: "gas_heater",
    risk: "high",
    on: false,
    temperature: 42,
  },
  balcony_light: {
    id: "balcony_light",
    name: "阳台灯",
    roomId: "balcony",
    type: "light",
    risk: "low",
    on: false,
    brightness: 0,
  },
  drying_rack: {
    id: "drying_rack",
    name: "阳台晾衣杆",
    roomId: "balcony",
    type: "drying_rack",
    risk: "medium",
    position: 60,
    lightOn: false,
  },
  washer: {
    id: "washer",
    name: "洗衣机",
    roomId: "balcony",
    type: "washer",
    risk: "medium",
    status: "idle",
    minutesLeft: 0,
  },
  dryer: {
    id: "dryer",
    name: "烘干机",
    roomId: "balcony",
    type: "dryer",
    risk: "medium",
    status: "idle",
    minutesLeft: 0,
  },
};

export const examples = [
  "关客厅灯",
  "打开书房风扇",
  "书房空调调到25度",
  "我要睡了",
  "厨房有点闷",
  "准备看电影",
  "给猫加点粮",
  "扫地机扫客厅",
  "关主卧所有灯",
  "我要出门了",
];

export function getRoomName(roomId) {
  return rooms.find((room) => room.id === roomId)?.name ?? roomId;
}

export function createInitialLog() {
  return [
    {
      id: crypto.randomUUID(),
      time: now(),
      level: "info",
      text: "本地模拟器已启动，所有设备接口为内存模拟。",
    },
  ];
}

function normalize(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？,.!?]/g, "");
}

function detectRoom(text, fallbackRoomId = "study") {
  for (const [alias, roomId] of Object.entries(roomAliases)) {
    if (text.includes(alias)) return roomId;
  }
  return fallbackRoomId;
}

function roomHasPresence(roomId, devices) {
  return Object.values(devices).some(
    (device) =>
      device.roomId === roomId &&
      ["presence_sensor", "motion_sensor"].includes(device.type) &&
      device.detected,
  );
}

function findDevice(devices, roomId, type) {
  return Object.values(devices).find((device) => device.roomId === roomId && device.type === type);
}

function findDeviceByType(devices, type) {
  return Object.values(devices).find((device) => device.type === type);
}

function findDevices(devices, matcher) {
  return Object.values(devices).filter(matcher);
}

export function commandStep(device, capability, value, reason) {
  return {
    id: crypto.randomUUID(),
    deviceId: device.id,
    deviceName: device.name,
    roomId: device.roomId,
    capability,
    value,
    risk: device.risk,
    reason,
  };
}

export function createPlan({
  input,
  path,
  intent,
  confidence,
  steps,
  summary,
  devices,
  needsConfirmation = false,
}) {
  const validation = validatePlanDraft({ steps, devices, needsConfirmation, summary });
  return {
    id: crypto.randomUUID(),
    input,
    path,
    intent,
    confidence,
    steps: validation.steps,
    rejectedSteps: validation.rejectedSteps,
    validation,
    summary: validation.summary,
    needsConfirmation: validation.confirmationRequired,
    createdAt: now(),
  };
}

export function parseCommand(input, devices, context = {}) {
  const text = normalize(input);
  const currentRoomId = context.currentRoomId ?? inferCurrentRoom(devices);

  if (!text) {
    return {
      kind: "empty",
      message: "请输入一条家居控制指令。",
    };
  }

  const deviceStateQuery = parseDeviceStateQuery(input, text, devices, currentRoomId);
  if (deviceStateQuery) return deviceStateQuery;

  if (/状态|全屋|设备|现在/.test(text)) {
    return createPlan({
      input,
      path: "fast",
      intent: "query_home_state",
      confidence: 0.99,
      devices,
      steps: [],
      summary: summarizeHome(devices),
    });
  }

  if (/燃气|热水器/.test(text)) {
    const heater = devices.gas_heater;
    const wantsOn = /开|打开|启动|开启/.test(text);
    return createPlan({
      input,
      path: "fast",
      intent: "high_risk_control",
      confidence: 0.96,
      devices,
      needsConfirmation: true,
      steps: [
        commandStep(
          heater,
          wantsOn ? "turn_on" : "turn_off",
          wantsOn,
          "燃气设备属于高风险设备，必须确认后执行。",
        ),
      ],
      summary: wantsOn
        ? "燃气热水器属于高风险设备，需要确认后才能打开。"
        : "准备关闭燃气热水器，需要确认。",
    });
  }

  if (/睡|睡觉|晚安/.test(text)) {
    return buildSleepPlan(input, devices);
  }

  if (/电影|观影|看电视/.test(text)) {
    return buildMoviePlan(input, devices);
  }

  if (/出门|离家|不在家/.test(text)) {
    return buildAwayPlan(input, devices);
  }

  if (/厨房.*(闷|热|不舒服)|闷.*厨房/.test(text)) {
    return buildKitchenComfortPlan(input, devices);
  }

  if (/猫|猫粮|喂/.test(text)) {
    return buildPetFeedingPlan(input, devices);
  }

  const direct = parseDirectControl(input, text, devices, currentRoomId);
  if (direct) return direct;

  return buildSimulatedLlmPlan(input, devices, currentRoomId);
}

function parseDeviceStateQuery(input, text, devices, currentRoomId) {
  if (!/状态|目前|现在|当前|有没有|是否|在不在|开着|关着|几度|温度|亮度|电量|光照/.test(text)) return null;
  if (/全屋|所有|设备/.test(text)) return null;

  const explicitRoomId = detectExplicitRoom(text);
  const roomId = explicitRoomId ?? detectRoom(text, currentRoomId);
  const typeMatches = [
    ["motion_sensor", /人体|移动/],
    ["presence_sensor", /人在|有人|无人|存在/],
    ["door_sensor", /门窗|门磁|门/],
    ["light", /灯|照明/],
    ["ac", /空调|温度/],
    ["fan", /风扇/],
    ["curtain", /窗帘/],
    ["tv", /电视/],
    ["camera", /监控|摄像/],
  ];
  const matchedType = typeMatches.find(([, pattern]) => pattern.test(text))?.[0];
  if (!matchedType) return null;

  const device = findDevice(devices, roomId, matchedType);
  if (!device) {
    return createPlan({
      input,
      path: "fast",
      intent: "query_device_state",
      confidence: 0.9,
      devices,
      steps: [],
      summary: `${getRoomName(roomId)}没有找到${deviceTypeNames[matchedType]}。`,
    });
  }

  return createPlan({
    input,
    path: "fast",
    intent: "query_device_state",
    confidence: 0.98,
    devices,
    steps: [],
    summary: `${device.name}：${deviceStateLabel(device)}。`,
  });
}

function parseDirectControl(input, text, devices, currentRoomId) {
  const explicitRoomId = detectExplicitRoom(text);
  const roomId = explicitRoomId ?? detectRoom(text, currentRoomId);
  const wantsOff = /关闭|关掉|关/.test(text);
  const wantsOn = /打开|开启|启动|开/.test(text) && !wantsOff;
  const temperature = text.match(/(\d{2})度?/);

  const typeMatches = [
    ["light", /灯|照明/],
    ["fan", /风扇/],
    ["ac", /空调/],
    ["curtain", /窗帘/],
    ["tv", /电视/],
    ["drying_rack", /晾衣|衣杆/],
    ["robot_vacuum", /扫地|机器人/],
    ["washer", /洗衣机/],
    ["dryer", /烘干机/],
  ];

  const matchedType = typeMatches.find(([, pattern]) => pattern.test(text))?.[0];
  if (!matchedType) return null;

  const device = findDevice(devices, roomId, matchedType) ?? findDefaultDevice(devices, matchedType, explicitRoomId);
  if (!device) {
    return createPlan({
      input,
      path: "fast",
      intent: "device_not_found",
      confidence: 0.92,
      devices,
      steps: [],
      summary: `${getRoomName(roomId)}没有找到${deviceTypeNames[matchedType]}。`,
    });
  }

  if (matchedType === "drying_rack") {
    const value = /收起|升起|上升|关闭|关掉|关/.test(text) ? 0 : 100;
    return createPlan({
      input,
      path: "fast",
      intent: "dry_laundry",
      confidence: explicitRoomId ? 0.98 : 0.91,
      devices,
      steps: [commandStep(device, "set_position", value, `将${device.name}${value > 0 ? "降到晾晒位" : "收起"}。`)],
      summary: `${device.name}将${value > 0 ? "降到晾晒位" : "收起"}。`,
    });
  }

  if (matchedType === "ac" && temperature) {
    const temp = Number(temperature[1]);
    return createPlan({
      input,
      path: "fast",
      intent: "set_temperature",
      confidence: 0.98,
      devices,
      steps: [
        commandStep(device, "turn_on", true, "调温前先确保空调开启。"),
        commandStep(device, "set_temperature", temp, `将${device.name}设置为 ${temp} 度。`),
      ],
      summary: `${device.name}将设置为 ${temp} 度。`,
    });
  }

  if (matchedType === "curtain") {
    const value = /半|一点|留缝/.test(text) ? 25 : wantsOn ? 100 : 0;
    return createPlan({
      input,
      path: "fast",
      intent: "set_cover",
      confidence: 0.96,
      devices,
      steps: [commandStep(device, "set_position", value, `设置${device.name}开合到 ${value}%。`)],
      summary: `${device.name}将调整到 ${value}%。`,
    });
  }

  if (matchedType === "robot_vacuum") {
    return createPlan({
      input,
      path: "fast",
      intent: "robot_control",
      confidence: 0.94,
      devices,
      steps: [
        commandStep(
          device,
          wantsOff ? "dock_robot" : "start_robot",
          !wantsOff,
          wantsOff ? "让扫地机器人回充。" : "启动扫地机器人。",
        ),
      ],
      summary: wantsOff ? "扫地机器人将回充。" : "扫地机器人将开始清扫。",
    });
  }

  if (matchedType === "washer" || matchedType === "dryer") {
    return createPlan({
      input,
      path: "fast",
      intent: "appliance_control",
      confidence: 0.9,
      devices,
      needsConfirmation: true,
      steps: [
        commandStep(
          device,
          wantsOff ? "stop_cycle" : "start_cycle",
          !wantsOff,
          `${device.name}属于中风险家电，启动/停止需要确认。`,
        ),
      ],
      summary: `${device.name}操作需要确认。`,
    });
  }

  const action = wantsOff ? "turn_off" : wantsOn ? "turn_on" : null;
  if (!action) return null;

  return createPlan({
    input,
    path: "fast",
    intent: "control_device",
    confidence: 0.97,
    devices,
    steps: [
      commandStep(
        device,
        action,
        action === "turn_on",
        `${action === "turn_on" ? "打开" : "关闭"}${device.name}。`,
      ),
    ],
    summary: `${device.name}将${action === "turn_on" ? "打开" : "关闭"}。`,
  });
}

function detectExplicitRoom(text) {
  for (const [alias, roomId] of Object.entries(roomAliases)) {
    if (text.includes(alias)) return roomId;
  }
  return null;
}

function findDefaultDevice(devices, type, explicitRoomId) {
  if (explicitRoomId) return null;
  if (type === "drying_rack") return devices.drying_rack;
  if (type === "washer") return devices.washer;
  if (type === "dryer") return devices.dryer;
  if (type === "robot_vacuum") return devices.robot;
  return findDeviceByType(devices, type);
}

function buildSleepPlan(input, devices) {
  const steps = [];
  for (const device of findDevices(
    devices,
    (item) => item.type === "light" && !["master_light"].includes(item.id),
  )) {
    steps.push(commandStep(device, "turn_off", false, "睡眠场景关闭非必要灯光。"));
  }
  steps.push(commandStep(devices.living_tv, "turn_off", false, "睡眠场景关闭客厅电视。"));
  steps.push(commandStep(devices.master_light, "set_brightness", 18, "主卧保留低亮度。"));
  steps.push(commandStep(devices.master_ac, "turn_on", true, "睡眠场景开启主卧空调。"));
  steps.push(commandStep(devices.master_ac, "set_temperature", 25, "使用睡眠默认温度 25 度。"));
  steps.push(commandStep(devices.master_curtain, "set_position", 20, "睡觉时窗帘留 20%。"));

  return createPlan({
    input,
    path: "llm-sim",
    intent: "scene_sleep",
    confidence: 0.91,
    devices,
    steps,
    summary: "已生成睡眠场景：关闭公共区域设备，主卧灯光调暗，空调 25 度，窗帘留 20%。",
  });
}

function buildMoviePlan(input, devices) {
  return createPlan({
    input,
    path: "llm-sim",
    intent: "scene_movie",
    confidence: 0.94,
    devices,
    steps: [
      commandStep(devices.living_tv, "turn_on", true, "观影场景打开电视。"),
      commandStep(devices.living_light, "set_brightness", 22, "观影场景降低客厅亮度。"),
      commandStep(devices.living_curtain, "set_position", 0, "观影场景关闭客厅窗帘。"),
    ],
    summary: "客厅将进入观影状态：电视打开，灯光调暗，窗帘关闭。",
  });
}

function buildAwayPlan(input, devices) {
  const steps = [];
  for (const device of Object.values(devices)) {
    if (["light", "fan", "tv"].includes(device.type)) {
      steps.push(commandStep(device, "turn_off", false, "离家场景关闭低风险用电设备。"));
    }
  }
  steps.push(commandStep(devices.robot, "dock_robot", false, "离家前让扫地机器人回充待命。"));

  return createPlan({
    input,
    path: "llm-sim",
    intent: "scene_away",
    confidence: 0.9,
    devices,
    steps,
    summary: "已生成离家场景：关闭灯光、风扇、电视，并检查门窗状态。",
  });
}

function buildKitchenComfortPlan(input, devices) {
  const steps = [];
  const occupied = roomHasPresence("kitchen", devices);
  steps.push(commandStep(devices.kitchen_fan, "turn_on", true, "厨房有人且用户反馈闷，打开厨房风扇。"));
  steps.push(commandStep(devices.kitchen_fan, "set_speed", 2, "厨房风扇设置为 2 档。"));
  if (!devices.kitchen_light.on) {
    steps.push(commandStep(devices.kitchen_light, "set_brightness", 55, "厨房有人，补充基础照明。"));
  }

  return createPlan({
    input,
    path: "llm-sim",
    intent: "comfort_kitchen",
    confidence: occupied ? 0.88 : 0.68,
    devices,
    steps,
    summary: occupied
      ? "检测到厨房有人，准备打开厨房风扇并保持基础照明。"
      : "没有检测到厨房有人，但可先打开厨房风扇。",
  });
}

function buildPetFeedingPlan(input, devices) {
  const feeder = devices.cat_feeder;
  const tooMuch = feeder.portionsToday >= 2;
  return createPlan({
    input,
    path: "fast",
    intent: "feed_pet",
    confidence: 0.96,
    devices,
    needsConfirmation: tooMuch,
    steps: [
      commandStep(
        feeder,
        "dispense_food",
        1,
        tooMuch ? "今日投喂次数已达到建议上限，需要确认。" : "投喂一份猫粮。",
      ),
    ],
    summary: tooMuch ? "今天已投喂 2 次，继续投喂需要确认。" : "猫粮机将投喂 1 份。",
  });
}

function buildSimulatedLlmPlan(input, devices, currentRoomId) {
  const light = findDevice(devices, currentRoomId, "light");
  const text = normalize(input);

  if (/亮|太亮|刺眼/.test(text) && light) {
    return createPlan({
      input,
      path: "llm-sim",
      intent: "dim_current_room",
      confidence: 0.76,
      devices,
      steps: [
        commandStep(
          light,
          "set_brightness",
          32,
          `根据最近人在位置推断当前区域为${getRoomName(currentRoomId)}。`,
        ),
      ],
      summary: `我理解为${getRoomName(currentRoomId)}太亮，将灯光调到 32%。`,
    });
  }

  if (/冷|热/.test(text)) {
    const ac = findDevice(devices, currentRoomId, "ac") ?? devices.study_ac;
    const current = ac.temperature ?? 25;
    const target = /冷/.test(text) ? current + 2 : current - 2;
    return createPlan({
      input,
      path: "llm-sim",
      intent: "adjust_climate",
      confidence: 0.72,
      devices,
      needsConfirmation: true,
      steps: [
        commandStep(ac, "turn_on", true, "根据温感反馈，先确保空调开启。"),
        commandStep(ac, "set_temperature", target, `将${ac.name}调整到 ${target} 度。`),
      ],
      summary: `我理解为${getRoomName(ac.roomId)}体感不适，建议将${ac.name}调到 ${target} 度。`,
    });
  }

  return createPlan({
    input,
    path: "llm-sim",
    intent: "needs_clarification",
    confidence: 0.45,
    devices,
    steps: [],
    summary: "我还不能稳定理解这条指令。你可以试试“关客厅灯”“我要睡了”“厨房有点闷”。",
  });
}

export function executePlan(plan, devices) {
  return executeSimulatorPlan(plan, devices);
}

export function describeStep(step) {
  return describeSimulatorStep(step);
}

export function summarizeHome(devices) {
  const lightsOn = Object.values(devices).filter((item) => item.type === "light" && item.on).length;
  const acOn = Object.values(devices).filter((item) => item.type === "ac" && item.on).length;
  const fansOn = Object.values(devices).filter((item) => item.type === "fan" && item.on).length;
  const sensors = Object.values(devices).filter(
    (item) => ["presence_sensor", "motion_sensor"].includes(item.type) && item.detected,
  );
  const doorOpen = devices.front_door.open ? "打开" : "关闭";
  return `当前 ${lightsOn} 盏灯开启，${acOn} 台空调开启，${fansOn} 台风扇开启；人在区域：${
    sensors.map((item) => getRoomName(item.roomId)).join("、") || "未检测到"
  }；入户门${doorOpen}。`;
}

function deviceStateLabel(device) {
  if (device.type === "motion_sensor" || device.type === "presence_sensor") {
    return device.detected ? "检测到有人" : "未检测到有人";
  }
  if (device.type === "door_sensor") return device.open ? "开启" : "关闭";
  if (device.type === "light") return device.on ? `开启，亮度 ${device.brightness}%` : "关闭";
  if (device.type === "ac") return device.on ? `开启，${device.temperature}°C` : "关闭";
  if (device.type === "fan") return device.on ? `开启，${device.speed || 1}档` : "关闭";
  if (device.type === "curtain") return `${device.position}%`;
  if (device.type === "tv") return device.on ? "开启" : "关闭";
  if (device.type === "camera") return device.privacyMode ? "隐私模式" : device.on ? "开启" : "关闭";
  return "待机";
}

export function inferCurrentRoom(devices) {
  const priority = ["study", "kitchen", "entry", "living", "master", "second"];
  for (const roomId of priority) {
    if (roomHasPresence(roomId, devices)) return roomId;
  }
  return "living";
}

export function toggleSensor(devices, sensorId) {
  const next = structuredClone(devices);
  if (next[sensorId]) {
    if ("detected" in next[sensorId]) next[sensorId].detected = !next[sensorId].detected;
    if ("open" in next[sensorId]) next[sensorId].open = !next[sensorId].open;
  }
  return next;
}

export function tickDevices(devices) {
  return tickSimulatorDevices(devices);
}
