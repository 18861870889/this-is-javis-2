export function summarizeThingCapabilities(thing) {
  const groups = createGroups();
  for (const capability of thing?.capabilities ?? []) {
    const group = classifyCapability(capability);
    groups[group].count += 1;
    if (groups[group].examples.length < 3) {
      groups[group].examples.push({
        id: capability.id,
        name: capability.name,
        kind: capability.kind,
        risk: capability.policy?.risk,
        reason: capability.policy?.reason,
      });
    }
  }

  const total = Object.values(groups).reduce((sum, group) => sum + group.count, 0);
  return {
    total,
    executable: groups.executable,
    confirmable: groups.confirmable,
    readOnly: groups.readOnly,
    protected: groups.protected,
    config: groups.config,
    label: boundaryLabel(groups),
    primaryState: primaryBoundaryState(groups),
  };
}

export function summarizeHomeCapabilities(things = []) {
  const totals = createGroupCounters();
  const deviceStates = {};

  for (const thing of things) {
    const boundary = thing.boundary ?? summarizeThingCapabilities(thing);
    totals.executable += boundary.executable.count;
    totals.confirmable += boundary.confirmable.count;
    totals.readOnly += boundary.readOnly.count;
    totals.protected += boundary.protected.count;
    totals.config += boundary.config.count;
    deviceStates[boundary.primaryState] = (deviceStates[boundary.primaryState] ?? 0) + 1;
  }

  return {
    totals,
    deviceStates,
    reviewSurfaceCount: things.filter((thing) => {
      const boundary = thing.boundary ?? summarizeThingCapabilities(thing);
      return boundary.protected.count > 0 || boundary.config.count > 0 || boundary.confirmable.count > 0;
    }).length,
  };
}

export function compressReviewToDeviceBoundaries(things = [], unresolvedBindings = []) {
  const byThing = new Map();
  for (const binding of unresolvedBindings) {
    const current = byThing.get(binding.thingId) ?? {
      thingId: binding.thingId,
      thingName: binding.thingName,
      thingType: binding.thingType,
      spaceId: binding.spaceId,
      count: 0,
      risks: {},
      reasons: {},
      examples: [],
    };
    current.count += 1;
    current.risks[binding.suggestedRisk ?? "unknown"] = (current.risks[binding.suggestedRisk ?? "unknown"] ?? 0) + 1;
    current.reasons[binding.reason ?? "未分类"] = (current.reasons[binding.reason ?? "未分类"] ?? 0) + 1;
    if (current.examples.length < 3) {
      current.examples.push({
        entityId: binding.entityId,
        entityName: binding.entityName,
        reason: binding.reason,
      });
    }
    byThing.set(binding.thingId, current);
  }

  const thingBoundaries = new Map(things.map((thing) => [thing.id, thing.boundary ?? summarizeThingCapabilities(thing)]));
  return Array.from(byThing.values())
    .map((item) => ({
      ...item,
      boundary: thingBoundaries.get(item.thingId),
      topReasons: Object.entries(item.reasons)
        .sort(([, first], [, second]) => second - first)
        .slice(0, 3)
        .map(([reason, count]) => ({ reason, count })),
      topRisks: Object.entries(item.risks)
        .sort(([, first], [, second]) => second - first)
        .map(([risk, count]) => ({ risk, count })),
    }))
    .sort((first, second) => second.count - first.count)
    .slice(0, 12);
}

function classifyCapability(capability) {
  if (capability.kind === "sensor") return "readOnly";
  if (capability.kind === "config" || capability.valueType === "text") return "config";
  if (capability.policy?.autoExecutable && capability.policy?.risk === "low" && capability.policy?.confirmation === "never") {
    return "executable";
  }
  if (capability.policy?.confirmation === "always" || ["high", "sensitive"].includes(capability.policy?.risk)) return "protected";
  if (capability.policy?.confirmation === "sometimes" || capability.policy?.risk === "medium") return "confirmable";
  return "protected";
}

function boundaryLabel(groups) {
  const parts = [];
  if (groups.executable.count) parts.push(`可自动 ${groups.executable.count}`);
  if (groups.confirmable.count) parts.push(`需确认 ${groups.confirmable.count}`);
  if (groups.readOnly.count) parts.push(`只读 ${groups.readOnly.count}`);
  if (groups.protected.count || groups.config.count) parts.push(`保护 ${groups.protected.count + groups.config.count}`);
  return parts.join(" / ") || "无能力";
}

function primaryBoundaryState(groups) {
  if (groups.protected.count || groups.config.count) return "protected";
  if (groups.confirmable.count) return "confirmable";
  if (groups.executable.count) return "executable";
  if (groups.readOnly.count) return "read_only";
  return "empty";
}

function createGroups() {
  return {
    executable: createGroup(),
    confirmable: createGroup(),
    readOnly: createGroup(),
    protected: createGroup(),
    config: createGroup(),
  };
}

function createGroup() {
  return { count: 0, examples: [] };
}

function createGroupCounters() {
  return {
    executable: 0,
    confirmable: 0,
    readOnly: 0,
    protected: 0,
    config: 0,
  };
}
