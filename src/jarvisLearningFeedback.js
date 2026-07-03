import {
  deleteLearningCandidate,
  summarizeLearningMemory,
  updateLearningCandidate,
} from "./learningLayer.js";
import {
  summarizeAutomationSuggestions,
  updateAutomationSuggestionDecision,
} from "./automationSuggestionEngine.js";

export const JARVIS_LEARNING_FEEDBACK_VERSION = "0.1";

const ACCEPT_WORDS = new Set(["accept", "accepted", "yes", "ok", "可以", "对", "好的", "好", "以后就这样", "记住", "记住这个"]);
const REJECT_WORDS = new Set(["reject", "rejected", "no", "ignore", "ignored", "不对", "别这样", "不要这样"]);
const UNDO_WORDS = new Set(["undo", "delete", "撤销", "取消", "算了"]);

export function normalizeLearningFeedbackPayload(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  const feedback = normalizeFeedback(payload.feedback ?? payload.text);
  if (!feedback) throw badRequest("feedback must be accept, reject, or undo");
  for (const key of ["sourceCommandId", "candidateId", "suggestionId", "note"]) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") {
      throw badRequest(`${key} must be a string`);
    }
  }
  return {
    feedback,
    sourceCommandId: payload.sourceCommandId || "",
    candidateId: payload.candidateId || "",
    suggestionId: payload.suggestionId || "",
    note: payload.note || payload.text || "",
  };
}

export function applyJarvisLearningFeedback({
  payload,
  learningMemory,
  automationMemory,
  automationSuggestions = [],
  auditEntries = [],
  now = () => new Date().toISOString(),
}) {
  const request = normalizeLearningFeedbackPayload(payload);
  const updatedAt = now();

  if (request.suggestionId) {
    return applyAutomationFeedback({
      request,
      automationMemory,
      automationSuggestions,
      updatedAt,
    });
  }

  const candidate = findLearningCandidate({
    memory: learningMemory,
    candidateId: request.candidateId,
    sourceCommandId: request.sourceCommandId,
    auditEntries,
  });
  if (!candidate) {
    return {
      version: JARVIS_LEARNING_FEEDBACK_VERSION,
      appliedTo: "none",
      feedback: request.feedback,
      summary: "我还没有找到可以应用这条反馈的学习候选。",
      replyText: "我记下你的反馈了，但这次没有找到对应的习惯候选。",
      learningMemory,
      automationMemory,
    };
  }

  if (request.feedback === "undo") {
    const nextMemory = deleteLearningCandidate(learningMemory, candidate.id, { updatedAt });
    return feedbackResult({
      appliedTo: "semantic",
      feedback: request.feedback,
      summary: `已撤销“${candidate.input}”这条学习候选。`,
      replyText: `好，我已经撤销“${candidate.input}”这个习惯。`,
      learningMemory: nextMemory,
      automationMemory,
      candidate,
    });
  }

  const status = request.feedback === "accept" ? "accepted" : "ignored";
  const nextMemory = updateLearningCandidate(
    learningMemory,
    candidate.id,
    {
      status,
      note: request.note,
      sourceCommandId: request.sourceCommandId,
      application: status === "accepted"
        ? {
            mode: applicationModeForCandidate(candidate),
            sourceCommandId: request.sourceCommandId,
            summary: acceptedSummary(candidate),
          }
        : undefined,
    },
    { updatedAt },
  );

  return feedbackResult({
    appliedTo: status === "accepted" ? applicationModeForCandidate(candidate) : "none",
    feedback: request.feedback,
    summary: status === "accepted" ? acceptedSummary(candidate) : `已忽略“${candidate.input}”这条学习候选。`,
    replyText: status === "accepted"
      ? `好，我记住了：${acceptedSummary(candidate)}`
      : `好，我不会按“${candidate.input}”学习这个习惯。`,
    learningMemory: nextMemory,
    automationMemory,
    candidate: { ...candidate, status },
  });
}

export function selectUserVisibleLearningSuggestion({ learningSummary, automationSummary, sourceCommandId } = {}) {
  const automation = (automationSummary?.suggestions ?? [])
    .filter((item) => item.status === "shadow" && item.confidence >= 0.7)
    .sort((first, second) => second.confidence - first.confidence)[0];
  if (automation) {
    return {
      type: "automation",
      suggestionId: automation.id,
      sourceCommandId,
      prompt: `我发现你经常在${automation.trigger?.description ?? "类似场景"}做这件事：${automation.summary}。要不要以后我主动提醒你？`,
      confidence: automation.confidence,
    };
  }

  const candidate = (learningSummary?.topCandidates ?? [])
    .filter((item) => item.status === "shadow" && (item.count >= 2 || item.confidence >= 0.75))
    .sort((first, second) => second.confidence - first.confidence || second.count - first.count)[0];
  if (!candidate) return null;
  return {
    type: candidate.type === "preference_policy" ? "preference" : "semantic",
    candidateId: candidate.id,
    sourceCommandId,
    prompt: candidate.type === "preference_policy"
      ? `我学到一个偏好：“${candidate.input}”。要不要以后按这个偏好处理？`
      : `我发现你经常说“${candidate.input}”。要不要以后我优先按这个意思理解？`,
    confidence: candidate.confidence,
  };
}

function applyAutomationFeedback({ request, automationMemory, automationSuggestions, updatedAt }) {
  const suggestion = automationSuggestions.find((item) => item.id === request.suggestionId);
  if (!suggestion) {
    return {
      version: JARVIS_LEARNING_FEEDBACK_VERSION,
      appliedTo: "none",
      feedback: request.feedback,
      summary: "没有找到对应的自动化建议。",
      replyText: "我没找到这条自动化建议，先不改。",
      learningMemory: null,
      automationMemory,
    };
  }
  const status = request.feedback === "accept" ? "accepted" : request.feedback === "undo" ? "shadow" : "ignored";
  const nextMemory = updateAutomationSuggestionDecision(automationMemory, suggestion.id, status, { updatedAt });
  const summary = summarizeAutomationSuggestions(nextMemory, automationSuggestions.map((item) => (
    item.id === suggestion.id ? { ...item, status } : item
  )));
  return {
    version: JARVIS_LEARNING_FEEDBACK_VERSION,
    appliedTo: status === "accepted" ? "automation" : "none",
    feedback: request.feedback,
    summary: status === "accepted"
      ? `已确认自动化建议：${suggestion.title}`
      : status === "ignored"
      ? `已忽略自动化建议：${suggestion.title}`
      : `已撤销自动化建议确认：${suggestion.title}`,
    replyText: status === "accepted"
      ? `好，我会把“${suggestion.title}”作为已确认建议，后续执行仍会经过安全检查。`
      : status === "ignored"
      ? "好，我不会再提示这条自动化建议。"
      : "好，我已撤销这条自动化建议的确认。",
    learningMemory: null,
    automationMemory: nextMemory,
    automationSummary: summary,
    suggestion: { ...suggestion, status },
  };
}

function findLearningCandidate({ memory, candidateId, sourceCommandId, auditEntries }) {
  const candidates = memory?.candidates ?? [];
  if (candidateId) return candidates.find((item) => item.id === candidateId);
  const auditEntry = sourceCommandId ? auditEntries.find((item) => item.commandId === sourceCommandId) : null;
  if (!auditEntry) return null;
  const commandKey = normalizeCommandKey(auditEntry.input);
  return candidates.find((item) => item.commandKey === commandKey || normalizeCommandKey(item.input) === commandKey);
}

function feedbackResult({ appliedTo, feedback, summary, replyText, learningMemory, automationMemory, candidate }) {
  return {
    version: JARVIS_LEARNING_FEEDBACK_VERSION,
    appliedTo,
    feedback,
    summary,
    replyText,
    candidate,
    learningSummary: summarizeLearningMemory(learningMemory),
    learningMemory,
    automationMemory,
  };
}

function normalizeFeedback(value) {
  const text = String(value ?? "").trim().replace(/[，。！？,.!?]$/g, "");
  if (ACCEPT_WORDS.has(text)) return "accept";
  if (REJECT_WORDS.has(text)) return "reject";
  if (UNDO_WORDS.has(text)) return "undo";
  return null;
}

function applicationModeForCandidate(candidate) {
  return candidate.type === "preference_policy" ? "preference" : "semantic";
}

function acceptedSummary(candidate) {
  if (candidate.type === "preference_policy") return `以后会把“${candidate.input}”作为家庭偏好参考。`;
  return `以后会优先按“${candidate.input}”理解类似指令，但执行前仍会经过 HCM 安全检查。`;
}

function normalizeCommandKey(input) {
  return String(input ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/一下|帮我|请|把/g, "")
    .toLowerCase();
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
