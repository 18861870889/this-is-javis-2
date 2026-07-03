export const PROACTIVE_OPPORTUNITY_VERSION = "0.1";

const OCCUPANCY_TYPES = new Set(["presence_sensor", "motion_sensor"]);
const LIGHT_DOMAINS = new Set(["light", "switch"]);
const DEFAULT_MAX_OPPORTUNITIES = 10;

export function detectProactiveOpportunities({
  home,
  automationSummary,
  pcContext = {},
  now = () => new Date().toISOString(),
  max = DEFAULT_MAX_OPPORTUNITIES,
} = {}) {
  const generatedAt = now();
  const opportunities = [
    ...detectUnattendedLights(home, generatedAt),
    ...detectRoutineSuggestions(automationSummary, generatedAt),
  ]
    .map((opportunity) => ({
      ...opportunity,
      interruption: evaluateInterruptionPolicy(opportunity, { pcContext, now: generatedAt }),
    }))
    .sort((first, second) => priorityRank(first.priority) - priorityRank(second.priority) || second.confidence - first.confidence)
    .slice(0, max);

  return {
    version: PROACTIVE_OPPORTUNITY_VERSION,
    generatedAt,
    mode: "shadow",
    level: "L1_L2",
    autoExecute: false,
    opportunityCount: opportunities.length,
    opportunities,
  };
}

export function evaluateInterruptionPolicy(opportunity, { pcContext = {}, now = new Date().toISOString() } = {}) {
  if (pcContext.inMeeting || pcContext.focusMode) {
    return {
      allowed: false,
      reason: pcContext.inMeeting ? "pc_meeting_active" : "pc_focus_mode_active",
      nextEligibleAt: pcContext.until || "",
      evaluatedAt: now,
    };
  }
  if (opportunity.level === "L2" && opportunity.risk === "low") {
    return {
      allowed: true,
      reason: "low_risk_confirmation_prompt",
      evaluatedAt: now,
    };
  }
  return {
    allowed: true,
    reason: "low_interrupt_observation",
    evaluatedAt: now,
  };
}

function detectUnattendedLights(home, generatedAt) {
  const spaces = new Map((home?.spaces ?? []).map((space) => [space.id, space]));
  const occupancyByRoom = roomOccupancy(home);
  const opportunities = [];
  for (const thing of home?.things ?? []) {
    const onCapability = (thing.capabilities ?? []).find((capability) => isLightPowerOn(thing, capability));
    if (!onCapability) continue;
    const occupancy = occupancyByRoom.get(thing.spaceId);
    if (!occupancy || occupancy.occupied !== false) continue;
    const roomName = spaces.get(thing.spaceId)?.name ?? thing.spaceId;
    opportunities.push({
      id: `op_unattended_light_${thing.id}_${onCapability.id}`,
      type: "unattended_light",
      level: "L2",
      title: `${roomName}无人但灯还开着`,
      prompt: `${roomName}现在没人，${thing.name}还开着，要关吗？`,
      roomId: thing.spaceId,
      roomName,
      thingId: thing.id,
      thingName: thing.name,
      capabilityId: onCapability.id,
      confidence: Math.min(0.92, occupancy.confidence + 0.12),
      priority: "high",
      risk: "low",
      action: {
        target: thing.name,
        capability: "power",
        value: false,
      },
      safety: {
        autoExecute: false,
        requiresConfirmation: true,
        reason: "M1 proactive AI only asks for confirmation; it does not auto-execute.",
      },
      detectedAt: generatedAt,
    });
  }
  return opportunities;
}

function detectRoutineSuggestions(automationSummary, generatedAt) {
  return (automationSummary?.suggestions ?? [])
    .filter((suggestion) => suggestion.status === "shadow" && suggestion.confidence >= 0.7)
    .slice(0, 3)
    .map((suggestion) => ({
      id: `op_routine_${suggestion.id}`,
      type: "routine_suggestion",
      level: "L1",
      title: suggestion.title,
      prompt: `我发现一个重复习惯：${suggestion.summary}。要不要以后我主动提醒你？`,
      suggestionId: suggestion.id,
      confidence: suggestion.confidence,
      priority: "medium",
      risk: "low",
      safety: {
        autoExecute: false,
        requiresConfirmation: false,
        reason: "Routine suggestions remain shadow guidance in M1.",
      },
      detectedAt: generatedAt,
    }));
}

function roomOccupancy(home) {
  const byRoom = new Map();
  for (const thing of home?.things ?? []) {
    if (!OCCUPANCY_TYPES.has(thing.type)) continue;
    const signal = occupancySignal(thing);
    if (!signal) continue;
    const current = byRoom.get(thing.spaceId);
    if (!current || signal.confidence > current.confidence) byRoom.set(thing.spaceId, signal);
  }
  return byRoom;
}

function occupancySignal(thing) {
  for (const capability of thing.capabilities ?? []) {
    const value = capability.state;
    if (value === true) return { occupied: true, confidence: 0.86, thingId: thing.id, capabilityId: capability.id };
    if (value === false) return { occupied: false, confidence: 0.8, thingId: thing.id, capabilityId: capability.id };
    const text = String(value ?? "").toLowerCase();
    if (["occupied", "on", "detected", "motion"].includes(text)) return { occupied: true, confidence: 0.78, thingId: thing.id, capabilityId: capability.id };
    if (["off", "clear", "none", "no_motion", "unoccupied"].includes(text) || /无人|无移动/.test(text)) {
      return { occupied: false, confidence: 0.72, thingId: thing.id, capabilityId: capability.id };
    }
  }
  return null;
}

function isLightPowerOn(thing, capability) {
  if (capability.state !== true) return false;
  const domain = capability.binding?.domain;
  const name = `${thing.name} ${capability.name}`;
  return thing.type === "light" || LIGHT_DOMAINS.has(domain) && /灯|light/i.test(name);
}

function priorityRank(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 3;
}
