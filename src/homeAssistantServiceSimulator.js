import { isHomeAssistantServiceSupported } from "./homeAssistantServiceSupport.js";

export function simulateHcmServiceCalls(accepted = [], home) {
  const checks = accepted.map((item) => simulateHcmServiceCall(item, home));
  return {
    ok: checks.every((check) => check.ok),
    checks,
    rejected: checks.filter((check) => !check.ok).map((check) => ({
      ok: false,
      code: check.code,
      message: check.message,
      action: check.action,
      serviceCall: check.serviceCall,
    })),
  };
}

export function simulateHcmServiceCall(item, home) {
  const serviceCall = item?.serviceCall;
  const entityId = serviceCall?.serviceData?.entity_id;
  const match = findCapabilityByEntity(home, entityId);
  const action = item?.action ?? {
    thingId: item?.thing?.id,
    capabilityId: item?.capability?.id,
    value: item?.action?.value,
  };

  if (!serviceCall?.domain || !serviceCall?.service || !entityId) {
    return rejected("invalid_service_call", "service call is missing domain, service, or entity_id", action, serviceCall);
  }
  if (!match) {
    return rejected("unknown_entity", `${entityId} is not present in current HCM snapshot`, action, serviceCall);
  }
  if (match.thing.online === false) {
    return rejected("thing_offline", `${match.thing.name} is offline`, action, serviceCall, match);
  }
  if (match.capability.binding?.domain !== serviceCall.domain) {
    return rejected(
      "domain_mismatch",
      `${entityId} belongs to ${match.capability.binding?.domain}, not ${serviceCall.domain}`,
      action,
      serviceCall,
      match,
    );
  }

  const supported = isHomeAssistantServiceSupported(serviceCall, match.capability);
  if (!supported.ok) return rejected(supported.code, supported.message, action, serviceCall, match);

  return {
    ok: true,
    code: supported.assumed ? "assumed_supported" : "supported",
    message: supported.assumed
      ? `${serviceCall.domain}.${serviceCall.service} is assumed supported because HA did not expose supported_features`
      : `${serviceCall.domain}.${serviceCall.service} is supported by current HCM evidence`,
    thingId: match.thing.id,
    thingName: match.thing.name,
    capabilityId: match.capability.id,
    capabilityName: match.capability.name,
    service: `${serviceCall.domain}.${serviceCall.service}`,
    serviceCall,
    action,
  };
}

function findCapabilityByEntity(home, entityId) {
  if (!entityId) return null;
  for (const thing of home?.things ?? []) {
    for (const capability of thing.capabilities ?? []) {
      if (capability.binding?.entityId === entityId) return { thing, capability };
    }
  }
  return null;
}

function rejected(code, message, action, serviceCall, match) {
  return {
    ok: false,
    code,
    message,
    thingId: match?.thing.id,
    thingName: match?.thing.name,
    capabilityId: match?.capability.id,
    capabilityName: match?.capability.name,
    service: serviceCall?.domain && serviceCall?.service ? `${serviceCall.domain}.${serviceCall.service}` : undefined,
    action,
    serviceCall,
  };
}
