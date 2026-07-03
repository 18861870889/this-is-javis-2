import { CAPABILITY_KINDS, POLICY_LEVELS, createHcmHome, stableId } from "../hcm.js";
import { attachHcmControlGraph } from "../hcmControlGraph.js";
import { createCapabilityEvidence } from "./providerAdapterSdk.js";

const CONTROL_DOMAINS = new Set(["light", "switch", "fan", "cover", "climate", "media_player", "vacuum"]);
const SENSOR_DOMAINS = new Set(["sensor", "binary_sensor", "event"]);
const ACTION_DOMAINS = new Set(["button", "select", "number", "text"]);

const ROOM_ALIASES = [
  ["entry", /入户|玄关|门口/],
  ["living", /客厅|大厅|沙发/],
  ["dining", /餐厅|餐边/],
  ["kitchen", /厨房/],
  ["study", /书房/],
  ["master_bath", /主卧卫生间|主卫/],
  ["bath", /公共卫生间|公卫|洗手台|卫生间/],
  ["balcony", /阳台/],
  ["cat_room", /猫猫房|猫房/],
  ["second", /次卧|小孩房|儿童房/],
  ["master", /主卧/],
];

const BLOCKED_CONFIG_PATTERN =
  /密码|password|互控|解控|绑定状态|遥控器绑定|灵动|配置|config|时间段|screen|layout|物理控制锁|童锁|延时/;
const LIGHT_NAME_PATTERN = /灯|灯带|射灯|筒灯|吊灯|台灯|主灯|壁灯/;
const CAMERA_PATTERN = /camera|摄像|监控/;
const FEEDER_PATTERN = /feeder|猫粮|投喂|喂食/;
const GAS_PATTERN = /燃气|gas|热水器/;
const LOCK_PATTERN = /门锁|锁|door.?lock|lock/;
const GAS_VALVE_PATTERN = /燃气阀|gas.?valve/;
const WATER_VALVE_PATTERN = /水阀|阀门|water.?valve|valve/;

export function mapHomeAssistantGraphToHcm(graph) {
  const areas = mapAreas(graph.areas ?? []);
  const states = new Map((graph.states ?? []).map((state) => [state.entity_id, state]));
  const entitiesByDevice = groupEntitiesByDevice(graph.entities ?? []);
  const provider = graph.provider ?? { id: "home_assistant", name: "Home Assistant" };

  const things = [];
  const unresolvedBindings = [];

  for (const device of graph.devices ?? []) {
    const deviceEntities = (entitiesByDevice.get(device.id) ?? []).filter((entity) => !entity.disabled_by);
    if (!isProviderDevice(device, deviceEntities)) continue;
    if (deviceEntities.length === 0) continue;

    const space = resolveSpace(device, areas);
    const thingType = inferThingType(device, deviceEntities);
    const thing = {
      id: `ha_${device.id}`,
      name: device.name_by_user || device.name || "未命名设备",
      type: thingType,
      spaceId: space.id,
      online: isDeviceOnline(deviceEntities, states),
      policy: inferThingPolicy(thingType, device),
      provider: {
        id: provider.id,
        deviceId: device.id,
        manufacturer: device.manufacturer,
        model: device.model,
        swVersion: device.sw_version,
        identifiers: device.identifiers,
      },
      capabilities: [],
    };

    for (const entity of deviceEntities) {
      const state = states.get(entity.entity_id);
      const capabilities = mapEntityToCapabilities({ entity, state, thingType, device });
      for (const capability of capabilities) {
        thing.capabilities.push(capability);
        if (capability.policy.risk !== POLICY_LEVELS.LOW || capability.policy.autoExecutable === false) {
          unresolvedBindings.push(...createUnresolvedBinding({ device, entity, capability, thing, state }));
        }
      }
    }

    thing.state = summarizeThingState(thing);
    things.push(thing);
  }

  const home = createHcmHome({
    provider,
    spaces: Array.from(areas.values()),
    things,
    unresolvedBindings: dedupeUnresolved(unresolvedBindings),
    syncedAt: graph.fetchedAt,
  });
  return attachHcmControlGraph(home);
}

function mapAreas(areas) {
  const mapped = new Map();
  for (const area of areas) {
    const id = normalizeRoomId(area.name || area.area_id);
    mapped.set(area.area_id, {
      id,
      name: cleanAreaName(area.name || area.area_id),
      aliases: area.aliases ?? [],
      provider: {
        id: "home_assistant",
        areaId: area.area_id,
      },
    });
  }
  mapped.set("unknown", { id: "unknown", name: "未分区", aliases: [] });
  return mapped;
}

function groupEntitiesByDevice(entities) {
  const grouped = new Map();
  for (const entity of entities) {
    if (!entity.device_id) continue;
    if (!grouped.has(entity.device_id)) grouped.set(entity.device_id, []);
    grouped.get(entity.device_id).push(entity);
  }
  return grouped;
}

const SUPPORTED_PLATFORMS = new Set([
  "xiaomi_home",
  "roborock",
]);

function isProviderDevice(device, entities) {
  const identifiers = device.identifiers ?? [];
  // Include devices from supported platforms
  if (identifiers.some(([domain]) => SUPPORTED_PLATFORMS.has(domain))) return true;
  if (entities.some((entity) => entity.platform && SUPPORTED_PLATFORMS.has(entity.platform))) return true;
  // Also include devices with controllable domains (vacuum, climate, cover, fan, light, switch, media_player)
  const controllableDomains = new Set(["vacuum", "climate", "cover", "fan", "light", "switch", "media_player"]);
  if (entities.some((entity) => controllableDomains.has(entity.entity_id.split(".")[0]))) return true;
  return false;
}

function resolveSpace(device, areas) {
  return areas.get(device.area_id) ?? areas.get("unknown");
}

function inferThingType(device, entities) {
  const text = `${device.name ?? ""} ${device.model ?? ""} ${device.manufacturer ?? ""}`.toLowerCase();
  const domains = new Set(entities.map((entity) => entity.entity_id.split(".")[0]));

  if (LOCK_PATTERN.test(text) || domains.has("lock")) return "lock";
  if (GAS_VALVE_PATTERN.test(text)) return "gas_valve";
  if (WATER_VALVE_PATTERN.test(text) || domains.has("valve")) return "water_valve";
  if (GAS_PATTERN.test(text)) return "gas_heater";
  if (FEEDER_PATTERN.test(text)) return "pet_feeder";
  if (CAMERA_PATTERN.test(text)) return "camera";
  if (/curtain|窗帘|纱/.test(text) || domains.has("cover")) return "curtain";
  if (/aircondition|空调/.test(text) || domains.has("climate")) return "ac";
  if (/fan|风扇/.test(text) || domains.has("fan")) return "fan";
  if (/tv|电视/.test(text) || domains.has("media_player")) return "tv";
  if (/vacuum|扫地/.test(text) || domains.has("vacuum")) return "robot_vacuum";
  if (/occupy|presence|人在/.test(text)) return "presence_sensor";
  if (/motion|人体/.test(text)) return "motion_sensor";
  if (/magnet|door|门|窗/.test(text)) return "door_sensor";
  if (/switch|开关|妙控/.test(text) || domains.has("switch")) return "switch_panel";
  if (/gateway|网关|router|路由/.test(text)) return "hub";
  if (/scale|体脂秤/.test(text)) return "scale";
  return "generic_device";
}

function mapEntityToCapabilities({ entity, state, thingType, device }) {
  const domain = entity.entity_id.split(".")[0];
  const name = entity.name || entity.original_name || state?.attributes?.friendly_name || entity.entity_id;
  const base = {
    id: capabilityId(entity),
    name: cleanCapabilityName(name),
    valueType: valueTypeForDomain(domain),
    state: normalizeStateValue(state),
    unit: state?.attributes?.unit_of_measurement,
    binding: createBinding(entity, domain, state),
    evidence: createCapabilityEvidence({
      providerId: "home_assistant",
      targetId: entity.entity_id,
      source: "registry_and_state",
      capability: cleanCapabilityName(name),
      observations: {
        domain,
        platform: entity.platform,
        deviceClass: state?.attributes?.device_class,
        currentState: state?.state,
        supportedFeatures: state?.attributes?.supported_features,
      },
      commands: serviceCandidatesForDomain(domain),
      constraints: {
        min: state?.attributes?.min,
        max: state?.attributes?.max,
        step: state?.attributes?.step,
        unit: state?.attributes?.unit_of_measurement,
      },
      confidence: state ? 0.95 : 0.72,
    }),
  };

  if (CONTROL_DOMAINS.has(domain)) {
    return [
      {
        ...base,
        kind: CAPABILITY_KINDS.CONTROL,
        policy: policyForControl({ domain, name, thingType, device }),
      },
    ];
  }

  if (SENSOR_DOMAINS.has(domain)) {
    return [
      {
        ...base,
        kind: CAPABILITY_KINDS.SENSOR,
        policy: {
          risk: sensorRisk(thingType),
          confirmation: "never",
          autoExecutable: false,
          reason: "状态输入，不执行动作",
        },
      },
    ];
  }

  if (ACTION_DOMAINS.has(domain)) {
    return [
      {
        ...base,
        kind: actionKind(domain, name),
        policy: policyForAction({ domain, name, thingType }),
      },
    ];
  }

  return [
    {
      ...base,
      kind: CAPABILITY_KINDS.SENSOR,
      policy: {
        risk: POLICY_LEVELS.LOW,
        confirmation: "never",
        autoExecutable: false,
        reason: "未知 domain 默认只读",
      },
    },
  ];
}

function serviceCandidatesForDomain(domain) {
  const services = {
    light: ["light.turn_on", "light.turn_off"],
    switch: ["switch.turn_on", "switch.turn_off"],
    fan: ["fan.turn_on", "fan.turn_off", "fan.set_percentage"],
    cover: ["cover.open_cover", "cover.close_cover", "cover.set_cover_position"],
    climate: ["climate.turn_on", "climate.turn_off", "climate.set_temperature"],
    media_player: ["media_player.media_play", "media_player.media_pause", "media_player.media_stop", "media_player.turn_off"],
    vacuum: ["vacuum.start", "vacuum.return_to_base"],
    button: ["button.press"],
  };
  return services[domain] ?? [];
}

function capabilityId(entity) {
  const [, objectId] = entity.entity_id.split(".");
  return stableId(entity.translation_key || entity.original_name || entity.name || objectId);
}

function createBinding(entity, domain, state) {
  return {
    provider: "home_assistant",
    entityId: entity.entity_id,
    domain,
    platform: entity.platform,
    deviceId: entity.device_id,
    supportedFeatures:
      typeof state?.attributes?.supported_features === "number" ? state.attributes.supported_features : undefined,
    currentState: state?.state,
  };
}

function policyForControl({ domain, name, thingType, device }) {
  const text = `${name} ${device.name ?? ""} ${device.model ?? ""}`.toLowerCase();
  if (["gas_heater", "water_heater", "gas_valve", "water_valve", "valve", "lock", "alarm_control_panel"].includes(thingType)) {
    return blocked(POLICY_LEVELS.HIGH, "门锁/燃气/水阀等安全关键设备默认禁止自动控制");
  }
  if (thingType === "camera") {
    return blocked(POLICY_LEVELS.SENSITIVE, "摄像头相关控制需要明确授权");
  }
  if (domain === "switch" && BLOCKED_CONFIG_PATTERN.test(text)) {
    return blocked(POLICY_LEVELS.HIGH, "设备配置项禁止由 AI 自动修改");
  }
  if (thingType === "switch_panel" && domain === "switch" && !LIGHT_NAME_PATTERN.test(text)) {
    return {
      risk: POLICY_LEVELS.MEDIUM,
      confirmation: "sometimes",
      autoExecutable: false,
      reason: "开关通道语义不清，需要用户确认命名",
    };
  }
  if (["light", "fan", "cover", "climate", "media_player"].includes(domain)) {
    return {
      risk: POLICY_LEVELS.LOW,
      confirmation: "never",
      autoExecutable: true,
      reason: "低风险基础控制",
    };
  }
  if (domain === "switch" && LIGHT_NAME_PATTERN.test(text)) {
    return {
      risk: POLICY_LEVELS.LOW,
      confirmation: "never",
      autoExecutable: true,
      reason: "开关通道明确对应照明",
    };
  }
  return {
    risk: POLICY_LEVELS.MEDIUM,
    confirmation: "sometimes",
    autoExecutable: false,
    reason: "可控实体需要语义确认",
  };
}

function policyForAction({ domain, name, thingType }) {
  const text = name.toLowerCase();
  if (domain === "text" || BLOCKED_CONFIG_PATTERN.test(text)) {
    return blocked(POLICY_LEVELS.HIGH, "配置/文本字段禁止自动写入");
  }
  if (thingType === "pet_feeder") {
    return {
      risk: POLICY_LEVELS.MEDIUM,
      confirmation: "always",
      autoExecutable: false,
      reason: "投喂类动作需要确认",
    };
  }
  if (thingType === "camera") {
    return blocked(POLICY_LEVELS.SENSITIVE, "摄像头动作默认阻断");
  }
  return {
    risk: POLICY_LEVELS.MEDIUM,
    confirmation: "sometimes",
    autoExecutable: false,
    reason: "button/select/number 需要确认后再开放",
  };
}

function actionKind(domain, name) {
  if (domain === "button") return CAPABILITY_KINDS.ACTION;
  if (BLOCKED_CONFIG_PATTERN.test(name)) return CAPABILITY_KINDS.CONFIG;
  return domain === "select" || domain === "number" || domain === "text" ? CAPABILITY_KINDS.CONFIG : CAPABILITY_KINDS.ACTION;
}

function blocked(risk, reason) {
  return {
    risk,
    confirmation: "always",
    autoExecutable: false,
    reason,
  };
}

function sensorRisk(thingType) {
  if (["presence_sensor", "motion_sensor", "door_sensor", "camera"].includes(thingType)) return POLICY_LEVELS.SENSITIVE;
  return POLICY_LEVELS.LOW;
}

function valueTypeForDomain(domain) {
  if (domain === "number") return "number";
  if (domain === "select") return "enum";
  if (domain === "button" || domain === "event") return "event";
  if (domain === "text") return "text";
  if (domain === "binary_sensor" || domain === "switch" || domain === "light") return "boolean";
  return "unknown";
}

function normalizeStateValue(state) {
  if (!state) return undefined;
  if (state.state === "on") return true;
  if (state.state === "off") return false;
  if (/^-?\d+(\.\d+)?$/.test(state.state)) return Number(state.state);
  return state.state;
}

function summarizeThingState(thing) {
  const controls = thing.capabilities.filter((capability) => capability.kind === CAPABILITY_KINDS.CONTROL);
  const sensors = thing.capabilities.filter((capability) => capability.kind === CAPABILITY_KINDS.SENSOR);
  return {
    online: thing.online,
    controllable: controls.length,
    readable: sensors.length,
    autoExecutable: controls.filter((capability) => capability.policy.autoExecutable).length,
  };
}

function isDeviceOnline(entities, states) {
  const knownStates = entities.map((entity) => states.get(entity.entity_id)?.state).filter(Boolean);
  return knownStates.some((state) => !["unavailable", "unknown"].includes(state));
}

function inferThingPolicy(type, device) {
  const text = `${device.name ?? ""} ${device.model ?? ""}`;
  if (["gas_heater", "water_heater", "gas_valve", "water_valve", "valve", "lock", "alarm_control_panel"].includes(type) || GAS_PATTERN.test(text)) {
    return blocked(POLICY_LEVELS.HIGH, "高风险设备");
  }
  if (["camera", "presence_sensor", "motion_sensor", "door_sensor"].includes(type)) {
    return blocked(POLICY_LEVELS.SENSITIVE, "敏感设备");
  }
  if (["pet_feeder", "robot_vacuum"].includes(type)) {
    return {
      risk: POLICY_LEVELS.MEDIUM,
      confirmation: "always",
      autoExecutable: false,
      reason: "需要用户确认的中风险设备",
    };
  }
  return {
    risk: POLICY_LEVELS.LOW,
    confirmation: "never",
    autoExecutable: true,
    reason: "低风险设备",
  };
}

function createUnresolvedBinding({ device, entity, capability, thing, state }) {
  if (capability.kind === CAPABILITY_KINDS.SENSOR && capability.policy.risk === POLICY_LEVELS.LOW) return [];
  return [
    {
      id: `${thing.id}:${capability.id}`,
      thingId: thing.id,
      thingName: thing.name,
      thingType: thing.type,
      spaceId: thing.spaceId,
      entityId: entity.entity_id,
      entityName: capability.name,
      kind: capability.kind,
      valueType: capability.valueType,
      currentState: state?.state,
      reason: capability.policy.reason,
      suggestedRisk: capability.policy.risk,
      confirmation: capability.policy.confirmation,
      autoExecutable: capability.policy.autoExecutable,
    },
  ];
}

function dedupeUnresolved(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function normalizeRoomId(name) {
  const cleaned = cleanAreaName(name);
  for (const [id, pattern] of ROOM_ALIASES) {
    if (pattern.test(cleaned)) return id;
  }
  return stableId(cleaned || "unknown");
}

function cleanAreaName(name) {
  return String(name ?? "未分区")
    .replace(/^.*的窝\s*/, "")
    .trim() || "未分区";
}

function cleanCapabilityName(name) {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .replace(/^\* /, "")
    .trim();
}
