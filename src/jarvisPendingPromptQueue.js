export const JARVIS_PENDING_PROMPT_QUEUE_VERSION = "0.1";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_PROMPTS = 50;

export function createPendingPromptQueue({
  updatedAt = new Date().toISOString(),
  prompts = [],
} = {}) {
  return {
    version: JARVIS_PENDING_PROMPT_QUEUE_VERSION,
    updatedAt,
    prompts,
  };
}

export function enqueuePendingPrompt(queue, suggestion, {
  now = () => new Date().toISOString(),
  ttlMs = DEFAULT_TTL_MS,
  channel = "voice",
  context = {},
} = {}) {
  const next = normalizeQueue(queue);
  if (!suggestion) return { queue: next, prompt: null };
  const createdAt = now();
  const prompt = {
    id: `pending_${stableId(`${createdAt}:${suggestion.type}:${suggestion.candidateId ?? suggestion.suggestionId ?? suggestion.sourceCommandId ?? suggestion.prompt}`)}`,
    status: "pending",
    channel,
    type: suggestion.type,
    candidateId: suggestion.candidateId,
    suggestionId: suggestion.suggestionId,
    sourceCommandId: suggestion.sourceCommandId,
    deviceId: stringOr(context.deviceId),
    roomId: stringOr(context.roomId),
    wakeSessionId: stringOr(context.wakeSessionId),
    sessionId: stringOr(context.sessionId),
    prompt: suggestion.prompt,
    confidence: suggestion.confidence,
    createdAt,
    expiresAt: new Date(new Date(createdAt).getTime() + ttlMs).toISOString(),
  };
  next.prompts = [prompt, ...expireOldPrompts(next.prompts, createdAt)].slice(0, MAX_PROMPTS);
  next.updatedAt = createdAt;
  return { queue: next, prompt };
}

export function resolvePendingPromptForFeedback(queue, payload, { now = () => new Date().toISOString(), context = {} } = {}) {
  const next = normalizeQueue(queue);
  const request = payload && typeof payload === "object" ? { ...payload } : {};
  const explicitId = request.pendingPromptId;
  const hasExplicitTarget = Boolean(request.candidateId || request.suggestionId || request.sourceCommandId);
  const pendingPrompts = expireOldPrompts(next.prompts, now());
  next.prompts = pendingPrompts;
  next.updatedAt = now();
  const prompt = explicitId
    ? pendingPrompts.find((item) => item.id === explicitId && item.status === "pending")
    : hasExplicitTarget
      ? null
      : pendingPrompts.find((item) => item.status === "pending" && promptMatchesContext(item, context));
  if (!prompt) return { queue: next, payload: request, prompt: null };
  return {
    queue: next,
    prompt,
    payload: {
      ...request,
      candidateId: request.candidateId || prompt.candidateId || "",
      suggestionId: request.suggestionId || prompt.suggestionId || "",
      sourceCommandId: request.sourceCommandId || prompt.sourceCommandId || "",
      pendingPromptId: prompt.id,
    },
  };
}

export function updatePendingPromptDecision(queue, promptId, feedback, { updatedAt = new Date().toISOString() } = {}) {
  const next = normalizeQueue(queue);
  next.prompts = next.prompts.map((prompt) => {
    if (prompt.id !== promptId) return prompt;
    return {
      ...prompt,
      status: feedback === "accept" ? "accepted" : feedback === "undo" ? "undone" : "rejected",
      resolvedAt: updatedAt,
      feedback,
    };
  });
  next.updatedAt = updatedAt;
  return next;
}

export function summarizePendingPromptQueue(queue, { now = () => new Date().toISOString() } = {}) {
  const normalized = normalizeQueue(queue);
  const prompts = expireOldPrompts(normalized.prompts, now());
  return {
    version: normalized.version,
    updatedAt: normalized.updatedAt,
    pendingCount: prompts.filter((prompt) => prompt.status === "pending").length,
    resolvedCount: prompts.filter((prompt) => ["accepted", "rejected", "undone"].includes(prompt.status)).length,
    latestPendingPrompt: prompts.find((prompt) => prompt.status === "pending") ?? null,
    prompts,
  };
}

function normalizeQueue(queue) {
  const base = queue && typeof queue === "object" ? queue : {};
  return createPendingPromptQueue({
    updatedAt: typeof base.updatedAt === "string" ? base.updatedAt : new Date().toISOString(),
    prompts: Array.isArray(base.prompts) ? base.prompts.map(normalizePrompt).filter(Boolean) : [],
  });
}

function normalizePrompt(prompt) {
  if (!prompt || typeof prompt !== "object" || typeof prompt.id !== "string") return null;
  return {
    id: prompt.id,
    status: ["pending", "accepted", "rejected", "undone", "expired"].includes(prompt.status) ? prompt.status : "pending",
    channel: typeof prompt.channel === "string" ? prompt.channel : "voice",
    type: typeof prompt.type === "string" ? prompt.type : "semantic",
    candidateId: typeof prompt.candidateId === "string" ? prompt.candidateId : undefined,
    suggestionId: typeof prompt.suggestionId === "string" ? prompt.suggestionId : undefined,
    sourceCommandId: typeof prompt.sourceCommandId === "string" ? prompt.sourceCommandId : undefined,
    deviceId: typeof prompt.deviceId === "string" ? prompt.deviceId : undefined,
    roomId: typeof prompt.roomId === "string" ? prompt.roomId : undefined,
    wakeSessionId: typeof prompt.wakeSessionId === "string" ? prompt.wakeSessionId : undefined,
    sessionId: typeof prompt.sessionId === "string" ? prompt.sessionId : undefined,
    prompt: typeof prompt.prompt === "string" ? prompt.prompt : "",
    confidence: typeof prompt.confidence === "number" ? prompt.confidence : undefined,
    createdAt: typeof prompt.createdAt === "string" ? prompt.createdAt : new Date().toISOString(),
    expiresAt: typeof prompt.expiresAt === "string" ? prompt.expiresAt : new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
    resolvedAt: typeof prompt.resolvedAt === "string" ? prompt.resolvedAt : undefined,
    feedback: typeof prompt.feedback === "string" ? prompt.feedback : undefined,
  };
}

function promptMatchesContext(prompt, context) {
  const normalized = {
    deviceId: stringOr(context.deviceId),
    roomId: stringOr(context.roomId),
    wakeSessionId: stringOr(context.wakeSessionId),
    sessionId: stringOr(context.sessionId),
  };
  if (prompt.wakeSessionId && normalized.wakeSessionId && prompt.wakeSessionId === normalized.wakeSessionId) return true;
  if (prompt.sessionId && normalized.sessionId && prompt.sessionId === normalized.sessionId) return true;
  if (prompt.deviceId && normalized.deviceId && prompt.deviceId === normalized.deviceId) return true;
  if (prompt.roomId && normalized.roomId && prompt.roomId === normalized.roomId) return true;
  return !prompt.deviceId && !prompt.roomId && !prompt.wakeSessionId && !prompt.sessionId;
}

function stringOr(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expireOldPrompts(prompts, nowValue) {
  const nowTime = new Date(nowValue).getTime();
  return prompts.map((prompt) => {
    if (prompt.status !== "pending") return prompt;
    const expiresAt = new Date(prompt.expiresAt).getTime();
    if (Number.isNaN(expiresAt) || expiresAt > nowTime) return prompt;
    return { ...prompt, status: "expired" };
  });
}

function stableId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "unknown";
}
