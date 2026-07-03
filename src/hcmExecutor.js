import { CAPABILITY_KINDS, POLICY_LEVELS } from "./hcm.js";
import { mediaPlayerServiceForBoolean } from "./homeAssistantServiceSupport.js";

const EXECUTABLE_DOMAINS = new Set(["light", "switch", "fan", "cover", "climate", "media_player", "button"]);

export function validateHcmAction(action, home) {
  const thing = home?.things?.find((item) => item.id === action?.thingId || item.id === action?.device_id);
  if (!thing) return rejected(action, "unknown_thing", `Unknown HCM thing ${action?.thingId ?? action?.device_id ?? ""}`);

  const capabilityId = action.capabilityId ?? action.capability;
  const capability = thing.capabilities.find((item) => item.id === capabilityId);
  if (!capability) return rejected(action, "unknown_capability", `${thing.name} does not expose ${capabilityId}`);

  if (!isAutoExecutable(capability)) {
    return rejected(action, "policy_blocked", `${thing.name} ${capability.name} is not auto executable`);
  }

  const domain = capability.binding?.domain;
  const providerId = capability.binding?.provider ?? thing.provider?.id ?? home?.provider?.id;
  const providerTargetId = capability.binding?.targetId ?? capability.binding?.deviceId ?? capability.binding?.entityId;
  const usesHomeAssistantBinding = providerId === "home_assistant" || Boolean(capability.binding?.entityId);
  if (usesHomeAssistantBinding && !EXECUTABLE_DOMAINS.has(domain)) {
    return rejected(action, "unsupported_domain", `${domain ?? "unknown"} is not supported by HCM executor`);
  }
  if (!usesHomeAssistantBinding && (!providerId || !providerTargetId)) {
    return rejected(action, "invalid_provider_binding", `${thing.name} does not expose a stable provider target`);
  }

  const normalizedValue = normalizeActionValue(action.value, capability);
  const serviceCall = usesHomeAssistantBinding
    ? mapHcmActionToHomeAssistantService({ thing, capability, value: normalizedValue })
    : null;
  if (usesHomeAssistantBinding && !serviceCall) {
    return rejected(action, "unsupported_value", `${thing.name} ${capability.name} cannot execute value ${normalizedValue}`);
  }

  return {
    ok: true,
    thing,
    capability,
    action: {
      thingId: thing.id,
      thingName: action.logicalAssetName ?? action.thingName ?? thing.name,
      providerThingName: thing.name,
      logicalAssetId: action.logicalAssetId,
      logicalAssetName: action.logicalAssetName,
      logicalRoomId: action.logicalRoomId,
      capabilityId: capability.id,
      capabilityName: capability.name,
      value: normalizedValue,
      entityId: capability.binding.entityId,
      targetId: providerTargetId,
      providerId,
      domain,
    },
    serviceCall,
  };
}

export function buildHcmExecutionPlan(actions, home) {
  const accepted = [];
  const rejectedActions = [];

  for (const action of actions ?? []) {
    const result = validateHcmAction(action, home);
    if (result.ok) accepted.push(result);
    else rejectedActions.push(result);
  }

  return {
    ok: accepted.length > 0,
    accepted,
    rejected: rejectedActions,
  };
}

export function mapHcmActionToHomeAssistantService({ capability, value }) {
  const domain = capability.binding?.domain;
  const entityId = capability.binding?.entityId;
  if (!domain || !entityId) return null;

  const serviceData = { entity_id: entityId };

  if (domain === "button") {
    if (value === false) return null;
    return { domain, service: "press", serviceData };
  }

  if (typeof value === "boolean") {
    if (domain === "cover") {
      return { domain, service: value ? "open_cover" : "close_cover", serviceData };
    }
    if (domain === "media_player" && value === false) {
      return { domain, service: mediaPlayerServiceForBoolean(value, capability), serviceData };
    }
    if (domain === "media_player" && value === true) {
      return { domain, service: mediaPlayerServiceForBoolean(value, capability), serviceData };
    }
    return { domain, service: value ? "turn_on" : "turn_off", serviceData };
  }

  if (typeof value !== "number" || Number.isNaN(value)) return null;

  if (domain === "climate") {
    return { domain, service: "set_temperature", serviceData: { ...serviceData, temperature: value } };
  }
  if (domain === "cover") {
    return { domain, service: "set_cover_position", serviceData: { ...serviceData, position: clamp(value, 0, 100) } };
  }
  if (domain === "light") {
    return { domain, service: "turn_on", serviceData: { ...serviceData, brightness_pct: clamp(value, 0, 100) } };
  }
  if (domain === "fan") {
    return { domain, service: "set_percentage", serviceData: { ...serviceData, percentage: clamp(value, 0, 100) } };
  }

  return null;
}

function isAutoExecutable(capability) {
  if (![CAPABILITY_KINDS.CONTROL, CAPABILITY_KINDS.ACTION].includes(capability.kind)) return false;
  if (!capability.policy?.autoExecutable) return false;
  if (capability.policy.risk !== POLICY_LEVELS.LOW) return false;
  return capability.policy.confirmation === "never";
}

function normalizeActionValue(value, capability) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  if (capability.binding?.domain === "button") return value !== false;
  return value;
}

function rejected(action, code, message) {
  return {
    ok: false,
    code,
    message,
    action,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
