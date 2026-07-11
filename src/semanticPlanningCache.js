import { createHash } from "node:crypto";

export const SEMANTIC_PLANNING_CACHE_VERSION = "0.1";

const DEFAULT_MIN_SUCCESSES = 1;
const DEFAULT_MAX_FAILURES = 0;

export function createSemanticPlanningCache({
  read = () => null,
  write = () => {},
  writeMarkdown = () => "",
  now = () => new Date(),
  minSuccesses = DEFAULT_MIN_SUCCESSES,
  maxFailures = DEFAULT_MAX_FAILURES,
} = {}) {
  function getState() {
    return normalizeSemanticPlanningCache(read());
  }

  function lookup(input, { homeSignature = "", currentRoomId = "" } = {}) {
    const state = getState();
    const result = findCachedSemanticPlan(state, input, {
      homeSignature,
      currentRoomId,
      minSuccesses,
      maxFailures,
    });
    const timestamp = now().toISOString();
    const next = {
      ...state,
      updatedAt: timestamp,
      stats: {
        ...state.stats,
        lookupCount: state.stats.lookupCount + 1,
        hitCount: state.stats.hitCount + (result.hit ? 1 : 0),
        missCount: state.stats.missCount + (result.hit ? 0 : 1),
      },
      entries: state.entries.map((entry) => result.hit && entry.id === result.entry.id
        ? { ...entry, hitCount: entry.hitCount + 1, lastHitAt: timestamp, updatedAt: timestamp }
        : entry),
    };
    write(next);
    return result.hit
      ? {
          ...result,
          entry: next.entries.find((entry) => entry.id === result.entry.id) ?? result.entry,
        }
      : result;
  }

  function recordSuccess(input, {
    plannerDraft = null,
    auditEntry = null,
    homeSignature = "",
    source = "",
    cacheHitId = "",
  } = {}) {
    const draft = clonePlannerDraft(plannerDraft);
    if (!draft) return getState();
    const timestamp = now().toISOString();
    const state = getState();
    const semanticKey = semanticPlanKey(input);
    if (!semanticKey) return state;
    const id = cacheHitId || stableCacheId(semanticKey, homeSignature);
    const existing = state.entries.find((entry) => entry.id === id || entry.semanticKey === semanticKey);
    const nextEntry = normalizeSemanticCacheEntry({
      ...(existing ?? {}),
      id: existing?.id || id,
      status: "active",
      semanticKey,
      normalizedInput: normalizeSemanticInput(input),
      examples: mergeExamples(existing?.examples, input),
      plannerDraft: draft,
      homeSignature: homeSignature || existing?.homeSignature || "",
      source: source || existing?.source || "unknown",
      successes: (existing?.successes ?? 0) + 1,
      failures: existing?.failures ?? 0,
      hitCount: existing?.hitCount ?? 0,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      lastVerifiedAt: timestamp,
      lastAuditCommandId: auditEntry?.commandId || existing?.lastAuditCommandId || "",
      lastStatus: auditEntry?.status || existing?.lastStatus || "",
      targets: extractAuditTargets(auditEntry),
    });
    const markdownPath = writeMarkdown(nextEntry);
    const finalEntry = markdownPath ? { ...nextEntry, markdownPath } : nextEntry;
    const next = {
      ...state,
      updatedAt: timestamp,
      stats: {
        ...state.stats,
        recordedSuccessCount: state.stats.recordedSuccessCount + 1,
      },
      entries: [finalEntry, ...state.entries.filter((entry) => entry.id !== finalEntry.id && entry.semanticKey !== finalEntry.semanticKey)],
    };
    write(next);
    return next;
  }

  function recordCacheOutcome(cacheHitId, { ok = false, auditEntry = null } = {}) {
    if (!cacheHitId) return getState();
    const timestamp = now().toISOString();
    const state = getState();
    const next = {
      ...state,
      updatedAt: timestamp,
      stats: {
        ...state.stats,
        cacheExecutionCount: state.stats.cacheExecutionCount + 1,
        cacheFailureCount: state.stats.cacheFailureCount + (ok ? 0 : 1),
      },
      entries: state.entries.map((entry) => {
        if (entry.id !== cacheHitId) return entry;
        const updated = {
          ...entry,
          successes: entry.successes + (ok ? 1 : 0),
          failures: entry.failures + (ok ? 0 : 1),
          lastVerifiedAt: timestamp,
          lastAuditCommandId: auditEntry?.commandId || entry.lastAuditCommandId,
          lastStatus: auditEntry?.status || entry.lastStatus,
          updatedAt: timestamp,
        };
        const markdownPath = writeMarkdown(updated);
        return markdownPath ? { ...updated, markdownPath } : updated;
      }),
    };
    write(next);
    return next;
  }

  return {
    getState,
    lookup,
    recordSuccess,
    recordCacheOutcome,
    stats: () => summarizeSemanticPlanningCache(getState()),
  };
}

export function findCachedSemanticPlan(cache, input, {
  homeSignature = "",
  currentRoomId = "",
  minSuccesses = DEFAULT_MIN_SUCCESSES,
  maxFailures = DEFAULT_MAX_FAILURES,
} = {}) {
  const state = normalizeSemanticPlanningCache(cache);
  const inputKey = semanticPlanKey(input);
  if (!inputKey) return { hit: false, reason: "unsupported_intent", key: "" };
  const active = state.entries.filter((entry) => {
    if (entry.status !== "active") return false;
    if (entry.successes < minSuccesses) return false;
    if (entry.failures > maxFailures) return false;
    if (entry.homeSignature && homeSignature && entry.homeSignature !== homeSignature) return false;
    return entry.semanticKey === inputKey;
  });
  if (active.length === 0) return { hit: false, reason: "no_matching_entry", key: inputKey };
  const entry = active.sort((first, second) => {
    const scoreA = first.successes * 10 + first.hitCount - first.failures * 20;
    const scoreB = second.successes * 10 + second.hitCount - second.failures * 20;
    return scoreB - scoreA || second.updatedAt.localeCompare(first.updatedAt);
  })[0];
  return {
    hit: true,
    reason: "semantic_key_match",
    key: inputKey,
    entry,
    plannerDraft: clonePlannerDraft(entry.plannerDraft),
    confidence: cacheHitConfidence(entry, { currentRoomId }),
  };
}

export function recordableHcmStatus(status = "") {
  return ["executed", "dry_run", "answered"].includes(String(status || "").trim());
}

export function successfulCacheExecutionStatus(status = "") {
  return ["executed", "dry_run", "answered", "no_action"].includes(String(status || "").trim());
}

export function semanticPlanKey(input = "", plannerDraft = null) {
  const draftAction = Array.isArray(plannerDraft?.actions) ? plannerDraft.actions[0] : null;
  const draftQuery = plannerDraft?.query && typeof plannerDraft.query === "object" ? plannerDraft.query : null;
  const action = inferSemanticAction(input, draftAction, draftQuery);
  const target = normalizeSemanticTarget(draftAction?.target || draftAction?.device_id || draftQuery?.target || draftQuery?.device_id || input);
  if (!action || !target) return "";
  return `${action}:${target}`;
}

export function normalizeSemanticInput(input = "") {
  return String(input || "")
    .trim()
    .replace(/[，。！？,.!?\s]/g, "")
    .replace(/^(请|麻烦|帮我|给我|替我|把|将)+/, "")
    .replace(/(一下|下|吧|啊|呀|呢|哈|了)+$/g, "");
}

export function homeSignatureFromHome(home = {}) {
  const spaces = (home.spaces ?? []).map((space) => `${space.id}:${space.name}`).sort();
  const things = (home.things ?? []).map((thing) => `${thing.id}:${thing.name}:${thing.spaceId || thing.roomId || ""}`).sort();
  const assets = (home.controlGraph?.assets ?? []).map((asset) => `${asset.id}:${asset.name}:${asset.spaceId || ""}`).sort();
  return createHash("sha1")
    .update(JSON.stringify({ spaces, things, assets }))
    .digest("hex")
    .slice(0, 16);
}

export function summarizeSemanticPlanningCache(cache) {
  const state = normalizeSemanticPlanningCache(cache);
  const eligible = state.entries.filter((entry) => entry.status === "active");
  const hitRate = state.stats.lookupCount > 0 ? state.stats.hitCount / state.stats.lookupCount : 0;
  const falseTriggerRate = state.stats.cacheExecutionCount > 0 ? state.stats.cacheFailureCount / state.stats.cacheExecutionCount : 0;
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    entryCount: state.entries.length,
    activeEntryCount: eligible.length,
    lookupCount: state.stats.lookupCount,
    hitCount: state.stats.hitCount,
    missCount: state.stats.missCount,
    hitRate,
    cacheExecutionCount: state.stats.cacheExecutionCount,
    cacheFailureCount: state.stats.cacheFailureCount,
    falseTriggerRate,
    recordedSuccessCount: state.stats.recordedSuccessCount,
  };
}

export function buildSemanticPlanMarkdown(entry) {
  const normalized = normalizeSemanticCacheEntry(entry);
  return [
    "---",
    `id: ${normalized.id}`,
    `status: ${normalized.status}`,
    "domain: home_control",
    `semanticKey: ${JSON.stringify(normalized.semanticKey)}`,
    `successes: ${normalized.successes}`,
    `failures: ${normalized.failures}`,
    `hitCount: ${normalized.hitCount}`,
    `source: ${normalized.source}`,
    `homeSignature: ${normalized.homeSignature}`,
    `lastVerifiedAt: ${normalized.lastVerifiedAt}`,
    "---",
    "",
    `# ${normalized.examples[0] || normalized.normalizedInput || normalized.semanticKey}`,
    "",
    "## 用户说法",
    ...normalized.examples.map((example) => `- ${example}`),
    "",
    "## 语义规划",
    "```json",
    JSON.stringify(normalized.plannerDraft, null, 2),
    "```",
    "",
    "## 最近执行结果",
    `- 最近状态：${normalized.lastStatus || "unknown"}`,
    `- 最近命令：${normalized.lastAuditCommandId || "unknown"}`,
    `- 目标：${normalized.targets.length ? normalized.targets.join("、") : "unknown"}`,
    "",
  ].join("\n");
}

function normalizeSemanticPlanningCache(input) {
  const base = input && typeof input === "object" ? input : {};
  const stats = base.stats && typeof base.stats === "object" ? base.stats : {};
  return {
    version: SEMANTIC_PLANNING_CACHE_VERSION,
    updatedAt: normalizeText(base.updatedAt),
    stats: {
      lookupCount: numberOr(stats.lookupCount, 0),
      hitCount: numberOr(stats.hitCount, 0),
      missCount: numberOr(stats.missCount, 0),
      recordedSuccessCount: numberOr(stats.recordedSuccessCount, 0),
      cacheExecutionCount: numberOr(stats.cacheExecutionCount, 0),
      cacheFailureCount: numberOr(stats.cacheFailureCount, 0),
    },
    entries: Array.isArray(base.entries) ? base.entries.map(normalizeSemanticCacheEntry).filter(Boolean) : [],
  };
}

function normalizeSemanticCacheEntry(entry = {}) {
  if (!entry || typeof entry !== "object") return null;
  const id = normalizeText(entry.id);
  const semanticKey = normalizeText(entry.semanticKey);
  if (!id && !semanticKey) return null;
  return {
    id: id || stableCacheId(semanticKey, entry.homeSignature),
    status: ["active", "shadow", "disabled"].includes(entry.status) ? entry.status : "active",
    semanticKey,
    normalizedInput: normalizeText(entry.normalizedInput),
    examples: Array.isArray(entry.examples) ? entry.examples.map(normalizeText).filter(Boolean).slice(0, 12) : [],
    plannerDraft: clonePlannerDraft(entry.plannerDraft),
    homeSignature: normalizeText(entry.homeSignature),
    source: normalizeText(entry.source),
    successes: numberOr(entry.successes, 0),
    failures: numberOr(entry.failures, 0),
    hitCount: numberOr(entry.hitCount, 0),
    markdownPath: normalizeText(entry.markdownPath),
    createdAt: normalizeText(entry.createdAt),
    updatedAt: normalizeText(entry.updatedAt),
    lastHitAt: normalizeText(entry.lastHitAt),
    lastVerifiedAt: normalizeText(entry.lastVerifiedAt),
    lastAuditCommandId: normalizeText(entry.lastAuditCommandId),
    lastStatus: normalizeText(entry.lastStatus),
    targets: Array.isArray(entry.targets) ? entry.targets.map(normalizeText).filter(Boolean) : [],
  };
}

function inferSemanticAction(input, action = null, query = null) {
  const text = normalizeSemanticInput(input);
  const intentType = normalizeText(action?.intent_type || query?.intent_type);
  if (query || /(开着|关着|状态|吗|么)$/.test(text)) return "state";
  const value = action?.value;
  if (value === true) return "turn_on";
  if (value === false) return "turn_off";
  if (/打开|开启|启动|开一下|开/.test(text)) return "turn_on";
  if (/关闭|关掉|关上|关一下|关/.test(text)) return "turn_off";
  if (intentType === "state_query") return "state";
  return "";
}

function normalizeSemanticTarget(value = "") {
  return normalizeSemanticInput(value)
    .replace(/^(打开|开启|启动|开一下|开|关闭|关掉|关上|关一下|关|查询|看看|看一下|请问)/, "")
    .replace(/(打开|开启|启动|开一下|开|关闭|关掉|关上|关一下|关|开着|关着|状态|吗|么)$/, "")
    .replace(/^(那个|这个|一下|下)+/, "")
    .replace(/(一下|下|的)+$/g, "");
}

function clonePlannerDraft(draft) {
  if (!draft || typeof draft !== "object") return null;
  return JSON.parse(JSON.stringify(draft));
}

function stableCacheId(semanticKey, homeSignature = "") {
  return `semantic_${createHash("sha1").update(`${semanticKey}:${homeSignature || "any"}`).digest("hex").slice(0, 12)}`;
}

function cacheHitConfidence(entry) {
  const total = entry.successes + entry.failures;
  const base = total > 0 ? entry.successes / total : 0.5;
  return Math.max(0, Math.min(0.99, base * 0.8 + Math.min(entry.hitCount, 10) * 0.01 + 0.15));
}

function mergeExamples(existing = [], input = "") {
  const examples = [normalizeText(input), ...(Array.isArray(existing) ? existing.map(normalizeText) : [])].filter(Boolean);
  return Array.from(new Set(examples)).slice(0, 12);
}

function extractAuditTargets(auditEntry = null) {
  const services = auditEntry?.execution?.services ?? [];
  if (!Array.isArray(services)) return [];
  return Array.from(new Set(services.map((service) => normalizeText(service.thingName)).filter(Boolean))).slice(0, 12);
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}
