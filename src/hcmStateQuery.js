import { ROOM_ALIASES } from "./roomAliases.js";

const TYPE_PATTERNS = [
  ["motion_sensor", /人体|移动|motion/],
  ["presence_sensor", /人在|存在|有人|无人|presence|occupancy/],
  ["door_sensor", /门窗|门磁|大门|前门|门/],
  ["camera", /监控|摄像|camera/],
  ["ac", /空调|温度/],
  ["fan", /风扇/],
  ["curtain", /窗帘|纱帘|窗纱/],
  ["tv", /电视|音箱|音乐|播放/],
  ["pet_feeder", /猫粮|喂食|投喂/],
  ["switch_panel", /开关|灯|照明/],
];

export function answerHcmStateQuery(input, home, reason = "") {
  const text = normalize(input);
  if (!home?.things?.length || !looksLikeStateQuery(text)) return null;

  const candidates = scoreThings(text, home).filter((candidate) => candidate.score > 0);
  if (candidates.length === 0) return null;
  const match = candidates[0].thing;
  const roomName = preferredRoomName(text, home, match);

  return {
    path: "hcm-state",
    thingId: match.id,
    thingName: match.name,
    roomId: match.spaceId,
    reason,
    summary: formatThingState(match, roomName),
  };
}

export function answerHcmOccupancyStateQuery(input, home, reason = "") {
  const text = normalize(input);
  if (!home?.things?.length || !looksLikeOccupancyQuery(text)) return null;
  const roomIds = requestedRooms(text, home.spaces ?? []);
  if (roomIds.length !== 1) return null;
  const roomId = roomIds[0];
  const roomName = home.spaces?.find((space) => space.id === roomId)?.name ?? roomId;
  const candidates = home.things
    .filter((thing) => thing.spaceId === roomId && ["presence_sensor", "motion_sensor"].includes(thing.type))
    .sort((first, second) => occupancySensorRank(first, text) - occupancySensorRank(second, text));
  if (candidates.length === 0) {
    return {
      path: "hcm-occupancy-state",
      mode: "occupancy_state",
      thingId: null,
      thingName: `${roomName}人在状态`,
      roomId,
      available: false,
      state: "unknown",
      reason,
      summary: `${roomName}没有可用的人在/人体传感器状态。`,
    };
  }
  const match = candidates[0];
  const occupancy = occupancyValue(match);
  return {
    path: "hcm-occupancy-state",
    mode: "occupancy_state",
    thingId: match.id,
    thingName: match.name,
    roomId: match.spaceId,
    available: occupancy !== "unknown",
    state: occupancy,
    reason,
    summary: `${roomName}${occupancy === true ? "有人" : occupancy === false ? "无人" : "人在状态未知"}。数据来自${match.name}。`,
  };
}

export function answerHcmRoomLightStateQuery(input, home, reason = "") {
  const text = normalize(input);
  if (!home?.things?.length || !looksLikeStateQuery(text) || !/灯|照明/.test(text)) return null;
  const roomIds = requestedRooms(text, home.spaces ?? []);
  if (roomIds.length !== 1) return null;

  const roomId = roomIds[0];
  const roomName = home.spaces?.find((space) => space.id === roomId)?.name ?? roomId;
  const assets = getHcmControlGraph(home).assets
    .filter((asset) => asset.spaceId === roomId && asset.type === "light")
    .sort((first, second) => first.name.localeCompare(second.name, "zh-CN"));
  if (assets.length < 2) return null;

  const items = assets.map((asset) => answerHcmThingStateQuery(input, home, asset.id, reason)).filter(Boolean);
  const itemSummary = items.map(formatRoomLightItem).join("；");
  return {
    path: "hcm-room-light-state",
    mode: "room_light_state",
    thingId: null,
    thingName: `${roomName}灯光`,
    roomId,
    roomName,
    available: items.some((item) => item.available),
    items,
    reason,
    summary: `${roomName}灯光：${itemSummary || "暂时没有可读状态"}。状态来自开关回路，不能独立证明灯具实际发光。`,
  };
}

export function answerHcmThingStateQuery(input, home, thingId, reason = "") {
  const logical = resolveControlAsset(home, thingId);
  if (logical?.asset) return formatControlAssetState(logical, home, reason);
  const thing = home?.things?.find((item) => item.id === thingId);
  if (!thing) return null;
  const roomName = preferredRoomName(normalize(input), home, thing);
  return {
    path: "hcm-state-llm",
    thingId: thing.id,
    thingName: thing.name,
    roomId: thing.spaceId,
    reason,
    summary: formatThingState(thing, roomName),
  };
}

function formatRoomLightItem(item) {
  if (item.state === true) return `${item.thingName}开`;
  if (item.state === false) return `${item.thingName}关`;
  return `${item.thingName}未知`;
}

function formatControlAssetState({ asset, endpoint, thing }, home, reason) {
  const roomName = home?.spaces?.find((space) => space.id === asset.spaceId)?.name ?? asset.spaceId;
  const displayName = String(asset.name).includes(String(roomName)) ? asset.name : `${roomName}的${asset.name}`;
  const state = asset.state?.commandedState;
  const controllerUnavailable = !endpoint || !thing || thing.online === false || ["unavailable", "unknown"].includes(endpoint.state);
  const relayState = state === true ? "控制回路已开启" : state === false ? "控制回路已关闭" : "控制回路状态未知";
  const controller = endpoint && thing ? `，由${thing.name}${channelLabel(endpoint.channel)}控制` : "";
  const unavailableReason = !endpoint || !thing ? "尚未确认控制通道" : `控制器${thing.name}当前离线`;
  const summary = controllerUnavailable
    ? `${displayName}：状态未知，${unavailableReason}。未执行任何设备动作。`
    : `${displayName}：${relayState}${controller}。该状态来自开关继电器，未独立确认灯具实际发光。`;
  return {
    path: "hcm-control-asset-state",
    thingId: asset.id,
    thingName: asset.name,
    logicalAssetId: asset.id,
    roomId: asset.spaceId,
    controllerId: endpoint?.controllerId,
    endpointId: endpoint?.id,
    available: !controllerUnavailable,
    state: controllerUnavailable ? "unknown" : state,
    reason,
    summary,
  };
}

function channelLabel(channel) {
  if (channel === "left") return "左键";
  if (channel === "middle") return "中键";
  if (channel === "right") return "右键";
  return channel && channel !== "unknown" ? channel : "通道";
}

export function looksLikeStateQuery(text) {
  if (!text) return false;
  if (/打开|开启|启动|关闭|关掉|调到|设置|播放|停止/.test(text)) return false;
  return /状态|目前|现在|当前|有没有|是否|在不在|有人|无人|人在|人不|开着|关着|几度|温度|亮度|电量|光照/.test(text);
}

function looksLikeOccupancyQuery(text) {
  return /有人|无人|人在|人不|人体|存在|在不在/.test(text) && !/门|门窗|大门|前门/.test(text);
}

function occupancySensorRank(thing, text) {
  if (thing.type === "presence_sensor") return 0;
  if (/人体|移动/.test(text) && thing.type === "motion_sensor") return 0;
  return 1;
}

function occupancyValue(thing) {
  if (thing.type === "presence_sensor") {
    const occupancy = findCapability(thing, /有人无人|occupancy|存在.*状态/);
    if (occupancy?.state === true || occupancy?.state === false) return occupancy.state;
  }
  if (thing.type === "motion_sensor") {
    const motion = findCapability(thing, /检测到移动|motion/);
    if (motion?.state === true || motion?.state === false) return motion.state;
    const noMotion = findCapability(thing, /无移动|no_motion/);
    if (!isUnknown(noMotion?.state)) return false;
  }
  return "unknown";
}

function scoreThings(text, home) {
  const requestedTypes = requestedThingTypes(text);
  const requestedRoomIds = requestedRooms(text, home.spaces ?? []);
  const tokens = splitQueryTokens(text);

  return home.things
    .map((thing) => {
      const name = normalize(thing.name);
      let score = 0;
      if (requestedTypes.includes(thing.type)) score += 8;
      if (requestedRoomIds.includes(thing.spaceId)) score += 5;
      if (tokens.some((token) => token.length >= 2 && name.includes(token))) score += 3;
      if (roomAliasMatchesThingName(text, name)) score += 4;
      if (/传感器/.test(text) && /sensor/.test(thing.type)) score += 2;
      if (/灯/.test(text) && thing.type === "switch_panel") score += 1;
      return { thing, score };
    })
    .sort((first, second) => second.score - first.score || first.thing.name.localeCompare(second.thing.name, "zh-CN"));
}

function requestedThingTypes(text) {
  return TYPE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([type]) => type);
}

function requestedRooms(text, spaces) {
  const ids = [];
  for (const [roomId, aliases] of ROOM_ALIASES) {
    if (aliases.some((alias) => text.includes(normalize(alias)))) ids.push(roomId);
  }
  for (const space of spaces) {
    const name = normalize(space.name);
    if (name && text.includes(name)) ids.push(space.id);
  }
  return Array.from(new Set(ids));
}

function preferredRoomName(text, home, thing) {
  const thingName = normalize(thing.name);
  for (const [roomId, aliases] of ROOM_ALIASES) {
    const matchedAlias = aliases.find((alias) => text.includes(normalize(alias)));
    if (!matchedAlias) continue;
    if (thing.spaceId === roomId || aliases.some((alias) => thingName.includes(normalize(alias)))) {
      return matchedAlias;
    }
  }
  return home.spaces?.find((space) => space.id === thing.spaceId)?.name ?? thing.spaceId;
}

function roomAliasMatchesThingName(text, thingName) {
  return ROOM_ALIASES.some(([, aliases]) =>
    aliases.some((alias) => text.includes(normalize(alias)) && thingName.includes(normalize(alias))),
  );
}

function formatThingState(thing, roomName) {
  if (thing.type === "presence_sensor") return formatPresenceState(thing, roomName);
  if (thing.type === "motion_sensor") return formatMotionState(thing, roomName);
  if (thing.type === "door_sensor") return formatDoorState(thing, roomName);

  const readable = sensorCapabilities(thing)
    .slice(0, 3)
    .map((capability) => `${shortCapabilityName(capability.name)} ${formatStateValue(capability.state)}`)
    .join("，");
  const online = thing.online === false ? "离线" : "在线";
  return readable
    ? `${roomName}的${thing.name}：${online}，${readable}。`
    : `${roomName}的${thing.name}：${online}，暂无可读状态。`;
}

function formatPresenceState(thing, roomName) {
  const occupancy = findCapability(thing, /有人无人|occupancy|存在.*状态/);
  const hasDuration = findCapability(thing, /有人持续|has_someone|has_someone_duration/);
  const noDuration = findCapability(thing, /无人持续|no_one|no_one_duration/);
  const fallbackDuration = findCapability(thing, /duration/);
  const illuminance = findCapability(thing, /光照|illumination/);
  const battery = findCapability(thing, /电池|电量|battery/);
  const parts = [];
  if (occupancy) parts.push(formatBooleanPresence(occupancy.state));
  const duration = occupancy?.state === true ? hasDuration : occupancy?.state === false ? noDuration : fallbackDuration;
  if (duration && !isUnknown(duration.state)) parts.push(`${shortCapabilityName(duration.name)} ${formatStateValue(duration.state)}`);
  if (illuminance && !isUnknown(illuminance.state)) parts.push(`光照 ${formatStateValue(illuminance.state)}`);
  if (battery && !isUnknown(battery.state)) parts.push(`电量 ${formatStateValue(battery.state)}%`);
  return `${roomName}的${thing.name}：${parts.join("，") || "暂无可读状态"}。`;
}

function formatMotionState(thing, roomName) {
  const motion = findCapability(thing, /检测到移动|motion/);
  const noMotion = findCapability(thing, /无移动|no_motion/);
  const illuminance = findCapability(thing, /光照|illumination/);
  const battery = findCapability(thing, /电池|电量|battery/);
  const parts = [];
  if (motion && !isUnknown(motion.state)) parts.push(`最近一次移动检测 ${formatStateValue(motion.state)}`);
  if (noMotion && !isUnknown(noMotion.state)) parts.push(`无移动持续 ${formatStateValue(noMotion.state)}`);
  if (illuminance && !isUnknown(illuminance.state)) parts.push(`光照 ${formatStateValue(illuminance.state)}`);
  if (battery && !isUnknown(battery.state)) parts.push(`电量 ${formatStateValue(battery.state)}%`);
  return `${roomName}的${thing.name}：${parts.join("，") || "暂无可读状态"}。`;
}

function formatDoorState(thing, roomName) {
  const contact = findCapability(thing, /接触状态|contact|门窗/);
  const battery = findCapability(thing, /电池|电量|battery/);
  const parts = [];
  if (contact) parts.push(contact.state ? "开启" : "关闭");
  if (battery && !isUnknown(battery.state)) parts.push(`电量 ${formatStateValue(battery.state)}%`);
  return `${roomName}的${thing.name}：${parts.join("，") || "暂无可读状态"}。`;
}

function findCapability(thing, pattern) {
  return sensorCapabilities(thing).find((capability) => pattern.test(`${capability.name} ${capability.binding?.entityId ?? ""}`));
}

function sensorCapabilities(thing) {
  return (thing.capabilities ?? []).filter((capability) => capability.kind === "sensor");
}

function formatBooleanPresence(value) {
  if (value === true) return "有人";
  if (value === false) return "无人";
  return formatStateValue(value);
}

function formatStateValue(value) {
  if (value === true) return "是";
  if (value === false) return "否";
  if (typeof value === "string") {
    return value
      .replace(/Weak/gi, "弱")
      .replace(/Minutes?/gi, "分钟")
      .replace(/unknown/gi, "未知");
  }
  return String(value ?? "未知");
}

function shortCapabilityName(name) {
  return String(name ?? "")
    .replace(/^.*传感器\s*/, "")
    .replace(/^电池\s*/, "电量")
    .trim();
}

function isUnknown(value) {
  return value === undefined || value === null || String(value).toLowerCase() === "unknown";
}

function splitQueryTokens(text) {
  return text
    .replace(/状态|目前|现在|当前|是什么|多少|有没有|是否|的/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalize(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？,.!?]/g, "");
}
import { getHcmControlGraph, resolveControlAsset } from "./hcmControlGraph.js";
