import { hasSpecificRoomReference } from "./roomAliases.js";

export const JARVIS_VOICE_BRIDGE_VERSION = "0.1";

const CONTROL_VERBS = [
  ["打开", true],
  ["开启", true],
  ["开", true],
  ["关闭", false],
  ["关掉", false],
  ["关上", false],
  ["关", false],
  ["停止", false],
  ["停", false],
];
const CONTROL_SUFFIXES = [
  ["打开", true],
  ["开启", true],
  ["开一下", true],
  ["开", true],
  ["关闭", false],
  ["关掉", false],
  ["关上", false],
  ["关一下", false],
  ["关", false],
  ["停止", false],
  ["停一下", false],
  ["停", false],
];

const HOME_HINT_RE = /灯|射灯|吊灯|灯带|开关|空调|风扇|窗帘|电视|音箱|扫地|机器人|猫粮|门锁|燃气|水阀|阀门|书房|客厅|餐厅|厨房|主卧|次卧|阳台|卫生间|猫猫房/;
const STATE_QUERY_RE = /吗|状态|开着|关着|有没有|是不是|多少|几度|亮度|温度|湿度|人在|有人|无人/;
const CONTROL_INTENT_RE = /打开|开启|启动|关闭|关掉|关上|停止|暂停|调到|设置|播放|清扫/;
const FEEDBACK_RE = /^(可以|对|好的|好|以后就这样|记住|记住这个|不对|别这样|不要这样|撤销|取消|算了)(。|！|!|\.|\s)*$/;
const GENERIC_BEDROOM_RE = /卧室|睡房/;
const BEDROOM_ROOM_ID_RE = /bedroom|master|second|child|kid|kids|卧室|主卧|次卧|二卧/i;

export function normalizeUtterancePayload(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (typeof payload.text !== "string" || !payload.text.trim()) throw badRequest("text is required");
  for (const key of ["deviceId", "roomId", "trigger", "wakeSessionId", "locale", "sessionId"]) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") {
      throw badRequest(`${key} must be a string`);
    }
  }
  if (payload.dryRun !== undefined && typeof payload.dryRun !== "boolean") throw badRequest("dryRun must be a boolean");
  return {
    deviceId: payload.deviceId || "unknown",
    roomId: payload.roomId || "",
    trigger: payload.trigger || "voice",
    wakeSessionId: payload.wakeSessionId || payload.sessionId || "",
    locale: payload.locale || "zh-CN",
    text: payload.text.trim(),
    dryRun: Boolean(payload.dryRun),
  };
}

export function classifyUtterance(text) {
  const normalized = compact(text);
  if (FEEDBACK_RE.test(normalized)) return { route: "learning_feedback", reason: "explicit_feedback" };

  const fastControl = parseSimplePowerCommand(normalized);
  if (fastControl) {
    return {
      route: "hcm_fast_path",
      reason: "simple_power_command",
      plannerDraft: buildSimplePowerPlannerDraft(text, fastControl),
    };
  }

  if (HOME_HINT_RE.test(normalized)) {
    if (looksLikeReadOnlyHomeStateQuery(normalized)) {
      return {
        route: "hcm_fast_path",
        reason: "read_only_home_state_query",
        plannerDraft: buildSimpleStateQueryPlannerDraft(text),
      };
    }
    return {
      route: "hcm_slow_path",
      reason: "home_domain_command",
    };
  }

  return { route: "hermes_slow_path", reason: "general_assistant_request" };
}

export function buildHcmPayloadFromUtterance(utterance, classification) {
  const base = {
    input: utterance.text,
    currentRoomId: utterance.roomId || undefined,
    selectedRoomId: utterance.roomId || undefined,
    sessionId: utterance.wakeSessionId || utterance.deviceId,
    dryRun: utterance.dryRun,
    source: "voice",
  };
  if (classification.route === "hcm_fast_path") {
    return {
      ...base,
      skipPlanner: true,
      plannerDraft: addRoomContextToPlannerDraft(classification.plannerDraft, utterance.roomId, utterance.text),
    };
  }
  return base;
}

function addRoomContextToPlannerDraft(draft, roomId, input = "") {
  if (!draft || !shouldUseSourceRoomForImplicitTarget(input, roomId)) return draft;
  return {
    ...draft,
    actions: Array.isArray(draft.actions)
      ? draft.actions.map((action) => ({ room_id: roomId, ...action }))
      : draft.actions,
    query: draft.query && typeof draft.query === "object"
      ? { room_id: roomId, ...draft.query }
      : draft.query,
  };
}

export function shouldUseSourceRoomForImplicitTarget(input, roomId) {
  if (!roomId) return false;
  if (hasSpecificRoomReference(input)) return false;
  const text = compact(input);
  if (GENERIC_BEDROOM_RE.test(text) && !BEDROOM_ROOM_ID_RE.test(roomId)) return false;
  return true;
}

export function buildUtteranceDedupeKey(utterance) {
  const textKey = compact(utterance?.text);
  const sessionKey = String(utterance?.wakeSessionId ?? "").trim();
  if (sessionKey) return `session:${sessionKey}:${textKey}`;
  return `text:${textKey}`;
}

export function buildDuplicateUtteranceResponse({ utterance, handledByDeviceId, dedupeKey }) {
  return {
    version: JARVIS_VOICE_BRIDGE_VERSION,
    deviceId: utterance.deviceId,
    roomId: utterance.roomId,
    wakeSessionId: utterance.wakeSessionId,
    trigger: utterance.trigger,
    route: "duplicate_ignored",
    routeReason: "deduped_by_voice_bridge",
    commandId: null,
    status: "duplicate_ignored",
    risk: "low",
    speak: false,
    display: "",
    replyText: "",
    learnedSuggestion: null,
    latencyMs: 0,
    duplicate: true,
    handledByDeviceId,
    dedupeKey,
  };
}

export function formatVoiceBridgeResponse({ utterance, classification, hcmResult, hermesResult, learningSuggestion }) {
  const commandId = hcmResult?.commandId ?? null;
  const status = hcmResult?.status ?? hermesResult?.status ?? "not_handled";
  const replyText =
    hcmResult?.explanation?.userMessage
    || hermesResult?.replyText
    || fallbackReplyFor(classification);
  return {
    version: JARVIS_VOICE_BRIDGE_VERSION,
    deviceId: utterance.deviceId,
    roomId: utterance.roomId,
    wakeSessionId: utterance.wakeSessionId,
    trigger: utterance.trigger,
    route: classification.route,
    routeReason: classification.reason,
    commandId,
    status,
    risk: hcmResult?.safety?.level ?? hcmResult?.trace?.safety?.level ?? "low",
    speak: Boolean(replyText),
    display: replyText,
    replyText,
    learnedSuggestion: learningSuggestion ?? null,
    latencyMs: hcmResult?.latencyMs ?? hermesResult?.latencyMs ?? 0,
  };
}

export function buildHermesUnavailableResponse(utterance, classification) {
  return formatVoiceBridgeResponse({
    utterance,
    classification,
    hermesResult: {
      status: "needs_hermes",
      replyText: "这个问题需要 Hermes 慢路径处理。当前语音桥已经收到请求，但还没有配置 Hermes API Server。",
      latencyMs: 0,
    },
  });
}

function buildSimplePowerPlannerDraft(input, parsed) {
  return {
    intent_type: "device_control",
    intent: input.trim(),
    confidence: parsed.confidence,
    summary: input.trim(),
    needs_confirmation: false,
    actions: [
      {
        target: parsed.target,
        capability: "power",
        value: parsed.value,
      },
    ],
  };
}

function buildSimpleStateQueryPlannerDraft(input) {
  const text = input.trim();
  return {
    intent_type: "state_query",
    intent: text,
    confidence: 0.82,
    summary: text,
    needs_confirmation: false,
    query: {
      mode: "state",
      reason: text,
    },
    actions: [],
  };
}

function looksLikeReadOnlyHomeStateQuery(text) {
  return STATE_QUERY_RE.test(text) && !CONTROL_INTENT_RE.test(text);
}

function parseSimplePowerCommand(text) {
  if (STATE_QUERY_RE.test(text)) return null;
  for (const [verb, value] of CONTROL_VERBS) {
    if (!text.startsWith(verb)) continue;
    const target = text.slice(verb.length).replace(/^(一下|下|那个|这个)/, "").trim();
    if (!target || target.length > 24 || !HOME_HINT_RE.test(target)) return null;
    return { target, value, confidence: 0.88 };
  }
  for (const [suffix, value] of CONTROL_SUFFIXES) {
    if (!text.endsWith(suffix)) continue;
    const target = text.slice(0, -suffix.length).replace(/(一下|下|那个|这个)$/, "").trim();
    if (!target || target.length > 24 || !HOME_HINT_RE.test(target)) return null;
    return { target, value, confidence: 0.84 };
  }
  return null;
}

function fallbackReplyFor(classification) {
  if (classification.route === "learning_feedback") return "我收到你的反馈了。";
  return "我收到了。";
}

function compact(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[，。！？,.!?]$/g, "");
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
