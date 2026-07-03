const AGENT_RUNTIME_VERSION = "0.1";
const TEST_AGENT_SMOKE_DOMAINS = new Set(["light", "switch", "fan", "cover", "climate", "media_player"]);
const TEST_AGENT_PROTECTED_TYPES = new Set(["camera", "pet_feeder", "gas_heater", "water_heater"]);
const UNCLEAR_TEST_TARGET_PATTERN = /未定义|未绑定|未知|未命名|unbound|undefined|unknown/i;

export function runAgentRuntime({
  home,
  auditEntries = [],
  learningMemory,
  generatedAt = new Date().toISOString(),
  now = () => Date.now(),
} = {}) {
  const context = runShadowAgent("context", () => runContextAgent({ home, generatedAt }), { now });
  const learning = runShadowAgent("learning", () => runLearningAgent({ learningMemory, auditEntries, generatedAt }), { now });
  const mapping = runShadowAgent("mapping", () => runMappingAgent({ home, generatedAt }), { now });
  const diagnostics = runShadowAgent("diagnostics", () => runDiagnosticsAgent({ home, auditEntries, generatedAt }), { now });
  const test = runShadowAgent("test", () => runTestAgent({ home, generatedAt }), { now });
  const agentList = [context, learning, mapping, diagnostics, test];

  return {
    version: AGENT_RUNTIME_VERSION,
    generatedAt,
    mode: "shadow",
    summary: {
      agentCount: agentList.length,
      okAgents: agentList.filter((agent) => agent.status === "ok").length,
      failedAgents: agentList.filter((agent) => agent.status !== "ok").length,
      timedOutAgents: agentList.filter((agent) => agent.timedOut).length,
      occupancySpaces: context.spaces?.length ?? 0,
      learningCandidates: learning.candidates?.length ?? 0,
      mappingCandidates: mapping.candidates?.length ?? 0,
      diagnosticsFindings: diagnostics.findings?.length ?? 0,
      generatedTests: test.testCases?.length ?? 0,
      actionRequired:
        (mapping.candidates ?? []).some((candidate) => candidate.severity !== "low") ||
        (diagnostics.findings ?? []).some((finding) => finding.severity !== "low") ||
        (learning.candidates ?? []).some((candidate) => candidate.status === "shadow"),
    },
    agents: {
      context,
      learning,
      mapping,
      diagnostics,
      test,
    },
  };
}

export function runShadowAgent(agentId, fn, { now = () => Date.now(), budgetMs = 50 } = {}) {
  const startedAt = now();
  try {
    const result = fn();
    const latencyMs = Math.max(0, now() - startedAt);
    return {
      ...result,
      agentId,
      latencyMs,
      budgetMs,
      timedOut: latencyMs > budgetMs,
      status: result?.status === "error" ? "error" : "ok",
    };
  } catch (error) {
    return {
      id: `${agentId}_agent`,
      agentId,
      name: agentId,
      status: "error",
      mode: "shadow",
      latencyMs: Math.max(0, now() - startedAt),
      budgetMs,
      timedOut: false,
      error: error.message,
    };
  }
}

export function runContextAgent({ home, generatedAt = new Date().toISOString() } = {}) {
  const spaces = new Map((home?.spaces ?? []).map((space) => [space.id, { id: space.id, name: space.name }]));
  for (const thing of home?.things ?? []) {
    if (!spaces.has(thing.spaceId)) spaces.set(thing.spaceId, { id: thing.spaceId, name: thing.spaceId });
  }

  const evidenceBySpace = new Map();
  for (const thing of home?.things ?? []) {
    const evidence = occupancyEvidenceForThing(thing, generatedAt);
    if (!evidence) continue;
    const list = evidenceBySpace.get(thing.spaceId) ?? [];
    list.push(evidence);
    evidenceBySpace.set(thing.spaceId, list);
  }

  const spaceStates = Array.from(spaces.values())
    .map((space) => {
      const evidence = evidenceBySpace.get(space.id) ?? [];
      const confidence = evidence.reduce((max, item) => Math.max(max, item.confidence), 0);
      return {
        ...space,
        occupied: confidence >= 0.6,
        confidence: roundConfidence(confidence),
        sources: evidence
          .sort((first, second) => second.confidence - first.confidence)
          .slice(0, 4)
          .map((item) => ({
            thingId: item.thingId,
            thingName: item.thingName,
            signal: item.signal,
            confidence: roundConfidence(item.confidence),
          })),
        updatedAt: generatedAt,
      };
    })
    .sort((first, second) => second.confidence - first.confidence || first.name.localeCompare(second.name, "zh-CN"));

  return {
    id: "context_agent",
    name: "Context Agent",
    status: "ok",
    mode: "shadow",
    generatedAt,
    likelySpace: spaceStates[0]?.confidence > 0 ? spaceStates[0] : null,
    spaces: spaceStates,
  };
}

export function runMappingAgent({ home, generatedAt = new Date().toISOString() } = {}) {
  const unresolvedByThing = new Map();
  for (const binding of home?.unresolvedBindings ?? []) {
    mergeMappingSignal(unresolvedByThing, {
      thingId: binding.thingId,
      thingName: binding.thingName,
      thingType: binding.thingType,
      spaceId: binding.spaceId,
      entityId: binding.entityId,
      entityName: binding.entityName,
      kind: binding.kind,
      valueType: binding.valueType,
      reason: binding.reason,
      risk: binding.suggestedRisk,
    });
  }

  for (const thing of home?.things ?? []) {
    for (const capability of thing.capabilities ?? []) {
      if (!requiresMappingReview(capability, thing)) continue;
      mergeMappingSignal(unresolvedByThing, {
        thingId: thing.id,
        thingName: thing.name,
        thingType: thing.type,
        spaceId: thing.spaceId,
        entityId: capability.binding?.entityId,
        entityName: capability.name,
        kind: capability.kind,
        valueType: capability.valueType,
        reason: capability.policy?.reason || "能力边界需要确认",
        risk: capability.policy?.risk,
      });
    }
  }

  const candidates = Array.from(unresolvedByThing.values())
    .map((candidate) => {
      const dominantReason = topEntry(candidate.reasons)?.[0] ?? "需要人工确认能力边界";
      const severity = mappingSeverity(candidate);
      return {
        ...candidate,
        severity,
        confidence: mappingConfidence(candidate),
        proposedAction: mappingActionForSeverity(severity),
        reason: dominantReason,
      };
    })
    .sort((first, second) => severityRank(second.severity) - severityRank(first.severity) || second.count - first.count)
    .slice(0, 12);

  const genericThings = (home?.things ?? []).filter((thing) => ["generic", "generic_device", "switch_panel"].includes(thing.type));

  return {
    id: "mapping_agent",
    name: "Mapping Agent",
    status: "ok",
    mode: "shadow",
    generatedAt,
    candidates,
    summary: {
      unresolvedThings: unresolvedByThing.size,
      genericThingCount: genericThings.length,
      protectedCandidates: candidates.filter((candidate) => ["high", "critical"].includes(candidate.severity)).length,
    },
  };
}

export function runLearningAgent({ learningMemory, auditEntries = [], generatedAt = new Date().toISOString() } = {}) {
  const candidates = (learningMemory?.candidates ?? [])
    .filter((candidate) => candidate.status !== "ignored")
    .slice(0, 8)
    .map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      status: candidate.status,
      input: candidate.input,
      confidence: candidate.confidence,
      count: candidate.count,
      actionCount: candidate.actions?.length ?? 0,
      autoApply: false,
    }));
  const ignoredCount = (learningMemory?.candidates ?? []).filter((candidate) => candidate.status === "ignored").length;
  const recentSuccessfulPatterns = auditEntries
    .filter((entry) => ["executed", "dry_run"].includes(entry.status) && (entry.execution?.services?.length ?? 0) > 0)
    .slice(0, 6)
    .map((entry) => ({
      commandId: entry.commandId,
      input: entry.input,
      serviceCount: entry.execution?.services?.length ?? 0,
      latencyMs: entry.latencyMs,
    }));

  return {
    id: "learning_agent",
    name: "Learning Agent",
    status: "ok",
    mode: "shadow",
    generatedAt,
    candidates,
    recentSuccessfulPatterns,
    summary: {
      candidateCount: candidates.length,
      ignoredCount,
      observationCount: learningMemory?.observations?.length ?? 0,
      autoAppliedCount: 0,
    },
  };
}

function mergeMappingSignal(groups, signal) {
  const key = signal.thingId || signal.thingName || signal.entityId;
  const current = groups.get(key) ?? {
    thingId: signal.thingId,
    thingName: signal.thingName ?? "未命名设备",
    thingType: signal.thingType ?? "generic",
    spaceId: signal.spaceId,
    count: 0,
    reasons: {},
    risks: {},
    examples: [],
  };
  const exampleKey = `${signal.entityId}:${signal.kind}`;
  const alreadyTracked = current.examples.some((example) => `${example.entityId}:${example.kind}` === exampleKey);
  if (!alreadyTracked) {
    current.count += 1;
    if (current.examples.length < 3) {
      current.examples.push({
        entityId: signal.entityId,
        entityName: signal.entityName,
        kind: signal.kind,
        valueType: signal.valueType,
      });
    }
  }
  current.reasons[signal.reason || "未分类"] = (current.reasons[signal.reason || "未分类"] || 0) + 1;
  current.risks[signal.risk || "unknown"] = (current.risks[signal.risk || "unknown"] || 0) + 1;
  groups.set(key, current);
}

function requiresMappingReview(capability, thing) {
  if (capability.kind === "sensor" && capability.policy?.risk === "low") return false;
  if (capability.policy?.risk && capability.policy.risk !== "low") return true;
  if (capability.policy?.autoExecutable === false && ["control", "action", "config"].includes(capability.kind)) return true;
  return ["generic", "generic_device", "switch_panel"].includes(thing.type) && capability.kind !== "sensor";
}

export function runDiagnosticsAgent({ home, auditEntries = [], generatedAt = new Date().toISOString() } = {}) {
  const findings = [];
  const offlineThings = (home?.things ?? []).filter((thing) => thing.online === false);
  if (offlineThings.length > 0) {
    findings.push({
      id: "offline_things",
      severity: "medium",
      title: "设备离线",
      message: `${offlineThings.length} 个 HCM 设备当前离线`,
      targets: offlineThings.slice(0, 5).map((thing) => ({ thingId: thing.id, thingName: thing.name })),
    });
  }

  const recent = auditEntries.slice(0, 20);
  const failed = recent.filter((entry) => ["rejected", "partial_failure", "error"].includes(entry.status));
  if (failed.length > 0) {
    findings.push({
      id: "recent_command_failures",
      severity: failed.length >= 3 ? "high" : "medium",
      title: "近期指令失败",
      message: `最近 ${recent.length} 条审计中有 ${failed.length} 条失败或被拒绝`,
      targets: failed.slice(0, 4).map((entry) => ({
        commandId: entry.commandId,
        input: entry.input,
        status: entry.status,
      })),
    });
  }

  const simulationRejected = recent.filter((entry) => (entry.execution?.simulation?.rejectedCount ?? 0) > 0);
  if (simulationRejected.length > 0) {
    findings.push({
      id: "service_simulation_rejections",
      severity: "high",
      title: "HA 服务模拟拦截",
      message: `${simulationRejected.length} 条指令在真实执行前被 simulator 拦截`,
      targets: simulationRejected.slice(0, 4).map((entry) => ({
        commandId: entry.commandId,
        input: entry.input,
        rejectedCount: entry.execution?.simulation?.rejectedCount,
      })),
    });
  }

  const noAutoCapabilities = (home?.stats?.autoExecutableCapabilities ?? 0) === 0;
  if (noAutoCapabilities) {
    findings.push({
      id: "no_auto_capabilities",
      severity: "high",
      title: "没有自动可执行能力",
      message: "当前 HCM 没有开放给 AI 自动执行的低风险能力",
      targets: [],
    });
  }

  const slowCommands = recent.filter((entry) => (entry.latencyMs ?? 0) > 2000);
  if (slowCommands.length > 0) {
    findings.push({
      id: "latency_budget",
      severity: "low",
      title: "2 秒链路预算",
      message: `${slowCommands.length} 条近期指令超过 2 秒`,
      targets: slowCommands.slice(0, 4).map((entry) => ({
        commandId: entry.commandId,
        input: entry.input,
        latencyMs: entry.latencyMs,
      })),
    });
  }

  return {
    id: "diagnostics_agent",
    name: "Diagnostics Agent",
    status: "ok",
    mode: "shadow",
    generatedAt,
    findings,
    summary: {
      offlineThingCount: offlineThings.length,
      recentAuditCount: recent.length,
      failedCommandCount: failed.length,
      simulationRejectedCount: simulationRejected.length,
      slowCommandCount: slowCommands.length,
    },
  };
}

export function runTestAgent({ home, generatedAt = new Date().toISOString() } = {}) {
  const testCases = [];
  const things = home?.things ?? [];

  for (const thing of things) {
    const capability = (thing.capabilities ?? []).find(
      (candidate) =>
        !TEST_AGENT_PROTECTED_TYPES.has(thing.type) &&
        !UNCLEAR_TEST_TARGET_PATTERN.test(`${thing.name} ${candidate.name}`) &&
        candidate.policy?.autoExecutable &&
        candidate.policy?.risk === "low" &&
        candidate.kind === "control" &&
        TEST_AGENT_SMOKE_DOMAINS.has(candidate.binding?.domain),
    );
    if (!capability) continue;
    testCases.push({
      id: `dry_run_${thing.id}_${capability.id}`,
      type: "dry_run_control",
      priority: "smoke",
      input: commandExampleForCapability(thing, capability),
      expected: {
        status: "dry_run",
        thingId: thing.id,
        capabilityId: capability.id,
        serviceDomain: capability.binding.domain,
      },
      safety: {
        realDeviceControl: false,
        reason: "Test Agent 只生成 dry-run 回归建议",
      },
    });
    if (testCases.length >= 6) break;
  }

  for (const thing of things) {
    const protectedCapability = (thing.capabilities ?? []).find(
      (capability) => capability.policy?.risk && capability.policy.risk !== "low",
    );
    if (!protectedCapability) continue;
    testCases.push({
      id: `reject_${thing.id}_${protectedCapability.id}`,
      type: "safety_rejection",
      priority: "safety",
      input: `打开${thing.name}`,
      expected: {
        status: "rejected",
        thingId: thing.id,
        capabilityId: protectedCapability.id,
      },
      safety: {
        realDeviceControl: false,
        reason: "高风险/敏感能力必须保持拦截",
      },
    });
    if (testCases.filter((item) => item.type === "safety_rejection").length >= 4) break;
  }

  for (const thing of things) {
    const sensor = (thing.capabilities ?? []).find((capability) => capability.kind === "sensor");
    if (!sensor) continue;
    testCases.push({
      id: `state_query_${thing.id}_${sensor.id}`,
      type: "state_query",
      priority: "regression",
      input: `${thing.name}目前是什么状态`,
      expected: {
        status: "answered",
        thingId: thing.id,
      },
      safety: {
        realDeviceControl: false,
        reason: "状态查询只读，不执行设备动作",
      },
    });
    if (testCases.filter((item) => item.type === "state_query").length >= 3) break;
  }

  const selectedTestCases = testCases.slice(0, 12);

  return {
    id: "test_agent",
    name: "Test Agent",
    status: "ok",
    mode: "shadow",
    generatedAt,
    testCases: selectedTestCases,
    summary: {
      generatedCount: selectedTestCases.length,
      smokeCount: selectedTestCases.filter((item) => item.priority === "smoke").length,
      safetyCount: selectedTestCases.filter((item) => item.priority === "safety").length,
      readOnlyCount: selectedTestCases.filter((item) => item.type === "state_query").length,
    },
  };
}

function occupancyEvidenceForThing(thing, generatedAt) {
  const type = thing.type;
  if (!["presence_sensor", "motion_sensor", "door_sensor"].includes(type)) return null;

  if (!hasCurrentActiveSensorState(thing)) return null;

  if (type === "presence_sensor") {
    return {
      thingId: thing.id,
      thingName: thing.name,
      signal: "presence",
      confidence: 0.92,
      updatedAt: generatedAt,
    };
  }
  if (type === "motion_sensor") {
    return {
      thingId: thing.id,
      thingName: thing.name,
      signal: "motion",
      confidence: 0.64,
      updatedAt: generatedAt,
    };
  }
  return {
    thingId: thing.id,
    thingName: thing.name,
    signal: "door_open",
    confidence: 0.36,
    updatedAt: generatedAt,
  };
}

function hasCurrentActiveSensorState(thing) {
  const currentCapability = findCurrentSensorCapability(thing);
  return isActivePresenceState(currentCapability?.state ?? currentCapability?.binding?.currentState);
}

function findCurrentSensorCapability(thing) {
  const capabilities = thing.capabilities ?? [];
  const textFor = (capability) => `${capability.id ?? ""} ${capability.name ?? ""} ${capability.binding?.entityId ?? ""}`.toLowerCase();
  if (thing.type === "presence_sensor") {
    return capabilities.find((capability) => /有人无人|occupancy|存在.*状态|presence/.test(textFor(capability)));
  }
  if (thing.type === "motion_sensor") {
    return capabilities.find((capability) => {
      if (capability.valueType === "event" || capability.binding?.domain === "event") return false;
      return /检测到移动|motion/.test(textFor(capability));
    });
  }
  if (thing.type === "door_sensor") {
    return capabilities.find((capability) => /接触状态|contact|门窗|door|window/.test(textFor(capability)));
  }
  return null;
}

function isActivePresenceState(state) {
  if (state === true) return true;
  const text = String(state ?? "").toLowerCase();
  if (["on", "open", "detected", "motion", "occupied", "home", "true"].includes(text)) return true;
  return false;
}

function mappingSeverity(candidate) {
  if (candidate.risks.sensitive || candidate.risks.high) return "critical";
  if (candidate.risks.medium) return "medium";
  if (candidate.thingType === "switch_panel" || candidate.thingType === "generic_device") return "medium";
  return "low";
}

function mappingConfidence(candidate) {
  if (candidate.thingType === "generic_device") return 0.45;
  if (candidate.thingType === "switch_panel") return 0.58;
  if (candidate.count >= 3) return 0.72;
  return 0.64;
}

function mappingActionForSeverity(severity) {
  if (severity === "critical") return "protect";
  if (severity === "medium") return "review";
  return "auto_candidate";
}

function commandExampleForCapability(thing, capability) {
  if (capability.valueType === "number" && capability.binding?.domain === "climate") return `${thing.name}调到26度`;
  if (capability.binding?.domain === "media_player") return `打开${thing.name}`;
  if (capability.valueType === "number") return `设置${thing.name}`;
  if (capability.valueType === "boolean") return `打开${thing.name}`;
  return `执行${thing.name}${capability.name}`;
}

function topEntry(record) {
  return Object.entries(record).sort(([, first], [, second]) => second - first)[0];
}

function severityRank(severity) {
  if (severity === "critical") return 3;
  if (severity === "high") return 2;
  if (severity === "medium") return 1;
  return 0;
}

function roundConfidence(value) {
  return Math.round(value * 100) / 100;
}
