import { buildHcmExecutionPlan } from "./hcmExecutor.js";
import { simulateHcmServiceCalls } from "./homeAssistantServiceSimulator.js";
import { evaluateExecutionPolicy } from "./policyEngine.js";

export const AUTOMATION_MEMORY_VERSION = "0.1";
const MAX_EVENTS = 500;
const MIN_OCCURRENCES = 2;

export function createAutomationMemory({
  updatedAt = new Date().toISOString(),
  baseline = null,
  events = [],
  decisions = {},
} = {}) {
  return {
    version: AUTOMATION_MEMORY_VERSION,
    mode: "shadow",
    updatedAt,
    baseline,
    events,
    decisions,
  };
}

export function captureHomeEventSnapshot(memory, home, { capturedAt = new Date().toISOString() } = {}) {
  const next = normalizeMemory(memory);
  const snapshot = createHomeStateSnapshot(home, capturedAt);
  const events = next.baseline ? diffSnapshots(next.baseline, snapshot) : [];
  next.baseline = snapshot;
  next.events = [...events, ...next.events].slice(0, MAX_EVENTS);
  next.updatedAt = capturedAt;
  return { memory: next, events };
}

export function deriveAutomationSuggestions({ memory, auditEntries = [], home } = {}) {
  const normalized = normalizeMemory(memory);
  const thingsById = new Map((home?.things ?? []).map((thing) => [thing.id, thing]));
  const groups = new Map();

  for (const entry of auditEntries ?? []) {
    if (entry?.status !== "executed") continue;
    const actions = normalizeAuditActions(entry, thingsById);
    if (actions.length === 0) continue;
    const timeSlot = timeSlotFor(entry.startedAt ?? entry.finishedAt);
    const signature = actions.map((action) => `${action.thingId}:${action.capabilityId}:${stableValue(action.value)}`).sort().join("|");
    const key = `${timeSlot}:${signature}`;
    const group = groups.get(key) ?? {
      id: `automation_${stableId(key)}`,
      timeSlot,
      count: 0,
      actions,
      examples: [],
      timestamps: [],
    };
    group.count += 1;
    group.examples = [entry.input, ...group.examples.filter((item) => item !== entry.input)].slice(0, 3);
    group.timestamps.push(entry.startedAt ?? entry.finishedAt);
    groups.set(key, group);
  }

  return Array.from(groups.values())
    .filter((group) => group.count >= MIN_OCCURRENCES)
    .map((group) => createSuggestion(group, normalized, thingsById))
    .filter(Boolean)
    .sort((first, second) => second.confidence - first.confidence || second.occurrences - first.occurrences)
    .slice(0, 20);
}

export function updateAutomationSuggestionDecision(memory, suggestionId, status, { updatedAt = new Date().toISOString() } = {}) {
  if (!["shadow", "reviewed", "accepted", "ignored"].includes(status)) throw new Error(`Unsupported automation suggestion status: ${status}`);
  const next = normalizeMemory(memory);
  next.decisions[suggestionId] = { status, updatedAt };
  next.updatedAt = updatedAt;
  return next;
}

export function simulateAutomationSuggestion(suggestion, home, { source = "automation_preview" } = {}) {
  const executionPlan = buildHcmExecutionPlan(suggestion?.actions ?? [], home);
  const policyPlan = evaluateExecutionPolicy({ executionPlan, source: "text" });
  const simulation = simulateHcmServiceCalls(policyPlan.accepted, home);
  return {
    mode: "preview",
    realDeviceControl: false,
    source,
    ok: executionPlan.ok && policyPlan.ok && simulation.ok,
    accepted: policyPlan.accepted.map((item) => ({
      thingId: item.thing.id,
      thingName: item.thing.name,
      capabilityId: item.capability.id,
      capabilityName: item.capability.name,
      serviceCall: item.serviceCall,
    })),
    rejected: [...policyPlan.rejected, ...simulation.rejected],
    simulation,
  };
}

export function summarizeAutomationSuggestions(memory, suggestions) {
  const normalized = normalizeMemory(memory);
  return {
    version: normalized.version,
    mode: normalized.mode,
    updatedAt: normalized.updatedAt,
    eventCount: normalized.events.length,
    hasBaseline: Boolean(normalized.baseline),
    suggestionCount: suggestions.length,
    reviewedCount: suggestions.filter((item) => item.status === "reviewed").length,
    acceptedCount: suggestions.filter((item) => item.status === "accepted").length,
    ignoredCount: suggestions.filter((item) => item.status === "ignored").length,
    activeSuggestions: suggestions.filter((item) => item.status === "accepted").slice(0, 5),
    suggestions,
  };
}

function createHomeStateSnapshot(home, capturedAt) {
  const states = {};
  for (const thing of home?.things ?? []) {
    for (const capability of thing.capabilities ?? []) {
      if (capability.state === undefined) continue;
      states[`${thing.id}:${capability.id}`] = {
        thingId: thing.id,
        thingName: thing.name,
        thingType: thing.type,
        spaceId: thing.spaceId,
        capabilityId: capability.id,
        capabilityName: capability.name,
        value: capability.state,
      };
    }
  }
  return { capturedAt, states };
}

function diffSnapshots(previous, next) {
  const events = [];
  const keys = new Set([...Object.keys(previous.states ?? {}), ...Object.keys(next.states ?? {})]);
  for (const key of keys) {
    const before = previous.states?.[key];
    const after = next.states?.[key];
    if (!after || stableValue(before?.value) === stableValue(after.value)) continue;
    events.push({
      id: `event_${stableId(`${next.capturedAt}:${key}`)}`,
      type: occupancyType(after.thingType) ? "occupancy.changed" : "state.changed",
      occurredAt: next.capturedAt,
      thingId: after.thingId,
      thingName: after.thingName,
      thingType: after.thingType,
      spaceId: after.spaceId,
      capabilityId: after.capabilityId,
      capabilityName: after.capabilityName,
      previousValue: before?.value,
      value: after.value,
      active: occupancyType(after.thingType) ? isActiveState(after.value) : undefined,
    });
  }
  return events;
}

function normalizeAuditActions(entry, thingsById) {
  const actions = [];
  for (const service of entry.execution?.services ?? []) {
    const thing = thingsById.get(service.thingId);
    const capability = thing?.capabilities?.find((item) => item.id === service.capabilityId);
    if (!thing || !capability || service.value === undefined) continue;
    if (!capability.policy?.autoExecutable || capability.policy.risk !== "low" || capability.policy.confirmation !== "never") continue;
    actions.push({
      thingId: thing.id,
      thingName: thing.name,
      capabilityId: capability.id,
      capabilityName: capability.name,
      value: service.value,
      spaceId: thing.spaceId,
    });
  }
  return actions;
}

function createSuggestion(group, memory, thingsById) {
  const things = group.actions.map((action) => thingsById.get(action.thingId)).filter(Boolean);
  if (things.length !== group.actions.length) return null;
  const decision = memory.decisions[group.id];
  const actionNames = group.actions.map((action) => `${action.thingName} ${action.capabilityName}`).join("；");
  return {
    id: group.id,
    type: "time_slot_routine",
    status: decision?.status ?? "shadow",
    title: `${timeSlotName(group.timeSlot)}的重复操作`,
    summary: `检测到 ${group.count} 次相似成功操作：${actionNames}`,
    trigger: {
      type: "time_slot",
      timeSlot: group.timeSlot,
      description: `${timeSlotName(group.timeSlot)}发生相似家庭状态时`,
    },
    actions: group.actions,
    occurrences: group.count,
    confidence: Math.min(0.9, 0.46 + group.count * 0.12),
    examples: group.examples,
    safety: {
      mode: "shadow",
      autoApply: false,
      realDeviceControl: false,
      reason: decision?.status === "accepted"
        ? "用户已确认该建议，但执行时仍必须经过 HCM safety/policy/audit"
        : "自动化建议必须先模拟和人工审核，不直接写 HA 自动化",
    },
    decisionUpdatedAt: decision?.updatedAt,
  };
}

function normalizeMemory(memory) {
  const base = memory && typeof memory === "object" ? memory : {};
  return createAutomationMemory({
    updatedAt: base.updatedAt,
    baseline: base.baseline && typeof base.baseline === "object" ? base.baseline : null,
    events: Array.isArray(base.events) ? base.events : [],
    decisions: base.decisions && typeof base.decisions === "object" ? { ...base.decisions } : {},
  });
}

function timeSlotFor(value) {
  const date = value ? new Date(value) : new Date(0);
  const hour = Number.isNaN(date.getTime()) ? 0 : date.getHours();
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function timeSlotName(slot) {
  return { night: "夜间", morning: "上午", afternoon: "下午", evening: "晚间" }[slot] ?? "固定时段";
}

function occupancyType(type) {
  return ["presence_sensor", "motion_sensor"].includes(type);
}

function isActiveState(value) {
  return value === true || ["on", "detected", "motion", "occupied"].includes(String(value).toLowerCase());
}

function stableValue(value) {
  return JSON.stringify(value);
}

function stableId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "unknown";
}
