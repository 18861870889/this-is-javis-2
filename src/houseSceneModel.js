const ROOM_LAYOUTS = {
  entry: { x: -3.75, z: -3.05, width: 1.9, depth: 1.35, type: "entry" },
  living: { x: 0.7, z: -1.25, width: 4.65, depth: 3.15, type: "living" },
  dining: { x: -2.05, z: -1.2, width: 2.15, depth: 2.45, type: "dining" },
  kitchen: { x: -4.15, z: -0.85, width: 1.95, depth: 2.55, type: "kitchen" },
  bath: { x: -4.15, z: -3.35, width: 1.65, depth: 1.55, type: "bath" },
  balcony: { x: -4.1, z: 1.75, width: 1.85, depth: 3.05, type: "balcony" },
  cat_room: { x: -2.3, z: 2.45, width: 2.65, depth: 2.25, type: "bedroom" },
  second: { x: 0.35, z: 2.55, width: 2.25, depth: 2.25, type: "bedroom" },
  master: { x: 2.8, z: 2.35, width: 2.95, depth: 2.55, type: "bedroom" },
  master_bath: { x: 4.65, z: 0.75, width: 1.45, depth: 1.65, type: "bath" },
  study: { x: 4.45, z: -1.35, width: 2.0, depth: 2.45, type: "study" },
  unknown: { x: 0, z: 4.8, width: 2.4, depth: 1.6, type: "generic" },
};

const ROOM_TYPE_BY_ID = {
  entry: "entry",
  living: "living",
  dining: "dining",
  kitchen: "kitchen",
  study: "study",
  master: "bedroom",
  second: "bedroom",
  cat_room: "bedroom",
  bath: "bath",
  master_bath: "bath",
  balcony: "balcony",
};

const DEVICE_TYPE_PRIORITY = {
  switch_panel: 10,
  light: 11,
  curtain: 20,
  ac: 30,
  fan: 31,
  tv: 40,
  media_player: 41,
  camera: 50,
  motion_sensor: 60,
  presence_sensor: 61,
  door_sensor: 62,
  pet_feeder: 70,
  robot_vacuum: 71,
  washer: 72,
  dryer: 73,
  drying_rack: 74,
  hub: 80,
  scale: 81,
};

export function createHouseSceneModel({ hcmHome, simulatorRooms = [], simulatorDevices = {} } = {}) {
  if (hcmHome?.things?.length > 0) {
    const rooms = createRoomsFromHcm(hcmHome);
    const devices = createDevicesFromHcm(hcmHome, rooms);
    return {
      source: "hcm",
      rooms,
      devices,
    };
  }

  return {
    source: "simulator",
    rooms: simulatorRooms,
    devices: Object.values(simulatorDevices),
  };
}

export function getSceneRoomName(roomId, sceneRooms = []) {
  return sceneRooms.find((room) => room.id === roomId)?.name ?? roomId;
}

function createRoomsFromHcm(home) {
  const displayThings = createLifeViewThings(home);
  const thingCounts = countThingsBySpace(displayThings);
  const activeSpaces = home.spaces.filter((space) => thingCounts.get(space.id) > 0);
  const rooms = activeSpaces.map((space, index) => {
    const layout = ROOM_LAYOUTS[space.id] ?? createFallbackLayout(index);
    return {
      id: space.id,
      name: space.name,
      type: layout.type ?? ROOM_TYPE_BY_ID[space.id] ?? "generic",
      x: layout.x,
      z: layout.z,
      width: layout.width,
      depth: layout.depth,
      presence: hasPresence(home.things, space.id),
      deviceCount: thingCounts.get(space.id) ?? 0,
    };
  });

  return rooms.sort((first, second) => {
    const firstRank = roomRank(first.id);
    const secondRank = roomRank(second.id);
    return firstRank - secondRank || first.name.localeCompare(second.name, "zh-CN");
  });
}

function createDevicesFromHcm(home, sceneRooms) {
  const roomsById = new Map(sceneRooms.map((room) => [room.id, room]));
  const thingsByRoom = new Map();
  for (const thing of createLifeViewThings(home)) {
    const roomId = roomsById.has(thing.spaceId) ? thing.spaceId : "unknown";
    if (!thingsByRoom.has(roomId)) thingsByRoom.set(roomId, []);
    thingsByRoom.get(roomId).push(thing);
  }

  const devices = [];
  for (const [roomId, things] of thingsByRoom) {
    const room = roomsById.get(roomId) ?? ROOM_LAYOUTS.unknown;
    const sorted = [...things].sort(compareThingsForScene);
    sorted.forEach((thing, index) => {
      const [x, z] = devicePointInRoom(room, sorted.length, index, thing.type);
      devices.push(mapThingToSceneDevice(thing, roomId, x, z));
    });
  }
  return devices;
}

function mapThingToSceneDevice(thing, roomId, x, z) {
  const autoExecutable = thing.state?.autoExecutable ?? 0;
  const controllable = thing.state?.controllable ?? 0;
  const readable = thing.state?.readable ?? 0;
  const sensorState = describeSensorThing(thing);
  const applianceState = describeApplianceThing(thing);
  return {
    id: thing.id,
    name: thing.name,
    roomId,
    type: normalizeThingType(thing.type),
    risk: thing.policy?.risk ?? "low",
    online: thing.online,
    source: thing.logicalAsset ? "hcm-control-graph" : "hcm",
    logicalAsset: Boolean(thing.logicalAsset),
    providerThingId: thing.providerThingId,
    sceneX: x,
    sceneZ: z,
    autoExecutable,
    controllable,
    readable,
    ...(thing.logicalAsset && typeof thing.state?.commandedState === "boolean" ? { on: thing.state.commandedState } : {}),
    ...(sensorState?.detected !== undefined ? { detected: sensorState.detected } : {}),
    ...(sensorState?.open !== undefined ? { open: sensorState.open } : {}),
    ...(applianceState?.on !== undefined ? { on: applianceState.on } : {}),
    ...(applianceState?.status !== undefined ? { status: applianceState.status } : {}),
    ...(applianceState?.battery !== undefined ? { battery: applianceState.battery } : {}),
    statusLabel: thing.logicalAsset
      ? logicalAssetStatusLabel(thing)
      : sensorState?.label
        ? sensorState.label
        : applianceState?.label
          ? applianceState.label
        : autoExecutable > 0
        ? controlStatusLabel({ autoExecutable, controllable })
        : readable > 0
          ? `只读 ${readable} 项`
          : "protected",
  };
}

function controlStatusLabel({ autoExecutable, controllable }) {
  if (autoExecutable > 0 && controllable > 0 && autoExecutable === controllable) return "可自动控制";
  if (autoExecutable > 0 && controllable > 0) return `自动 ${autoExecutable}/${controllable}`;
  if (autoExecutable > 0) return `可自动 ${autoExecutable} 项`;
  if (controllable > 0) return `需确认 ${controllable} 项`;
  return "不可控制";
}

function describeSensorThing(thing) {
  if (thing.type === "presence_sensor") return describePresenceSensor(thing);
  if (thing.type === "motion_sensor") return describeMotionSensor(thing);
  if (thing.type === "door_sensor") return describeDoorSensor(thing);
  return null;
}

function describeApplianceThing(thing) {
  if (thing.type === "robot_vacuum") return describeRobotVacuum(thing);
  if (thing.type === "gas_heater" || thing.type === "water_heater") return describeBooleanAppliance(thing, {
    onLabel: "开启",
    offLabel: "关闭",
  });
  if (thing.type === "washer" || thing.type === "dryer") return describeRunningAppliance(thing);
  return null;
}

function describeRobotVacuum(thing) {
  const vacuum = findCapabilityByDomainOrName(thing, "vacuum", /扫地|机器人|vacuum|清扫|回充|充电座/);
  const battery = findCapability(thing, /电池|电量|battery/);
  const rawStatus = normalizeTextState(vacuum?.binding?.currentState ?? vacuum?.state);
  const status = normalizeRobotStatus(rawStatus);
  const label = robotStatusLabel(status);
  const batteryValue = numericState(battery);
  return {
    status,
    battery: batteryValue,
    label: joinStatusParts([label, batteryValue !== undefined ? `${batteryValue}%` : ""]),
  };
}

function describeBooleanAppliance(thing, labels) {
  const control = findCapabilityByDomainOrName(thing, "switch", /电源|开关|power|heater|热水|燃气/);
  const state = capabilityBooleanState(control);
  if (state === true) return { on: true, status: "on", label: labels.onLabel };
  if (state === false) return { on: false, status: "off", label: labels.offLabel };
  return { status: "unknown", label: thing.online === false ? "离线" : "状态未知" };
}

function describeRunningAppliance(thing) {
  const capability = findCapabilityByDomainOrName(thing, "switch", /运行|工作|状态|power|开关/);
  const state = capabilityBooleanState(capability);
  if (state === true) return { status: "running", label: "运行中" };
  if (state === false) return { status: "idle", label: "待机" };
  const text = normalizeTextState(capability?.binding?.currentState ?? capability?.state);
  if (text && !isUnknownState(text)) return { status: text, label: text };
  return { status: "unknown", label: thing.online === false ? "离线" : "状态未知" };
}

function describePresenceSensor(thing) {
  const occupancy = findCapability(thing, /有人无人|occupancy|存在.*状态|presence/);
  const hasDuration = findCapability(thing, /有人持续|has_someone/);
  const noDuration = findCapability(thing, /无人持续|no_one/);
  const active = capabilityBooleanState(occupancy);
  if (active === true) {
    return {
      detected: true,
      label: joinStatusParts(["有人", readableState(hasDuration)]),
    };
  }
  if (active === false) {
    return {
      detected: false,
      label: joinStatusParts(["无人", readableState(noDuration)]),
    };
  }
  return { detected: false, label: "状态未知" };
}

function describeMotionSensor(thing) {
  const motion = findCapability(thing, /检测到移动|motion/);
  const noMotion = findCapability(thing, /无移动|no_motion/);
  const active = capabilityBooleanState(motion);
  if (active === true) return { detected: true, label: "有移动" };
  if (active === false) return { detected: false, label: "无移动" };
  if (noMotion && !isUnknownState(noMotion.state)) {
    return { detected: false, label: joinStatusParts(["无移动", readableState(noMotion)]) };
  }
  if (motion && !isUnknownState(motion.state)) {
    return { detected: false, label: joinStatusParts(["最近移动", readableState(motion)]) };
  }
  return { detected: false, label: "状态未知" };
}

function describeDoorSensor(thing) {
  const contact = findCapability(thing, /接触状态|contact|门窗|door|window/);
  const open = capabilityBooleanState(contact);
  if (open === true) return { open: true, label: "开启" };
  if (open === false) return { open: false, label: "关闭" };
  return { open: false, label: "状态未知" };
}

function findCapability(thing, pattern) {
  return (thing.capabilities ?? []).find((capability) => {
    const text = `${capability.id ?? ""} ${capability.name ?? ""} ${capability.binding?.entityId ?? ""}`.toLowerCase();
    return pattern.test(text);
  });
}

function findCapabilityByDomainOrName(thing, domain, pattern) {
  return (thing.capabilities ?? []).find((capability) => {
    const bindingDomain = capability.binding?.domain;
    const text = `${capability.id ?? ""} ${capability.name ?? ""} ${capability.binding?.entityId ?? ""}`.toLowerCase();
    return bindingDomain === domain || pattern.test(text);
  });
}

function capabilityBooleanState(capability) {
  if (!capability) return null;
  const state = capability.state;
  if (state === true || state === false) return state;
  const text = String(capability.binding?.currentState ?? state ?? "").toLowerCase();
  if (["on", "open", "detected", "motion", "occupied", "home", "true"].includes(text)) return true;
  if (["off", "closed", "clear", "not_detected", "no_motion", "unoccupied", "away", "false"].includes(text)) return false;
  return null;
}

function readableState(capability) {
  if (!capability || isUnknownState(capability.state)) return "";
  return String(capability.state);
}

function normalizeTextState(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toLowerCase();
}

function numericState(capability) {
  if (!capability || isUnknownState(capability.state)) return undefined;
  const value = Number(capability.state);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

function normalizeRobotStatus(status) {
  if (!status || isUnknownState(status)) return "unknown";
  if (["cleaning", "on"].includes(status)) return "cleaning";
  if (["returning", "returning_to_base"].includes(status)) return "returning";
  if (["docked", "charging"].includes(status)) return "docked";
  if (["idle", "off"].includes(status)) return "idle";
  if (["paused"].includes(status)) return "paused";
  if (["error"].includes(status)) return "error";
  return status;
}

function robotStatusLabel(status) {
  if (status === "cleaning") return "清扫中";
  if (status === "returning") return "回充中";
  if (status === "docked") return "在充电座";
  if (status === "idle") return "待命";
  if (status === "paused") return "暂停";
  if (status === "error") return "异常";
  if (status === "unknown") return "状态未知";
  return status;
}

function isUnknownState(state) {
  return state === undefined || state === null || state === "" || state === "unknown" || state === "unavailable";
}

function joinStatusParts(parts) {
  return parts.filter(Boolean).join(" · ");
}

function createLifeViewThings(home) {
  const graph = getHcmControlGraph(home);
  const logicalAssets = graph.assets
    .map((asset) => {
      const resolved = resolveControlAsset(home, asset.id);
      if (!resolved?.endpoint || !resolved.thing || !resolved.capability) return null;
      return {
        id: asset.id,
        name: asset.name,
        type: asset.type,
        spaceId: asset.spaceId,
        online: resolved.thing.online,
        policy: resolved.capability.policy,
        providerThingId: resolved.thing.id,
        logicalAsset: true,
        state: {
          ...asset.state,
          autoExecutable: resolved.capability.policy?.autoExecutable ? 1 : 0,
          controllable: 1,
          readable: asset.state?.commandedState === "unknown" ? 0 : 1,
        },
      };
    })
    .filter(Boolean);
  if (logicalAssets.length === 0) return home.things;
  const INFRASTRUCTURE_TYPES = ["hub", "scale"];
  return [
    ...home.things.filter((thing) => thing.type !== "switch_panel" && !INFRASTRUCTURE_TYPES.includes(thing.type)),
    ...logicalAssets,
  ];
}

function logicalAssetStatusLabel(thing) {
  const state = thing.state?.commandedState;
  if (state === true) return thing.type === "drying_rack" ? "通电" : "回路开启";
  if (state === false) return thing.type === "drying_rack" ? "断电" : "回路关闭";
  return thing.online === false ? "控制器离线" : "状态未知";
}

function normalizeThingType(type) {
  if (type === "switch_panel") return "switch_panel";
  if (type === "hub" || type === "scale") return type;
  if (type === "drying_rack") return "drying_rack";
  return type || "generic_entity";
}

function devicePointInRoom(room, total, index, type) {
  const marginX = Math.min(0.48, room.width * 0.24);
  const marginZ = Math.min(0.42, room.depth * 0.22);
  const innerWidth = Math.max(0.35, room.width - marginX * 2);
  const innerDepth = Math.max(0.35, room.depth - marginZ * 2);
  const columns = Math.max(1, Math.ceil(Math.sqrt(total * (innerWidth / innerDepth))));
  const rows = Math.max(1, Math.ceil(total / columns));
  const col = index % columns;
  const row = Math.floor(index / columns);
  const xStep = innerWidth / columns;
  const zStep = innerDepth / rows;
  let x = room.x - innerWidth / 2 + xStep * (col + 0.5);
  let z = room.z - innerDepth / 2 + zStep * (row + 0.5);

  if (type === "curtain") z = room.z + room.depth / 2 - marginZ * 0.8;
  if (type === "door_sensor") z = room.z - room.depth / 2 + marginZ * 0.45;
  if (type === "ac") z = room.z + room.depth / 2 - marginZ * 0.65;
  if (type === "tv") x = room.x + room.width / 2 - marginX * 0.75;
  if (type === "camera") {
    x = room.x + room.width / 2 - marginX * 0.75;
    z = room.z - room.depth / 2 + marginZ * 0.75;
  }

  return [roundPoint(x), roundPoint(z)];
}

function compareThingsForScene(first, second) {
  const firstPriority = DEVICE_TYPE_PRIORITY[first.type] ?? 100;
  const secondPriority = DEVICE_TYPE_PRIORITY[second.type] ?? 100;
  return firstPriority - secondPriority || first.name.localeCompare(second.name, "zh-CN");
}

function countThingsBySpace(things = []) {
  const counts = new Map();
  for (const thing of things) {
    counts.set(thing.spaceId, (counts.get(thing.spaceId) ?? 0) + 1);
  }
  return counts;
}

function hasPresence(things = [], spaceId) {
  return things.some(
    (thing) =>
      thing.spaceId === spaceId &&
      ["presence_sensor", "motion_sensor", "door_sensor"].includes(thing.type),
  );
}

function createFallbackLayout(index) {
  const columns = 4;
  const col = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: -4.2 + col * 2.8,
    z: 4.8 + row * 2,
    width: 2.2,
    depth: 1.65,
    type: "generic",
  };
}

function roomRank(roomId) {
  const rank = [
    "entry",
    "living",
    "dining",
    "kitchen",
    "bath",
    "balcony",
    "cat_room",
    "second",
    "master",
    "master_bath",
    "study",
  ].indexOf(roomId);
  return rank === -1 ? 999 : rank;
}

function roundPoint(value) {
  return Math.round(value * 100) / 100;
}
import { getHcmControlGraph, resolveControlAsset } from "./hcmControlGraph.js";
