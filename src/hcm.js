import {
  compressReviewToDeviceBoundaries,
  summarizeHomeCapabilities,
  summarizeThingCapabilities,
} from "./hcmCapabilityCompression.js";

export const HCM_VERSION = "0.1";

export const CAPABILITY_KINDS = {
  CONTROL: "control",
  SENSOR: "sensor",
  CONFIG: "config",
  ACTION: "action",
};

export const POLICY_LEVELS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  SENSITIVE: "sensitive",
};

export function createHcmHome({
  provider,
  spaces = [],
  things = [],
  unresolvedBindings = [],
  syncedAt = new Date().toISOString(),
} = {}) {
  const normalizedSpaces = dedupeById(spaces.map(normalizeSpace));
  const normalizedThings = things.map(normalizeThing);

  return {
    version: HCM_VERSION,
    provider: provider ?? { id: "unknown", name: "Unknown Provider" },
    syncedAt,
    stats: summarizeHcm(normalizedThings, unresolvedBindings),
    capabilitySummary: summarizeHomeCapabilities(normalizedThings),
    review: summarizeBindingReview(unresolvedBindings, normalizedThings),
    spaces: normalizedSpaces,
    things: normalizedThings,
    unresolvedBindings,
  };
}

export function normalizeSpace(space) {
  return {
    id: stableId(space.id || space.name || "unknown_space"),
    name: space.name || "未分区",
    aliases: Array.isArray(space.aliases) ? space.aliases : [],
    provider: space.provider ?? null,
  };
}

export function normalizeThing(thing) {
  const capabilities = Array.isArray(thing.capabilities) ? thing.capabilities.map(normalizeCapability) : [];
  const normalized = {
    id: stableId(thing.id || thing.name || "unknown_thing"),
    name: thing.name || "未命名设备",
    type: thing.type || "generic",
    spaceId: stableId(thing.spaceId || "unknown"),
    aliases: Array.isArray(thing.aliases) ? thing.aliases : [],
    online: thing.online ?? true,
    policy: normalizePolicy(thing.policy),
    provider: thing.provider ?? null,
    capabilities,
    state: thing.state ?? {},
  };
  return {
    ...normalized,
    boundary: summarizeThingCapabilities(normalized),
  };
}

export function normalizeCapability(capability) {
  return {
    id: stableId(capability.id || capability.name || "capability"),
    name: capability.name || capability.id || "capability",
    kind: capability.kind || CAPABILITY_KINDS.SENSOR,
    valueType: capability.valueType || "unknown",
    state: capability.state,
    unit: capability.unit,
    policy: normalizePolicy(capability.policy),
    binding: capability.binding ?? null,
    evidence: capability.evidence ?? null,
  };
}

export function normalizePolicy(policy = {}) {
  const risk = policy.risk || POLICY_LEVELS.LOW;
  return {
    risk,
    confirmation: policy.confirmation || defaultConfirmation(risk),
    autoExecutable: Boolean(policy.autoExecutable),
    reason: policy.reason || "",
    overlayDecision: policy.overlayDecision,
    overlayUpdatedAt: policy.overlayUpdatedAt,
    overlaySource: policy.overlaySource,
  };
}

export function summarizeHcm(things, unresolvedBindings = []) {
  const spaces = new Set();
  const types = {};
  const policies = {};
  let capabilityCount = 0;
  let autoExecutableCapabilities = 0;

  for (const thing of things) {
    spaces.add(thing.spaceId);
    types[thing.type] = (types[thing.type] || 0) + 1;
    for (const capability of thing.capabilities) {
      capabilityCount += 1;
      policies[capability.policy.risk] = (policies[capability.policy.risk] || 0) + 1;
      if (capability.policy.autoExecutable && isExecutableKind(capability.kind)) autoExecutableCapabilities += 1;
    }
  }

  return {
    thingCount: things.length,
    spaceCount: spaces.size,
    capabilityCount,
    autoExecutableCapabilities,
    unresolvedBindingCount: unresolvedBindings.length,
    types,
    policies,
  };
}

export function summarizeBindingReview(unresolvedBindings = [], things = []) {
  const byRisk = {};
  const byKind = {};
  const byReason = {};
  const byThingType = {};

  for (const binding of unresolvedBindings) {
    const risk = binding.suggestedRisk || "unknown";
    const kind = binding.kind || "unknown";
    const reason = binding.reason || "未分类";
    const thingType = binding.thingType || "generic";

    byRisk[risk] = (byRisk[risk] || 0) + 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
    byReason[reason] = (byReason[reason] || 0) + 1;
    byThingType[thingType] = (byThingType[thingType] || 0) + 1;
  }

  const sortedReasons = Object.entries(byReason)
    .sort(([, first], [, second]) => second - first)
    .map(([reason, count]) => ({ reason, count }));

  return {
    total: unresolvedBindings.length,
    byRisk,
    byKind,
    byThingType,
    topReasons: sortedReasons.slice(0, 6),
    recommendations: summarizeBindingRecommendations(unresolvedBindings),
    deviceBoundaries: compressReviewToDeviceBoundaries(things, unresolvedBindings),
    samples: unresolvedBindings.slice(0, 8),
  };
}

export function summarizeBindingRecommendations(unresolvedBindings = []) {
  const deviceGroups = new Map();

  for (const binding of unresolvedBindings) {
    const recommendation = recommendBindingAdjustment(binding);
    if (!recommendation) continue;
    const key = binding.thingId || binding.thingName || binding.entityId;
    const current = deviceGroups.get(key) ?? {
      thingId: binding.thingId,
      thingName: binding.thingName || "未命名设备",
      thingType: binding.thingType || "generic",
      spaceId: binding.spaceId,
      severity: recommendation.severity,
      action: recommendation.action,
      count: 0,
      reasons: {},
      examples: [],
    };
    current.count += 1;
    current.severity = higherSeverity(current.severity, recommendation.severity);
    current.action = strongerAction(current.action, recommendation.action);
    current.reasons[binding.reason || "未分类"] = (current.reasons[binding.reason || "未分类"] || 0) + 1;
    if (current.examples.length < 3) {
      current.examples.push({
        entityId: binding.entityId,
        entityName: binding.entityName,
        reason: binding.reason,
      });
    }
    deviceGroups.set(key, current);
  }

  const devices = Array.from(deviceGroups.values())
    .map((device) => ({
      ...device,
      reasons: Object.entries(device.reasons)
        .sort(([, first], [, second]) => second - first)
        .slice(0, 3)
        .map(([reason, count]) => ({ reason, count })),
    }))
    .sort((first, second) => {
      const severityDelta = severityRank(second.severity) - severityRank(first.severity);
      if (severityDelta !== 0) return severityDelta;
      return second.count - first.count;
    });

  const bySeverity = {};
  for (const device of devices) {
    bySeverity[device.severity] = (bySeverity[device.severity] || 0) + 1;
  }

  return {
    totalDevices: devices.length,
    bySeverity,
    devices: devices.slice(0, 8),
  };
}

export function stableId(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/['"()[\]{}]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    || "unknown";
}

function defaultConfirmation(risk) {
  if (risk === POLICY_LEVELS.LOW) return "never";
  if (risk === POLICY_LEVELS.MEDIUM) return "sometimes";
  return "always";
}

function isExecutableKind(kind) {
  return kind === CAPABILITY_KINDS.CONTROL || kind === CAPABILITY_KINDS.ACTION;
}

function recommendBindingAdjustment(binding) {
  const text = `${binding.thingName ?? ""} ${binding.entityName ?? ""} ${binding.reason ?? ""} ${binding.thingType ?? ""}`.toLowerCase();
  if (binding.suggestedRisk === POLICY_LEVELS.SENSITIVE || /摄像|监控|camera/.test(text)) {
    return { severity: "critical", action: "保持手动授权，避免隐私能力自动执行" };
  }
  if (/燃气|gas|热水器/.test(text)) {
    return { severity: "critical", action: "保持手动确认，单独设置安全场景" };
  }
  if (binding.kind === CAPABILITY_KINDS.CONFIG || binding.valueType === "text" || /密码|password|配置|config|互控|解控|绑定/.test(text)) {
    return { severity: "high", action: "配置项保持禁止，明确照明通道可保留" };
  }
  if (binding.kind === CAPABILITY_KINDS.SENSOR) {
    return { severity: "high", action: "只作为状态输入，不作为可执行能力" };
  }
  if (/语义不清|确认命名|可控实体需要语义确认/.test(text)) {
    return { severity: "medium", action: "补充别名或房间语义，确认后可自动执行" };
  }
  if (binding.confirmation === "always") {
    return { severity: "medium", action: "确认是否需要保留执行前确认" };
  }
  return null;
}

function higherSeverity(current, next) {
  return severityRank(next) > severityRank(current) ? next : current;
}

function strongerAction(current, next) {
  if (severityRank(actionSeverity(next)) > severityRank(actionSeverity(current))) return next;
  return current;
}

function actionSeverity(action) {
  if (/隐私|手动确认|禁止/.test(action)) return "critical";
  if (/只作为状态|隐藏/.test(action)) return "high";
  return "medium";
}

function severityRank(severity) {
  if (severity === "critical") return 3;
  if (severity === "high") return 2;
  if (severity === "medium") return 1;
  return 0;
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
