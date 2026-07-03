export const LEARNING_MEMORY_VERSION = "0.1";
export const HOUSEHOLD_LEARNING_CONTEXT_VERSION = "0.23";

export function createLearningMemory({
  updatedAt = new Date().toISOString(),
  candidates = [],
  observations = [],
  tombstones = [],
} = {}) {
  return {
    version: LEARNING_MEMORY_VERSION,
    updatedAt,
    mode: "shadow",
    observations,
    candidates,
    tombstones,
  };
}

export function recordLearningObservation(memory, auditEntry, { updatedAt = new Date().toISOString() } = {}) {
  const next = normalizeMemory(memory);
  const observation = createObservation(auditEntry, updatedAt);
  if (!observation) return next;

  next.observations = [observation, ...next.observations].slice(0, 200);
  next.candidates = deriveLearningCandidates(next.observations, next.candidates, next.tombstones);
  next.updatedAt = updatedAt;
  return next;
}

export function updateLearningCandidate(memory, candidateId, patch = {}, { updatedAt = new Date().toISOString() } = {}) {
  const next = normalizeMemory(memory);
  const candidate = next.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new Error(`Learning candidate not found: ${candidateId}`);
  const allowedStatuses = new Set(["shadow", "accepted", "ignored"]);
  if (patch.status && !allowedStatuses.has(patch.status)) {
    throw new Error(`Unsupported learning candidate status: ${patch.status}`);
  }
  candidate.status = patch.status ?? candidate.status;
  candidate.updatedAt = updatedAt;
  candidate.note = typeof patch.note === "string" ? patch.note : candidate.note;
  if (patch.application && typeof patch.application === "object" && !Array.isArray(patch.application)) {
    candidate.application = {
      mode: patch.application.mode || applicationModeForCandidate(candidate),
      appliedAt: patch.application.appliedAt || updatedAt,
      sourceCommandId: patch.application.sourceCommandId,
      summary: patch.application.summary,
    };
  } else if (patch.status === "accepted" && !candidate.application) {
    candidate.application = {
      mode: applicationModeForCandidate(candidate),
      appliedAt: updatedAt,
      sourceCommandId: patch.sourceCommandId,
      summary: applicationSummaryForCandidate(candidate),
    };
  } else if (patch.status === "ignored") {
    delete candidate.application;
  }
  next.updatedAt = updatedAt;
  return next;
}

export function deleteLearningCandidate(memory, candidateId, { updatedAt = new Date().toISOString() } = {}) {
  const next = normalizeMemory(memory);
  const candidate = next.candidates.find((item) => item.id === candidateId);
  next.candidates = next.candidates.filter((item) => item.id !== candidateId);
  if (candidate) {
    next.tombstones = [
      { id: candidate.id, commandKey: candidate.commandKey, deletedAt: updatedAt },
      ...next.tombstones.filter((item) => item.id !== candidate.id),
    ].slice(0, 100);
  }
  next.updatedAt = updatedAt;
  return next;
}

export function deriveLearningCandidates(observations = [], existingCandidates = [], tombstones = []) {
  const groups = new Map();
  const existingByKey = new Map(existingCandidates.map((candidate) => [candidate.commandKey, candidate]));
  const tombstoneKeys = new Set(tombstones.map((item) => item.commandKey).filter(Boolean));
  for (const observation of observations) {
    if (observation.intentType === "preference") {
      const key = `preference:${normalizeCommandKey(observation.input)}`;
      if (tombstoneKeys.has(key)) continue;
      const existing = existingByKey.get(key);
      const current = groups.get(key) ?? {
        id: `candidate_${stableId(key)}`,
        type: "preference_policy",
        status: existing?.status ?? "shadow",
        input: observation.input,
        commandKey: key,
        count: 0,
        confidence: 0,
        actions: [],
        preference: observation.preference,
        examples: [],
        safety: {
          level: "low",
          autoApply: false,
          reason: "偏好反馈默认仅 shadow，需要可解释策略确认后才自动生效",
        },
        note: existing?.note,
        application: existing?.application,
        updatedAt: existing?.updatedAt,
      };
      current.count += 1;
      current.confidence = Math.min(0.95, 0.5 + current.count * 0.18);
      current.examples = [observation.input, ...current.examples.filter((item) => item !== observation.input)].slice(0, 3);
      current.preference = observation.preference ?? current.preference;
      groups.set(key, current);
      continue;
    }
    if (!observation.success || observation.actions.length === 0) continue;
    const key = normalizeCommandKey(observation.input);
    if (tombstoneKeys.has(key)) continue;
    const existing = existingByKey.get(key);
    const current = groups.get(key) ?? {
      id: `candidate_${stableId(key)}`,
      type: inferCandidateType(observation.input),
      status: existing?.status ?? "shadow",
      input: observation.input,
      commandKey: key,
      count: 0,
      confidence: 0,
      actions: observation.actions,
      examples: [],
      safety: {
        level: "low",
        autoApply: false,
        reason: "学习候选默认仅 shadow，不自动执行",
      },
      note: existing?.note,
      application: existing?.application,
      updatedAt: existing?.updatedAt,
    };
    current.count += 1;
    current.confidence = Math.min(0.95, 0.45 + current.count * 0.15);
    current.examples = [observation.input, ...current.examples.filter((item) => item !== observation.input)].slice(0, 3);
    current.actions = mergeActions(current.actions, observation.actions);
    groups.set(key, current);
  }

  return Array.from(groups.values())
    .filter((candidate) => candidate.count >= 1)
    .sort((first, second) => second.confidence - first.confidence || second.count - first.count)
    .slice(0, 20);
}

export function summarizeLearningMemory(memory) {
  const normalized = normalizeMemory(memory);
  const correctionCandidates = deriveCorrectionCandidates(normalized.observations);
  return {
    version: normalized.version,
    updatedAt: normalized.updatedAt,
    mode: normalized.mode,
    observationCount: normalized.observations.length,
    candidateCount: normalized.candidates.length,
    ignoredCount: normalized.candidates.filter((candidate) => candidate.status === "ignored").length,
    acceptedCount: normalized.candidates.filter((candidate) => candidate.status === "accepted").length,
    topCandidates: normalized.candidates.filter((candidate) => candidate.status !== "ignored").slice(0, 5),
    acceptedCandidates: normalized.candidates.filter((candidate) => candidate.status === "accepted").slice(0, 5),
    ignoredCandidates: normalized.candidates.filter((candidate) => candidate.status === "ignored").slice(0, 5),
    correctionCandidates,
  };
}

export function compileHouseholdLearningContext(memory, { input = "" } = {}) {
  const normalized = normalizeMemory(memory);
  const activeCandidates = normalized.candidates.filter((candidate) => candidate.status !== "ignored");
  const correctionCandidates = deriveCorrectionCandidates(normalized.observations);
  const relevant = activeCandidates
    .filter((candidate) => candidateMatchesInput(candidate, input))
    .sort((first, second) => second.confidence - first.confidence || second.count - first.count);
  const fallback = isContextSensitiveInput(input)
    ? []
    : activeCandidates
    .filter((candidate) => !relevant.includes(candidate))
    .sort((first, second) => second.confidence - first.confidence || second.count - first.count);

  return {
    version: HOUSEHOLD_LEARNING_CONTEXT_VERSION,
    mode: normalized.mode,
    input,
    hints: [...relevant, ...fallback].slice(0, 6).map(toPlannerHint),
    preferenceHints: activeCandidates
      .filter((candidate) => candidate.type === "preference_policy")
      .slice(0, 6)
      .map((candidate) => ({
        id: candidate.id,
        input: candidate.input,
        confidence: candidate.confidence,
        preference: candidate.preference,
        safety: candidate.safety,
        instruction: "Use as a soft household preference; never bypass HCM grounding or safety gates.",
      })),
    correctionHints: correctionCandidates.slice(0, 5).map((candidate) => ({
      id: candidate.id,
      input: candidate.input,
      confidence: candidate.confidence,
      reason: candidate.reason,
      instruction: "This is a previous failure pattern; prefer clarification or stronger grounding if similar.",
    })),
    safety: {
      autoApply: false,
      reason: "Learning context is planner guidance only. It must not create executable actions without HCM grounding.",
    },
  };
}

export function deriveCorrectionCandidates(observations = []) {
  const groups = new Map();
  for (const observation of observations) {
    if (!["no_action", "needs_clarification", "rejected", "partial_failure", "error"].includes(observation.status)) continue;
    const key = normalizeCommandKey(observation.input);
    const current = groups.get(key) ?? {
      id: `correction_${stableId(key)}`,
      type: "correction_needed",
      status: "shadow",
      input: observation.input,
      commandKey: key,
      count: 0,
      confidence: 0,
      reason: inferCorrectionReason(observation),
      examples: [],
      safety: {
        autoApply: false,
        reason: "纠错候选只提示需要补充语义或映射，不自动执行",
      },
    };
    current.count += 1;
    current.confidence = Math.min(0.9, 0.35 + current.count * 0.2);
    current.examples = [observation.input, ...current.examples.filter((item) => item !== observation.input)].slice(0, 3);
    groups.set(key, current);
  }
  return Array.from(groups.values())
    .sort((first, second) => second.confidence - first.confidence || second.count - first.count)
    .slice(0, 5);
}

function createObservation(auditEntry, observedAt) {
  if (!auditEntry?.input) return null;
  const success = ["executed", "dry_run"].includes(auditEntry.status);
  const actions = (auditEntry.execution?.services ?? []).map((service) => ({
    thingId: service.thingId,
    thingName: service.thingName,
    capabilityId: service.capabilityId,
    capabilityName: service.capabilityName,
    service: service.service,
  }));
  return {
    id: auditEntry.commandId,
    observedAt,
    input: auditEntry.input,
    path: auditEntry.path,
    status: auditEntry.status,
    intentType: auditEntry.plan?.intentType,
    success,
    actions,
    preference: auditEntry.plan?.preference,
    safety: auditEntry.safety,
    explanation: auditEntry.explanation?.summary,
    rejected: auditEntry.execution?.rejectedCount ?? auditEntry.safety?.rejectedCount ?? 0,
  };
}

function inferCorrectionReason(observation) {
  if (observation.status === "no_action") return "没有找到可执行设备或能力，可能需要补充家庭语义/设备映射";
  if (observation.status === "needs_clarification") return "目标、集合成员或主执行器不完整，需要补充会话语义或控制图映射";
  if (observation.status === "rejected") return "安全门拒绝执行，可能需要确认风险边界或设备能力";
  if (observation.status === "partial_failure") return "部分设备执行失败，可能需要检查 provider service 支持";
  return "命令失败，需要诊断意图、设备或 adapter 映射";
}

function normalizeMemory(memory) {
  const base = memory && typeof memory === "object" ? memory : {};
  return createLearningMemory({
    updatedAt: base.updatedAt,
    observations: Array.isArray(base.observations) ? base.observations : [],
    candidates: Array.isArray(base.candidates) ? base.candidates : [],
    tombstones: Array.isArray(base.tombstones) ? base.tombstones : [],
  });
}

function normalizeCommandKey(input) {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/一下|帮我|请|把/g, "")
    .toLowerCase();
}

function candidateMatchesInput(candidate, input) {
  const key = normalizeCommandKey(input);
  if (!key) return false;
  if (candidate.commandKey === key) return true;
  return candidate.examples?.some((example) => normalizeCommandKey(example) === key) || normalizeCommandKey(candidate.input).includes(key);
}

function isContextSensitiveInput(input) {
  const text = normalizeCommandKey(input);
  return /^(还是)?(有点|太|不够|再)?(暗|亮|热|冷|闷)(啊|了|一点|点)?$/.test(text)
    || /^(还是)?(有点)?不够亮(啊|了)?$/.test(text)
    || /^(再)?亮一点$/.test(text)
    || /^(开|关|打开|关闭|关掉|停|停止)(一下)?$/.test(text);
}

function toPlannerHint(candidate) {
  const accepted = candidate.status === "accepted";
  return {
    id: candidate.id,
    type: candidate.type,
    status: candidate.status,
    input: candidate.input,
    confidence: candidate.confidence,
    count: candidate.count,
    actions: candidate.actions ?? [],
    preference: candidate.preference,
    application: candidate.application,
    examples: candidate.examples ?? [],
    safety: candidate.safety,
    instruction: accepted
      ? "User-confirmed household preference; prioritize it when relevant, but still ground targets, simulate, and enforce policy."
      : "Planner hint only; Harness must still ground targets, compile actions, simulate, and enforce policy.",
  };
}

function inferCandidateType(input) {
  if (/看电影|电影|睡觉|出门|回家|晾衣/.test(input)) return "scene";
  return "command_pattern";
}

function applicationModeForCandidate(candidate) {
  if (candidate.type === "preference_policy") return "preference";
  if (candidate.type === "scene") return "semantic";
  return "semantic";
}

function applicationSummaryForCandidate(candidate) {
  if (candidate.type === "preference_policy") return `以后会把“${candidate.input}”作为家庭偏好参考。`;
  return `以后会优先按已确认的“${candidate.input}”语义来理解类似指令。`;
}

function mergeActions(current, next) {
  const byKey = new Map();
  for (const action of [...current, ...next]) {
    byKey.set(`${action.thingId}:${action.capabilityId}:${action.service}`, action);
  }
  return Array.from(byKey.values()).slice(0, 12);
}

function stableId(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}
