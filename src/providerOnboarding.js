import { mapHomeAssistantGraphToHcm } from "./adapters/homeAssistantCatalog.js";
import { mapHcmActionToHomeAssistantService } from "./hcmExecutor.js";
import { simulateHcmServiceCalls } from "./homeAssistantServiceSimulator.js";
import { diffHcmHomes } from "./providerSync.js";

const ONBOARDING_VERSION = "0.1";
const PROTECTED_THING_TYPES = new Set(["camera", "gas_heater", "water_heater"]);
const REVIEW_THING_TYPES = new Set(["pet_feeder", "robot_vacuum", "washer", "dryer", "switch_panel", "generic_device"]);
const UNCLEAR_NAME_PATTERN = /未定义|未绑定|未知|未命名|互控|配置|密码|password|重置|reset|校准/i;
const CLEAR_LOW_RISK_PATTERN = /灯|灯带|射灯|筒灯|台灯|窗帘|空调|风扇|音箱|电视|light|curtain|cover|climate|fan|speaker|tv/i;

export function diffProviderGraphs(previousGraph, nextGraph) {
  const previous = normalizeProviderGraph(previousGraph);
  const next = normalizeProviderGraph(nextGraph);
  const events = [
    ...diffRecords("device", previous.devices, next.devices, diffDeviceRecord),
    ...diffRecords("entity", previous.entities, next.entities, diffEntityRecord),
    ...diffRecords("area", previous.areas, next.areas, diffAreaRecord),
    ...diffRecords("state", previous.states, next.states, diffStateRecord),
  ];

  return {
    version: ONBOARDING_VERSION,
    summary: summarizeProviderDiff(events),
    events,
  };
}

export function planProviderOnboarding({
  previousGraph,
  nextGraph,
  currentHome,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!nextGraph && !currentHome) throw new Error("nextGraph or currentHome is required");
  const providerDiff = nextGraph ? diffProviderGraphs(previousGraph, nextGraph) : emptyProviderDiff();
  const previousHome = previousGraph ? mapHomeAssistantGraphToHcm(previousGraph) : null;
  const nextHome = currentHome ?? mapHomeAssistantGraphToHcm(nextGraph);
  const hcmEvents = nextHome ? diffHcmHomes(previousHome, nextHome) : [];
  const eventsByThing = groupHcmEventsByThing(hcmEvents);
  const eventThingIds = new Set(eventsByThing.keys());
  const shouldIncludeAll = !previousGraph;

  const candidates = (nextHome?.things ?? [])
    .filter((thing) => shouldIncludeAll || eventThingIds.has(thing.id))
    .map((thing) =>
      createOnboardingCandidate({
        thing,
        home: nextHome,
        events: eventsByThing.get(thing.id) ?? [],
        generatedAt,
      }),
    )
    .sort(compareCandidates);

  const removed = hcmEvents
    .filter((event) => event.type === "thing.removed" || event.type === "capability.removed")
    .map((event) => ({
      ...event,
      action: "remove_from_planner",
      requiresReview: false,
      reason: "provider 中已删除，后续不应继续暴露给 LLM",
    }));

  return {
    version: ONBOARDING_VERSION,
    generatedAt,
    mode: "proposal",
    provider: nextHome?.provider ?? nextGraph?.provider ?? { id: "unknown", name: "Unknown Provider" },
    diff: providerDiff,
    hcmEvents,
    summary: {
      candidateCount: candidates.length,
      reviewCount: candidates.filter((candidate) => candidate.requiresReview).length,
      allowAutoCandidates: candidates.filter((candidate) => candidate.proposedAction === "allow_auto_candidate").length,
      protectCount: candidates.filter((candidate) => candidate.proposedAction === "protect").length,
      removedCount: removed.length,
    },
    candidates,
    reviewItems: candidates.filter((candidate) => candidate.requiresReview),
    removed,
    overlayProposals: candidates.flatMap((candidate) => candidate.overlayProposals),
  };
}

function createOnboardingCandidate({ thing, home, events, generatedAt }) {
  const capabilityProposals = thing.capabilities.map((capability) => ({
    capabilityId: capability.id,
    capabilityName: capability.name,
    kind: capability.kind,
    valueType: capability.valueType,
    entityId: capability.binding?.entityId,
    domain: capability.binding?.domain,
    risk: capability.policy?.risk ?? "low",
    autoExecutable: Boolean(capability.policy?.autoExecutable),
    reason: capability.policy?.reason ?? "",
  }));
  const proposedAction = classifyThingCandidate(thing);
  const requiresReview = proposedAction === "review" || proposedAction === "protect";
  const autoExecutableCapabilities = thing.capabilities.filter(
    (capability) => capability.policy?.autoExecutable && ["control", "action"].includes(capability.kind),
  );
  const simulation = simulateCandidateCapabilities(thing, autoExecutableCapabilities, home);

  return {
    id: `onboard_${thing.id}`,
    type: events.some((event) => event.type === "thing.added") ? "new_thing" : "changed_thing",
    thingId: thing.id,
    thingName: thing.name,
    suggestedType: thing.type,
    spaceId: thing.spaceId,
    risk: highestRisk([thing.policy?.risk, ...thing.capabilities.map((capability) => capability.policy?.risk)]),
    proposedAction,
    requiresReview,
    confidence: candidateConfidence(thing, events),
    reason: candidateReason(thing, proposedAction),
    eventTypes: events.map((event) => event.type),
    capabilityProposals,
    simulation,
    overlayProposals: createOverlayProposals(thing, proposedAction, generatedAt),
  };
}

function classifyThingCandidate(thing) {
  const text = `${thing.name} ${thing.type} ${thing.capabilities.map((capability) => capability.name).join(" ")}`;
  if (PROTECTED_THING_TYPES.has(thing.type)) return "protect";
  if (UNCLEAR_NAME_PATTERN.test(text)) return "protect";
  if (thing.capabilities.some((capability) => ["high", "sensitive"].includes(capability.policy?.risk))) return "protect";
  if (isClearLowRiskThing(thing, text)) return "allow_auto_candidate";
  if (REVIEW_THING_TYPES.has(thing.type)) return "review";
  if (thing.capabilities.some((capability) => capability.policy?.risk === "medium")) return "review";
  if (thing.capabilities.some((capability) => capability.kind === "config")) return "protect";
  if (thing.capabilities.some((capability) => capability.policy?.autoExecutable)) return "allow_auto_candidate";
  return "read_only";
}

function isClearLowRiskThing(thing, text) {
  const executable = thing.capabilities.filter((capability) => ["control", "action"].includes(capability.kind));
  if (executable.length === 0) return false;
  if (!CLEAR_LOW_RISK_PATTERN.test(text)) return false;
  return executable.every((capability) => capability.policy?.risk === "low" && capability.policy?.autoExecutable);
}

function candidateReason(thing, proposedAction) {
  if (proposedAction === "allow_auto_candidate") return "低风险、语义明确，可作为自动执行候选";
  if (proposedAction === "read_only") return "只读能力，不进入真实执行";
  if (proposedAction === "protect") return "高风险、隐私、配置或语义不清，默认保护";
  return `${thing.type} 需要用户确认能力边界`;
}

function candidateConfidence(thing, events) {
  if (UNCLEAR_NAME_PATTERN.test(`${thing.name} ${thing.capabilities.map((capability) => capability.name).join(" ")}`)) return 0.42;
  if (events.some((event) => event.type === "thing.added")) return 0.76;
  if (events.some((event) => event.type === "capability.added")) return 0.68;
  return 0.62;
}

function simulateCandidateCapabilities(thing, capabilities, home) {
  const accepted = capabilities
    .map((capability) => {
      const value = sampleValueForCapability(capability);
      const serviceCall = mapHcmActionToHomeAssistantService({ capability, value });
      if (!serviceCall) return null;
      return {
        thing,
        capability,
        action: { thingId: thing.id, capabilityId: capability.id, value },
        serviceCall,
      };
    })
    .filter(Boolean);
  if (accepted.length === 0) return { ok: true, checks: [], rejected: [] };
  return simulateHcmServiceCalls(accepted, home);
}

function sampleValueForCapability(capability) {
  if (capability.valueType === "boolean") return true;
  if (capability.binding?.domain === "climate") return 26;
  if (capability.binding?.domain === "cover") return 100;
  if (capability.binding?.domain === "fan") return 50;
  if (capability.valueType === "number") return 50;
  return true;
}

function createOverlayProposals(thing, proposedAction, generatedAt) {
  const decision =
    proposedAction === "allow_auto_candidate" ? "allow_auto" : proposedAction === "protect" ? "block" : "require_confirmation";
  if (proposedAction === "read_only") return [];
  return thing.capabilities
    .filter((capability) => capability.binding?.entityId && shouldCreateOverlayProposal(capability, proposedAction, thing))
    .map((capability) => ({
      providerId: thing.provider?.id ?? capability.binding?.provider ?? "home_assistant",
      thingId: thing.id,
      entityId: capability.binding.entityId,
      decision,
      generatedAt,
      reason: candidateReason(thing, proposedAction),
    }));
}

function shouldCreateOverlayProposal(capability, proposedAction, thing) {
  if (proposedAction === "protect" && PROTECTED_THING_TYPES.has(thing.type)) return true;
  if (proposedAction === "allow_auto_candidate") {
    return capability.policy?.autoExecutable && ["control", "action"].includes(capability.kind);
  }
  return ["control", "action", "config"].includes(capability.kind) || capability.policy?.risk !== "low";
}

function groupHcmEventsByThing(events) {
  const grouped = new Map();
  for (const event of events) {
    if (!event.thingId) continue;
    const list = grouped.get(event.thingId) ?? [];
    list.push(event);
    grouped.set(event.thingId, list);
  }
  return grouped;
}

function diffRecords(kind, previous, next, diffRecord) {
  const events = [];
  for (const [id, record] of next) {
    const before = previous.get(id);
    if (!before) {
      events.push({ type: `${kind}.added`, id, record });
      continue;
    }
    const changes = diffRecord(before, record);
    if (changes.length > 0) events.push({ type: `${kind}.changed`, id, changes, before, record });
  }
  for (const [id, record] of previous) {
    if (!next.has(id)) events.push({ type: `${kind}.removed`, id, record });
  }
  return events;
}

function diffDeviceRecord(previous, next) {
  return diffFields(previous, next, ["name", "name_by_user", "area_id", "manufacturer", "model", "sw_version"]);
}

function diffEntityRecord(previous, next) {
  return diffFields(previous, next, ["entity_id", "device_id", "platform", "name", "original_name", "translation_key", "disabled_by"]);
}

function diffAreaRecord(previous, next) {
  return diffFields(previous, next, ["name"]);
}

function diffStateRecord(previous, next) {
  const changes = diffFields(previous, next, ["state"]);
  const previousFeatures = previous.attributes?.supported_features;
  const nextFeatures = next.attributes?.supported_features;
  if (previousFeatures !== nextFeatures) changes.push({ field: "supported_features", from: previousFeatures, to: nextFeatures });
  return changes;
}

function diffFields(previous, next, fields) {
  return fields
    .filter((field) => JSON.stringify(previous?.[field]) !== JSON.stringify(next?.[field]))
    .map((field) => ({ field, from: previous?.[field], to: next?.[field] }));
}

function normalizeProviderGraph(graph = {}) {
  return {
    devices: mapById(graph.devices, "id"),
    entities: mapById(graph.entities, "entity_id"),
    areas: mapById(graph.areas, "area_id"),
    states: mapById(graph.states, "entity_id"),
  };
}

function mapById(items = [], key) {
  return new Map((items ?? []).filter((item) => item?.[key]).map((item) => [item[key], item]));
}

function summarizeProviderDiff(events) {
  const byType = {};
  for (const event of events) byType[event.type] = (byType[event.type] ?? 0) + 1;
  return {
    total: events.length,
    byType,
    addedDevices: byType["device.added"] ?? 0,
    removedDevices: byType["device.removed"] ?? 0,
    changedDevices: byType["device.changed"] ?? 0,
    addedEntities: byType["entity.added"] ?? 0,
    removedEntities: byType["entity.removed"] ?? 0,
    changedEntities: byType["entity.changed"] ?? 0,
  };
}

function emptyProviderDiff() {
  return {
    version: ONBOARDING_VERSION,
    summary: summarizeProviderDiff([]),
    events: [],
  };
}

function compareCandidates(first, second) {
  const actionDelta = actionRank(second.proposedAction) - actionRank(first.proposedAction);
  if (actionDelta !== 0) return actionDelta;
  return first.thingName.localeCompare(second.thingName, "zh-CN");
}

function actionRank(action) {
  if (action === "protect") return 4;
  if (action === "review") return 3;
  if (action === "allow_auto_candidate") return 2;
  return 1;
}

function highestRisk(risks = []) {
  return risks.filter(Boolean).sort((first, second) => riskRank(second) - riskRank(first))[0] ?? "low";
}

function riskRank(risk) {
  if (risk === "sensitive") return 4;
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}
