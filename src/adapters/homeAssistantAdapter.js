import { createDeviceManifest, pickDeviceState, validateActionAgainstManifest } from "../deviceRuntime.js";
import { mapHomeAssistantGraphToHcm } from "./homeAssistantCatalog.js";
import { fetchHomeAssistantGraph } from "./homeAssistantRegistry.js";
import { isHomeAssistantServiceSupported } from "../homeAssistantServiceSupport.js";
import { simulateHcmServiceCall } from "../homeAssistantServiceSimulator.js";
import {
  assertAuthorizedProviderExecution,
  createProviderCommand,
  createProviderIdentity,
  createProviderSnapshotEnvelope,
  defineProviderAdapter,
} from "./providerAdapterSdk.js";

export const HOME_ASSISTANT_ADAPTER_ID = "home_assistant";
const LOW_RISK_CONTROL_TYPES = new Set(["light", "fan", "curtain", "tv"]);

export function createHomeAssistantAdapter({ baseUrl, token, fetchImpl = fetch, graphLoader = fetchHomeAssistantGraph } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const identity = createProviderIdentity({
    id: HOME_ASSISTANT_ADAPTER_ID,
    name: "Home Assistant",
    version: "v0.17",
    transport: "rest+websocket",
  });

  const adapter = {
    id: HOME_ASSISTANT_ADAPTER_ID,
    identity: async () => identity,
    getConnectionStatus: async () => ({
      state: normalizedBaseUrl && token ? "configured" : "unconfigured",
      configured: Boolean(normalizedBaseUrl && token),
      endpoint: normalizedBaseUrl ? redactUrl(normalizedBaseUrl) : null,
    }),
    isConfigured: () => Boolean(normalizedBaseUrl && token),
    getStatus: () => ({
      configured: Boolean(normalizedBaseUrl && token),
      baseUrl: normalizedBaseUrl ? redactUrl(normalizedBaseUrl) : null,
    }),
    async discoverEntities() {
      if (!normalizedBaseUrl || !token) {
        throw new Error("Home Assistant adapter is not configured");
      }

      const response = await fetchImpl(`${normalizedBaseUrl}/api/states`, {
        headers: authHeaders(token),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Home Assistant states request failed ${response.status}: ${text.slice(0, 300)}`);
      }

      const states = await response.json();
      if (!Array.isArray(states)) throw new Error("Home Assistant /api/states did not return an array");

      return states.map(mapHomeAssistantState).filter(Boolean);
    },
    async discoverDeviceGraph() {
      if (!normalizedBaseUrl || !token) {
        throw new Error("Home Assistant adapter is not configured");
      }

      return graphLoader({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
      });
    },
    async discoverSnapshot() {
      if (!normalizedBaseUrl || !token) throw new Error("Home Assistant adapter is not configured");
      const graph = await graphLoader({ baseUrl: normalizedBaseUrl, token, fetchImpl });
      return homeAssistantGraphToProviderSnapshot(graph, identity);
    },
    async discoverHcmHome() {
      if (!normalizedBaseUrl || !token) {
        throw new Error("Home Assistant adapter is not configured");
      }

      const graph = await graphLoader({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
      });
      return mapHomeAssistantGraphToHcm(graph);
    },
    async readEntity(entityId) {
      if (!normalizedBaseUrl || !token) {
        throw new Error("Home Assistant adapter is not configured");
      }

      return readHomeAssistantEntity({ baseUrl: normalizedBaseUrl, token, fetchImpl, entityId });
    },
    async readState(targetId) {
      if (!normalizedBaseUrl || !token) throw new Error("Home Assistant adapter is not configured");
      return readHomeAssistantEntity({ baseUrl: normalizedBaseUrl, token, fetchImpl, entityId: targetId });
    },
    async compileAction(action) {
      if (!normalizedBaseUrl || !token) throw new Error("Home Assistant adapter is not configured");
      const entity = action.entity ?? (action.serviceCall ? null : await readHomeAssistantEntity({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
        entityId: action.entityId,
      }));
      const serviceCall = action.serviceCall ?? buildServiceCall(entity, action);
      return createProviderCommand({
        providerId: HOME_ASSISTANT_ADAPTER_ID,
        target: { id: serviceCall.serviceData?.entity_id ?? action.entityId, type: "entity" },
        operation: `${serviceCall.domain}.${serviceCall.service}`,
        payload: serviceCall.serviceData,
        evidence: action.evidence ?? null,
        idempotencyKey: action.idempotencyKey,
      });
    },
    async simulate(command, context = {}) {
      const serviceCall = providerCommandToHomeAssistantService(command);
      if (context.home && context.item) {
        const hcmCheck = simulateHcmServiceCall({ ...context.item, serviceCall }, context.home);
        return { ...hcmCheck, mode: "simulation", providerId: HOME_ASSISTANT_ADAPTER_ID, commandFingerprint: command.fingerprint };
      }
      const support = isHomeAssistantServiceSupported(serviceCall, command.evidence ? { binding: command.evidence.observations } : undefined);
      return support.ok
        ? { ok: true, mode: "simulation", providerId: HOME_ASSISTANT_ADAPTER_ID, serviceCall, assumed: support.assumed ?? false, commandFingerprint: command.fingerprint }
        : { ok: false, mode: "simulation", providerId: HOME_ASSISTANT_ADAPTER_ID, serviceCall, commandFingerprint: command.fingerprint, ...support };
    },
    async execute(command, context) {
      if (!normalizedBaseUrl || !token) throw new Error("Home Assistant adapter is not configured");
      assertAuthorizedProviderExecution(context, command);
      return executeHomeAssistantServiceCall({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
        serviceCall: providerCommandToHomeAssistantService(command),
      });
    },
  };
  return defineProviderAdapter(adapter);
}

export function homeAssistantGraphToProviderSnapshot(graph, providerIdentity) {
  const provider = providerIdentity ?? createProviderIdentity({
    id: HOME_ASSISTANT_ADAPTER_ID,
    name: "Home Assistant",
    version: "unknown",
    transport: "rest+websocket",
  });
  return createProviderSnapshotEnvelope({
    provider,
    capturedAt: graph.fetchedAt,
    spaces: (graph.areas ?? []).map((area) => ({
      externalId: area.area_id,
      name: area.name ?? area.area_id,
      metadata: { aliases: area.aliases },
    })),
    devices: (graph.devices ?? []).map((device) => ({
      externalId: device.id,
      name: device.name_by_user || device.name || device.id,
      spaceId: device.area_id,
      type: device.model,
      metadata: {
        manufacturer: device.manufacturer,
        model: device.model,
        swVersion: device.sw_version,
        identifiers: device.identifiers,
      },
    })),
    entities: (graph.entities ?? []).map((entity) => ({
      externalId: entity.entity_id,
      name: entity.name || entity.original_name || entity.entity_id,
      deviceId: entity.device_id,
      type: entity.entity_id?.split(".")[0],
      disabled: Boolean(entity.disabled_by),
      metadata: {
        platform: entity.platform,
        translationKey: entity.translation_key,
      },
    })),
    states: (graph.states ?? []).map((state) => ({
      targetId: state.entity_id,
      value: state.state,
      attributes: pickSafeAttributes(state.attributes ?? {}),
    })),
    metadata: { source: "home_assistant_registry" },
  });
}

function providerCommandToHomeAssistantService(command) {
  if (command?.providerId !== HOME_ASSISTANT_ADAPTER_ID) throw new Error("provider command is not for Home Assistant");
  const [domain, service] = String(command.operation ?? "").split(".");
  if (!domain || !service) throw new Error("Home Assistant provider command operation must be domain.service");
  return { domain, service, serviceData: command.payload ?? {} };
}

export async function executeHomeAssistantServiceCall({ baseUrl, token, fetchImpl = fetch, serviceCall }) {
  if (!serviceCall?.domain || !serviceCall?.service) throw new Error("Home Assistant service call is required");
  const response = await fetchImpl(`${baseUrl}/api/services/${serviceCall.domain}/${serviceCall.service}`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(serviceCall.serviceData ?? {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Home Assistant service call failed ${response.status}: ${text.slice(0, 300)}`);
  }

  const changedStates = await response.json();
  return {
    status: "executed",
    adapter: HOME_ASSISTANT_ADAPTER_ID,
    domain: serviceCall.domain,
    service: serviceCall.service,
    serviceData: serviceCall.serviceData,
    changedStates: Array.isArray(changedStates) ? changedStates.map(mapHomeAssistantState).filter(Boolean) : [],
  };
}

export async function executeHomeAssistantAction({ baseUrl, token, fetchImpl = fetch, action }) {
  const entity = await readHomeAssistantEntity({ baseUrl, token, fetchImpl, entityId: action.entityId });
  const serviceCall = buildServiceCall(entity, action);
  const response = await fetchImpl(`${baseUrl}/api/services/${serviceCall.domain}/${serviceCall.service}`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(serviceCall.serviceData),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Home Assistant service call failed ${response.status}: ${text.slice(0, 300)}`);
  }

  const changedStates = await response.json();
  return {
    status: "executed",
    adapter: HOME_ASSISTANT_ADAPTER_ID,
    entityId: entity.entityId,
    domain: serviceCall.domain,
    service: serviceCall.service,
    serviceData: serviceCall.serviceData,
    changedStates: Array.isArray(changedStates) ? changedStates.map(mapHomeAssistantState).filter(Boolean) : [],
  };
}

export async function readHomeAssistantEntity({ baseUrl, token, fetchImpl = fetch, entityId }) {
  if (!entityId || typeof entityId !== "string") throw new Error("entityId is required");
  const response = await fetchImpl(`${baseUrl}/api/states/${encodeURIComponent(entityId)}`, {
    headers: authHeaders(token),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Home Assistant entity request failed ${response.status}: ${text.slice(0, 300)}`);
  }

  return mapHomeAssistantState(await response.json());
}

export function buildServiceCall(entity, action) {
  if (!entity?.manifest) throw new Error("Mapped Home Assistant entity is required");
  if (!LOW_RISK_CONTROL_TYPES.has(entity.manifest.type) || entity.manifest.risk !== "low") {
    throw new Error(`${entity.entityId} is not eligible for low-risk Home Assistant control`);
  }

  const validation = validateActionAgainstManifest(
    {
      device_id: entity.manifest.id,
      capability: action.capability,
      value: action.value,
    },
    entity.manifest,
  );
  if (!validation.ok) throw new Error(validation.message);
  if (validation.action.risk !== "low" || validation.action.confirmation !== "never") {
    throw new Error(`${entity.entityId} requires confirmation and cannot be auto-executed by v0.3.1`);
  }

  const serviceCall = mapCapabilityToService(entity, validation.action);
  if (!serviceCall) throw new Error(`${entity.entityId} does not support ${action.capability} through v0.3.1`);
  return serviceCall;
}

export function mapHomeAssistantState(state) {
  const [domain, objectId] = String(state.entity_id ?? "").split(".");
  if (!domain || !objectId) return null;

  const type = mapDomainToType(domain, state);
  const harnessDevice = createHarnessDeviceFromState({ state, domain, objectId, type });

  return {
    entityId: state.entity_id,
    domain,
    name: harnessDevice.name,
    state: state.state,
    attributes: pickSafeAttributes(state.attributes ?? {}),
    suggestedDevice: harnessDevice,
    manifest: createDeviceManifest(harnessDevice, HOME_ASSISTANT_ADAPTER_ID),
  };
}

function mapCapabilityToService(entity, action) {
  const serviceData = { entity_id: entity.entityId };
  if (action.capability === "turn_on") {
    return { domain: entity.domain, service: "turn_on", serviceData };
  }
  if (action.capability === "turn_off") {
    return { domain: entity.domain, service: "turn_off", serviceData };
  }
  if (action.capability === "set_brightness" && entity.domain === "light") {
    return {
      domain: "light",
      service: "turn_on",
      serviceData: { ...serviceData, brightness_pct: action.value },
    };
  }
  if (action.capability === "set_speed" && entity.domain === "fan") {
    return {
      domain: "fan",
      service: "set_percentage",
      serviceData: { ...serviceData, percentage: Math.round((action.value / 3) * 100) },
    };
  }
  if (action.capability === "set_position" && entity.domain === "cover") {
    return {
      domain: "cover",
      service: "set_cover_position",
      serviceData: { ...serviceData, position: action.value },
    };
  }
  return null;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function createHarnessDeviceFromState({ state, domain, objectId, type }) {
  const attributes = state.attributes ?? {};
  const name = attributes.friendly_name || objectId.replace(/_/g, " ");
  const id = `ha_${state.entity_id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const base = {
    id,
    name,
    roomId: inferRoomId(name, objectId),
    type,
    risk: inferRisk(type, domain, name),
    online: state.state !== "unavailable" && state.state !== "unknown",
  };

  if (["light", "switch", "fan", "tv", "gas_heater", "camera"].includes(type)) {
    base.on = ["on", "playing"].includes(state.state);
  }
  if (type === "light") base.brightness = Math.round(((attributes.brightness ?? 0) / 255) * 100);
  if (type === "ac") {
    base.on = state.state !== "off";
    base.temperature = Number(attributes.temperature ?? attributes.current_temperature ?? 25);
    base.mode = state.state;
  }
  if (type === "fan") base.speed = state.state === "on" ? 1 : 0;
  if (type === "curtain" || type === "drying_rack") {
    base.position = Number(attributes.current_position ?? (state.state === "open" ? 100 : 0));
  }
  if (type === "robot_vacuum") {
    base.status = state.state === "cleaning" ? "cleaning" : "docked";
    base.battery = Number(attributes.battery_level ?? 100);
  }
  if (type === "washer" || type === "dryer") {
    base.status = state.state === "on" || state.state === "running" ? "running" : "idle";
    base.minutesLeft = 0;
  }
  if (type === "presence_sensor" || type === "motion_sensor") {
    base.detected = ["on", "home", "detected", "motion"].includes(state.state);
  }
  if (type === "door_sensor") base.open = state.state === "on" || state.state === "open";
  if (type === "pet_feeder") {
    base.portionsToday = 0;
    base.lastFeed = "--:--";
  }
  if (type === "generic_sensor" || type === "generic_entity") {
    base.value = String(state.state ?? "");
    if (attributes.unit_of_measurement) base.unit = attributes.unit_of_measurement;
  }

  return base;
}

function mapDomainToType(domain, state) {
  const name = `${state.entity_id} ${state.attributes?.friendly_name ?? ""}`.toLowerCase();
  if (domain === "light") return "light";
  if (domain === "fan") return "fan";
  if (domain === "climate") return /water|heater|热水|燃气/.test(name) ? "gas_heater" : "ac";
  if (domain === "cover") return /dry|rack|晾衣|衣杆/.test(name) ? "drying_rack" : "curtain";
  if (domain === "media_player") return "tv";
  if (domain === "vacuum") return "robot_vacuum";
  if (domain === "camera") return "camera";
  if (domain === "switch") return mapSwitchType(name);
  if (domain === "binary_sensor") return mapBinarySensorType(state);
  if (domain === "sensor") return "generic_sensor";
  if (domain === "person" || domain === "device_tracker") return "presence_sensor";
  return "generic_entity";
}

function mapSwitchType(name) {
  if (/washer|洗衣/.test(name)) return "washer";
  if (/dryer|烘干/.test(name)) return "dryer";
  if (/feeder|cat|pet|猫粮|投喂/.test(name)) return "pet_feeder";
  if (/heater|热水|燃气/.test(name)) return "gas_heater";
  return "switch";
}

function mapBinarySensorType(state) {
  const deviceClass = state.attributes?.device_class;
  if (["door", "window", "opening", "garage_door"].includes(deviceClass)) return "door_sensor";
  if (["motion", "occupancy"].includes(deviceClass)) return "motion_sensor";
  if (["presence"].includes(deviceClass)) return "presence_sensor";
  return "presence_sensor";
}

function inferRisk(type, domain, name) {
  if (["gas_heater"].includes(type) || /燃气|gas/.test(name)) return "high";
  if (["camera", "presence_sensor", "motion_sensor", "door_sensor"].includes(type)) return "sensitive";
  if (["washer", "dryer", "robot_vacuum", "pet_feeder", "drying_rack"].includes(type)) return "medium";
  if (["lock", "alarm_control_panel"].includes(domain)) return "high";
  if (domain === "switch" && /heater|热水/.test(name)) return "high";
  return "low";
}

function inferRoomId(name, objectId) {
  const text = `${name} ${objectId}`.toLowerCase();
  if (/entry|玄关|门口/.test(text)) return "entry";
  if (/living|客厅/.test(text)) return "living";
  if (/dining|餐厅/.test(text)) return "dining";
  if (/kitchen|厨房/.test(text)) return "kitchen";
  if (/study|书房/.test(text)) return "study";
  if (/master|主卧/.test(text)) return "master";
  if (/second|次卧/.test(text)) return "second";
  if (/bath|浴室|卫生间/.test(text)) return "bath";
  if (/balcony|阳台/.test(text)) return "balcony";
  return "living";
}

function pickSafeAttributes(attributes) {
  const safe = {};
  for (const key of [
    "friendly_name",
    "device_class",
    "brightness",
    "temperature",
    "current_temperature",
    "current_position",
    "battery_level",
    "supported_features",
  ]) {
    if (key in attributes) safe[key] = attributes[key];
  }
  return safe;
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  return String(baseUrl).replace(/\/$/, "");
}

function redactUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return baseUrl;
  }
}
