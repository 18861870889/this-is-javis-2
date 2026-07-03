import { CAPABILITY_KINDS, stableId } from "./hcm.js";
import { getRoomAliasMap } from "./roomAliases.js";

export const HCM_CONTROL_GRAPH_VERSION = "0.1";

export const CONTROL_RELATION_TYPES = {
  RELAY: "relay_control",
  REMOTE: "remote_control",
  SCENE: "scene_trigger",
  POWER: "power_dependency",
};

export const ENDPOINT_MAPPING_STATUS = {
  BOUND: "bound",
  REVIEW: "review",
  UNBOUND: "unbound",
  IGNORED: "ignored",
};

const LIGHT_NAME_PATTERN = /灯|灯带|射灯|筒灯|吊灯|台灯|主灯|壁灯|吸顶灯|智能镜/;
const UNUSED_NAME_PATTERN = /未使用|未定义|未绑定|无直连|空闲|预留|^开关(?:开关状态)?$/;
const CONFIG_NAME_PATTERN = /互控|解控|绑定状态|遥控器绑定|灵动|功能选择|配置|模式|物理控制锁|童锁|延时|按键进入/;
const REMOTE_BINDING_PATTERN = /绑定[（(]/;
const RELAY_ENTITY_PATTERN = /_on_p_[234]_\d+$/;
const CHANNEL_PATTERNS = [
  ["left", /左键/],
  ["middle", /中键|中间/],
  ["right", /右键/],
];
const ROOM_PATTERNS = [
  ["master_bath", /主卧卫生间|主卫/],
  ["bath", /公共卫生间|公卫|外洗手台|洗手台|卫生间/],
  ["master", /主卧/],
  ["second", /次卧/],
  ["cat_room", /猫猫房|猫房/],
  ["study", /书房/],
  ["kitchen", /厨房/],
  ["dining", /餐厅|餐边/],
  ["living", /客厅|大厅|沙发/],
  ["balcony", /阳台/],
  ["entry", /玄关|入户|门口|过道/],
];

export function attachHcmControlGraph(home, { mappings = {} } = {}) {
  const controlGraph = buildHcmControlGraph(home, { mappings });
  return {
    ...home,
    stats: {
      ...home.stats,
      controllerCount: controlGraph.stats.controllerCount,
      controlEndpointCount: controlGraph.stats.endpointCount,
      logicalAssetCount: controlGraph.stats.assetCount,
      controlMappingReviewCount: controlGraph.stats.reviewCount,
      unboundEndpointCount: controlGraph.stats.unboundCount,
    },
    controlGraph,
  };
}

export function getHcmControlGraph(home) {
  return home?.controlGraph ?? buildHcmControlGraph(home);
}

export function buildHcmControlGraph(home, { mappings = {} } = {}) {
  const spaces = new Map((home?.spaces ?? []).map((space) => [space.id, space]));
  const controllers = [];
  const endpoints = [];
  const assetsById = new Map();
  const relationships = [];

  for (const thing of home?.things ?? []) {
    if (thing.type !== "switch_panel") continue;
    const installation = inferControllerInstallation(thing, spaces);
    const controller = {
      id: `controller_${thing.id}`,
      name: thing.name,
      providerThingId: thing.id,
      installedSpaceId: installation.spaceId,
      installationConfidence: installation.confidence,
      installationSource: installation.source,
      online: thing.online,
      endpointIds: [],
    };

    for (const capability of thing.capabilities ?? []) {
      const entityId = capability.binding?.entityId;
      if (!entityId) continue;
      const override = mappings?.[entityId] ?? null;
      if (!isRelayControlCapability(capability, override)) continue;
      const endpoint = createEndpoint({ home, spaces, thing, controller, capability, override });
      endpoints.push(endpoint);
      controller.endpointIds.push(endpoint.id);

      if (!endpoint.assetId) continue;
      const asset = assetsById.get(endpoint.assetId) ?? createAsset(endpoint, spaces);
      asset.endpointIds.push(endpoint.id);
      asset.mappingConfidence = Math.max(asset.mappingConfidence, endpoint.mappingConfidence);
      asset.mappingStatus = strongerMappingStatus(asset.mappingStatus, endpoint.mappingStatus);
      if (typeof endpoint.state === "boolean" && asset.state.commandedState === "unknown") {
        asset.state.commandedState = endpoint.state;
      }
      assetsById.set(asset.id, asset);
      relationships.push({
        id: `relation_${stableId(`${endpoint.id}_${asset.id}`)}`,
        type: endpoint.relationType,
        fromEndpointId: endpoint.id,
        toAssetId: asset.id,
        source: endpoint.mappingSource,
        confidence: endpoint.mappingConfidence,
      });
    }
    controllers.push(controller);
  }

  const assets = Array.from(assetsById.values()).map((asset) => {
    const endpointIds = Array.from(new Set(asset.endpointIds));
    const primary = endpointIds
      .map((id) => endpoints.find((endpoint) => endpoint.id === id))
      .filter(Boolean)
      .sort(compareEndpointsForExecution)
      .find((endpoint) => endpoint.status === ENDPOINT_MAPPING_STATUS.BOUND);
    return {
      ...asset,
      endpointIds,
      primaryEndpointId: primary?.id ?? null,
      state: {
        ...asset.state,
        commandedState: typeof primary?.state === "boolean" ? primary.state : "unknown",
      },
    };
  });
  const candidates = endpoints
    .filter((endpoint) => [ENDPOINT_MAPPING_STATUS.REVIEW, ENDPOINT_MAPPING_STATUS.UNBOUND].includes(endpoint.status))
    .map((endpoint) => ({
      id: `candidate_${stableId(endpoint.entityId)}`,
      endpointId: endpoint.id,
      controllerId: endpoint.controllerId,
      controllerName: endpoint.controllerName,
      entityId: endpoint.entityId,
      channel: endpoint.channel,
      status: endpoint.status,
      suggestedAssetName: endpoint.suggestedAssetName,
      suggestedSpaceId: endpoint.targetSpaceId,
      confidence: endpoint.mappingConfidence,
      reason: endpoint.mappingReason,
    }));

  return {
    version: HCM_CONTROL_GRAPH_VERSION,
    generatedAt: home?.syncedAt ?? new Date().toISOString(),
    controllers,
    endpoints,
    assets,
    relationships,
    candidates,
    stats: {
      controllerCount: controllers.length,
      endpointCount: endpoints.length,
      assetCount: assets.length,
      boundCount: endpoints.filter((endpoint) => endpoint.status === ENDPOINT_MAPPING_STATUS.BOUND).length,
      reviewCount: endpoints.filter((endpoint) => endpoint.status === ENDPOINT_MAPPING_STATUS.REVIEW).length,
      unboundCount: endpoints.filter((endpoint) => endpoint.status === ENDPOINT_MAPPING_STATUS.UNBOUND).length,
      ignoredCount: endpoints.filter((endpoint) => endpoint.status === ENDPOINT_MAPPING_STATUS.IGNORED).length,
    },
  };
}

export function resolveControlAsset(home, assetId) {
  const graph = getHcmControlGraph(home);
  const asset = graph.assets.find((item) => item.id === assetId);
  if (!asset) return null;
  const endpointCandidates = asset.endpointIds
    .map((id) => graph.endpoints.find((endpoint) => endpoint.id === id))
    .filter(Boolean)
    .sort(compareEndpointsForExecution);
  const endpoint = endpointCandidates.find((item) => item.status === ENDPOINT_MAPPING_STATUS.BOUND);
  if (!endpoint) return { asset, endpoint: null, thing: null, capability: null };
  const thing = home?.things?.find((item) => item.id === endpoint.providerThingId);
  const capability = thing?.capabilities?.find((item) => item.id === endpoint.capabilityId);
  return { asset, endpoint, thing: thing ?? null, capability: capability ?? null };
}

export function findExplicitRoomIds(input, home) {
  const text = normalizeText(input);
  const ids = [];
  for (const [roomId, pattern] of ROOM_PATTERNS) {
    if (pattern.test(text)) ids.push(roomId);
  }
  // Use shared alias map (includes space names + ROOM_ALIASES)
  const aliasMap = getRoomAliasMap(home);
  for (const [roomId, labels] of aliasMap) {
    const normalizedLabels = labels.map(normalizeText).filter(Boolean);
    if (normalizedLabels.some((label) => text.includes(label))) ids.push(roomId);
  }
  return Array.from(new Set(ids));
}

function createEndpoint({ home, spaces, thing, controller, capability, override }) {
  const entityId = capability.binding.entityId;
  const rawName = cleanLoadName(capability.name);
  const explicitRoomId = inferRoomFromText(rawName, spaces);
  const targetSpaceId = override?.spaceId || explicitRoomId || thing.spaceId || "unknown";
  const rawAssetName = String(override?.assetName || rawName).trim();
  const hasLightingSemantics = LIGHT_NAME_PATTERN.test(rawAssetName);
  const explicitlyUnused = override?.status === ENDPOINT_MAPPING_STATUS.UNBOUND || UNUSED_NAME_PATTERN.test(rawAssetName);
  const ignored = override?.status === ENDPOINT_MAPPING_STATUS.IGNORED;
  const confirmed = override?.status === ENDPOINT_MAPPING_STATUS.BOUND;
  const remoteBinding = REMOTE_BINDING_PATTERN.test(capability.name);
  const roomConflict = Boolean(explicitRoomId && thing.spaceId && thing.spaceId !== "unknown" && explicitRoomId !== thing.spaceId);
  const mappingConfidence = confirmed
    ? 1
    : remoteBinding
      ? 0.68
      : hasLightingSemantics && explicitRoomId
      ? 0.97
      : hasLightingSemantics && targetSpaceId !== "unknown"
          ? 0.84
          : 0.35;
  const status = ignored
    ? ENDPOINT_MAPPING_STATUS.IGNORED
    : confirmed
      ? ENDPOINT_MAPPING_STATUS.BOUND
      : explicitlyUnused || !hasLightingSemantics
        ? ENDPOINT_MAPPING_STATUS.UNBOUND
        : remoteBinding
          ? ENDPOINT_MAPPING_STATUS.REVIEW
        : mappingConfidence >= 0.84
          ? ENDPOINT_MAPPING_STATUS.BOUND
          : ENDPOINT_MAPPING_STATUS.REVIEW;
  const room = spaces.get(targetSpaceId);
  const displayName = status === ENDPOINT_MAPPING_STATUS.BOUND || status === ENDPOINT_MAPPING_STATUS.REVIEW
    ? buildAssetDisplayName(rawAssetName, room)
    : null;
  const assetId = displayName ? `asset_${stableId(targetSpaceId)}_${stableId(displayName)}` : null;

  return {
    id: `endpoint_${stableId(entityId)}`,
    controllerId: controller.id,
    controllerName: thing.name,
    providerThingId: thing.id,
    capabilityId: capability.id,
    entityId,
    domain: capability.binding.domain,
    channel: inferChannel(capability.name, entityId),
    name: capability.name,
    state: capability.state ?? "unknown",
    stateConfidence: capability.state === undefined ? "unknown" : "provider_reported",
    policy: capability.policy,
    status,
    assetId: status === ENDPOINT_MAPPING_STATUS.BOUND || status === ENDPOINT_MAPPING_STATUS.REVIEW ? assetId : null,
    suggestedAssetName: displayName,
    rawAssetName,
    targetSpaceId,
    relationType: override?.relationType || (remoteBinding ? CONTROL_RELATION_TYPES.REMOTE : CONTROL_RELATION_TYPES.RELAY),
    mappingStatus: confirmed ? "confirmed" : status === ENDPOINT_MAPPING_STATUS.BOUND ? "inferred" : status,
    mappingSource: confirmed ? "user_override" : "provider_semantics",
    mappingConfidence,
    mappingReason: mappingReason({ confirmed, explicitlyUnused, ignored, hasLightingSemantics, roomConflict, explicitRoomId, remoteBinding }),
  };
}

const DRYING_RACK_NAME_PATTERN = /晾衣|衣杆/;

function inferAssetType(assetName) {
  if (DRYING_RACK_NAME_PATTERN.test(assetName ?? "")) return "drying_rack";
  return "light";
}

function createAsset(endpoint, spaces) {
  const room = spaces.get(endpoint.targetSpaceId);
  const assetName = endpoint.suggestedAssetName ?? endpoint.rawAssetName;
  return {
    id: endpoint.assetId,
    name: endpoint.suggestedAssetName,
    type: inferAssetType(assetName),
    spaceId: endpoint.targetSpaceId,
    roomName: room?.name ?? endpoint.targetSpaceId,
    aliases: Array.from(new Set([endpoint.rawAssetName, endpoint.suggestedAssetName].filter(Boolean))),
    endpointIds: [],
    mappingStatus: endpoint.mappingStatus,
    mappingConfidence: endpoint.mappingConfidence,
    state: {
      commandedState: "unknown",
      observedState: "unknown",
      confidence: "inferred_from_relay",
    },
  };
}

function isRelayControlCapability(capability, override) {
  if (capability?.kind !== CAPABILITY_KINDS.CONTROL) return false;
  if (capability.valueType !== "boolean") return false;
  const domain = capability.binding?.domain;
  if (domain === "light") return true;
  if (domain !== "switch" || CONFIG_NAME_PATTERN.test(capability.name)) return false;
  if (override?.status) return true;
  if (RELAY_ENTITY_PATTERN.test(capability.binding?.entityId ?? "")) return true;
  if (LIGHT_NAME_PATTERN.test(capability.name) && capability.policy?.autoExecutable) return true;
  return CHANNEL_PATTERNS.some(([, pattern]) => pattern.test(capability.name)) && UNUSED_NAME_PATTERN.test(capability.name);
}

function inferControllerInstallation(thing, spaces) {
  const nameRoomId = inferRoomFromText(thing.name, spaces);
  if (nameRoomId) return { spaceId: nameRoomId, confidence: 0.78, source: "controller_name" };
  return {
    spaceId: thing.spaceId || "unknown",
    confidence: thing.spaceId && thing.spaceId !== "unknown" ? 0.6 : 0.2,
    source: thing.spaceId && thing.spaceId !== "unknown" ? "provider_area" : "unknown",
  };
}

function inferRoomFromText(value, spaces) {
  const text = normalizeText(value);
  const knownMatches = ROOM_PATTERNS
    .map(([roomId, pattern], order) => ({ roomId, order, index: text.search(pattern) }))
    .filter((match) => match.index >= 0 && spaces.has(match.roomId))
    .sort((first, second) => first.index - second.index || first.order - second.order);
  if (knownMatches.length > 0) return knownMatches[0].roomId;
  for (const space of spaces.values()) {
    const labels = [space.name, ...(space.aliases ?? [])].map(normalizeText).filter(Boolean);
    if (labels.some((label) => text.includes(label))) return space.id;
  }
  return null;
}

function buildAssetDisplayName(rawName, room) {
  let name = cleanLoadName(rawName);
  const roomName = room?.name;
  if (room?.id === "cat_room" && /^(小孩房|儿童房)/.test(name)) {
    name = name.replace(/^(小孩房|儿童房)/, roomName || "猫猫房");
  }
  if (!roomName || room?.id === "unknown" || normalizeText(name).includes(normalizeText(roomName))) return name;
  if (inferRoomFromText(name, new Map([[room.id, room]]))) return name;
  return `${roomName}${name}`;
}

function cleanLoadName(value) {
  return String(value ?? "")
    .replace(/开关状态切换/g, "")
    .replace(/开关(?:左键|中键|右键)/g, "")
    .replace(/开关$/g, "")
    .replace(/(?:左键|中键|右键)(?:功能选择)?/g, "")
    .replace(/^绑定[（(]?/, "")
    .replace(/[）)]$/g, "")
    .replace(/^[-—_\s]+|[-—_\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferChannel(name, entityId) {
  for (const [channel, pattern] of CHANNEL_PATTERNS) {
    if (pattern.test(name)) return channel;
  }
  const instance = String(entityId).match(/_p_(\d+)_\d+$/)?.[1];
  if (instance === "2") return "left";
  if (instance === "3") return "middle";
  if (instance === "4") return "right";
  return instance ? `channel_${instance}` : "unknown";
}

function mappingReason({ confirmed, explicitlyUnused, ignored, hasLightingSemantics, roomConflict, explicitRoomId, remoteBinding }) {
  if (confirmed) return "用户已确认通道、逻辑设备和房间映射";
  if (ignored) return "用户已忽略该控制通道";
  if (explicitlyUnused) return "通道名称表明未绑定或未使用";
  if (!hasLightingSemantics) return "通道缺少明确的受控设备名称";
  if (remoteBinding) return "名称表明这是远程绑定入口，需要与主执行器分离确认";
  if (explicitRoomId && roomConflict) return "受控设备名称提供明确房间语义，控制器安装位置不参与目标房间判断";
  if (explicitRoomId) return "从受控设备名称推断逻辑设备和房间";
  return "从照明名称和面板 HA Area 推断，建议确认";
}

function compareEndpointsForExecution(first, second) {
  return endpointRank(second) - endpointRank(first) || second.mappingConfidence - first.mappingConfidence;
}

function endpointRank(endpoint) {
  if (endpoint.mappingStatus === "confirmed") return 4;
  if (endpoint.status === ENDPOINT_MAPPING_STATUS.BOUND) return 3;
  if (endpoint.status === ENDPOINT_MAPPING_STATUS.REVIEW) return 2;
  return 0;
}

function strongerMappingStatus(first, second) {
  const rank = { confirmed: 4, inferred: 3, review: 2, unbound: 1, ignored: 0 };
  return (rank[second] ?? 0) > (rank[first] ?? 0) ? second : first;
}

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}
