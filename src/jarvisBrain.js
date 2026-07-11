import { classifyUtterance } from "./jarvisVoiceBridge.js";
import { ROOM_ALIASES } from "./roomAliases.js";

export const JARVIS_BRAIN_VERSION = "0.1";

export function buildJarvisBrainIntent({ text = "", utterance = {} } = {}) {
  const normalizedText = String(text || utterance.text || "").trim();
  const classification = classifyUtterance(normalizedText);
  if (classification.route === "learning_feedback") {
    return {
      version: JARVIS_BRAIN_VERSION,
      type: "learning_feedback",
      route: classification.route,
      reason: classification.reason,
      confidence: 0.9,
      classification,
    };
  }
  if (classification.route === "hcm_fast_path" || classification.route === "hcm_slow_path") {
    return {
      version: JARVIS_BRAIN_VERSION,
      type: "home_intent",
      route: classification.route,
      reason: classification.reason,
      confidence: classification.plannerDraft?.confidence ?? (classification.route === "hcm_fast_path" ? 0.82 : 0.55),
      homeIntent: createHomeIntentFromClassification(normalizedText, utterance, classification),
      classification,
    };
  }
  return {
    version: JARVIS_BRAIN_VERSION,
    type: "agent_task",
    route: "hermes_slow_path",
    reason: classification.reason,
    confidence: 0.6,
    classification,
  };
}

export function createPlannerDraftFromHomeIntent(homeIntent = {}) {
  if (!homeIntent || homeIntent.type !== "home_intent") return null;
  const semantic = homeIntent.semantic ?? {};
  const base = {
    intent_type: homeIntent.intentType,
    intent: homeIntent.userText ?? semantic.summary ?? "",
    confidence: homeIntent.confidence ?? 0.7,
    summary: semantic.summary ?? homeIntent.userText ?? "",
    needs_confirmation: Boolean(homeIntent.needsClarification),
    actions: [],
    intent_frame: {
      intent_type: homeIntent.intentType,
      intent: homeIntent.userText ?? semantic.summary ?? "",
      confidence: homeIntent.confidence ?? 0.7,
      goal: {
        domain: semantic.domain ?? "general",
        desired_outcome: semantic.summary ?? homeIntent.userText ?? "",
        space_refs: [semantic.roomId, semantic.roomName].filter(Boolean),
        target_refs: [semantic.target].filter(Boolean),
        constraints: [],
      },
      grounding: {
        required_facts: semantic.target ? [] : ["target"],
        candidate_targets: semantic.target
          ? [{ target_ref: semantic.target, name: semantic.target, confidence: homeIntent.confidence ?? 0.7, reason: "Jarvis Brain HomeIntent target" }]
          : [],
      },
      ambiguity: {
        level: homeIntent.needsClarification ? "high" : "low",
        needs_clarification: Boolean(homeIntent.needsClarification),
        ambiguous_terms: homeIntent.needsClarification ? [semantic.target || "target"] : [],
        alternatives: [],
      },
      decision: {
        mode: homeIntent.intentType === "state_query" ? "answer" : homeIntent.needsClarification ? "ask_clarification" : "execute",
        reason: semantic.summary ?? homeIntent.userText ?? "",
      },
    },
  };
  if (homeIntent.intentType === "state_query") {
    return {
      ...base,
      query: {
        mode: "state",
        target: semantic.target ?? "",
        room_id: semantic.roomId ?? "",
        reason: semantic.summary ?? homeIntent.userText ?? "",
      },
    };
  }
  if (homeIntent.intentType === "device_control" || homeIntent.intentType === "scene") {
    return {
      ...base,
      actions: [{
        target: semantic.target ?? "",
        room_id: semantic.roomId ?? "",
        capability: semantic.capability ?? "power",
        value: semantic.value,
        reason: semantic.summary ?? homeIntent.userText ?? "",
      }],
    };
  }
  return base;
}

function createHomeIntentFromClassification(text, utterance, classification) {
  const draft = classification.plannerDraft ?? {};
  const action = Array.isArray(draft.actions) ? draft.actions[0] : null;
  const query = draft.query && typeof draft.query === "object" ? draft.query : null;
  const intentType = draft.intent_type || (classification.reason === "read_only_home_state_query" ? "state_query" : "device_control");
  const explicitRoomId = extractExplicitRoomId(text);
  const roomId = action?.room_id || query?.room_id || explicitRoomId || utterance.roomId || "";
  const target = normalizeHomeTargetText(action?.target || query?.target || query?.device_id || query?.thingId || text, intentType);
  const value = action?.value ?? inferActionValue(text);
  return {
    version: JARVIS_BRAIN_VERSION,
    type: "home_intent",
    source: "jarvis_brain",
    userText: text,
    intentType,
    confidence: draft.confidence ?? 0.75,
    needsClarification: Boolean(draft.needs_confirmation),
    semantic: {
      domain: inferHomeDomain(target),
      action: intentType === "state_query" ? "read_state" : actionValueToSemanticAction(value),
      capability: action?.capability || "power",
      value,
      target,
      roomId,
      summary: draft.summary || text,
    },
  };
}

function normalizeHomeTargetText(value, intentType) {
  let text = String(value ?? "").trim();
  text = text.replace(/[。！？!?，,；;：:]+$/g, "").trim();
  text = text
    .replace(/^(请|麻烦|帮我|给我|替我|能不能|可以)?(帮我|给我|请|麻烦)?/u, "")
    .replace(/^(把|将|一下|下|那个|这个)+/u, "")
    .trim();
  if (intentType === "state_query") {
    return text
      .replace(/^(请问|查询|看看|看一下|帮我看看|帮我查一下|查一下)/u, "")
      .replace(/(现在|目前)?(是不是)?(还)?(开着|关着|打开|关闭|亮着|亮了吗|开了吗|关了吗|是什么状态|状态如何|状态怎么样)(吗|么)?$/u, "")
      .trim();
  }
  return text
    .replace(/^(打开|开启|开一下|开下|开|关闭|关掉|关上|关一下|关下|关)(一下|下)?/u, "")
    .replace(/^(把|将|一下|下|那个|这个)+/u, "")
    .trim();
}

function inferActionValue(text) {
  const value = String(text ?? "").trim();
  if (/(关闭|关掉|关上|关一下|关下|关灯|关)/u.test(value)) return false;
  if (/(打开|开启|开一下|开下|开灯|开)/u.test(value)) return true;
  return undefined;
}

function extractExplicitRoomId(text) {
  const value = String(text ?? "").trim();
  const matches = [];
  for (const [roomId, aliases] of ROOM_ALIASES) {
    for (const alias of aliases) {
      const index = value.indexOf(alias);
      if (index >= 0) matches.push({ roomId, alias, index });
    }
  }
  matches.sort((a, b) => a.index - b.index || b.alias.length - a.alias.length);
  return matches[0]?.roomId || "";
}

function actionValueToSemanticAction(value) {
  if (value === true) return "turn_on";
  if (value === false) return "turn_off";
  return "set";
}

function inferHomeDomain(target) {
  const text = String(target ?? "");
  if (/灯|射灯|吊灯|吸顶灯|照明|light/i.test(text)) return "lighting";
  if (/空调|温度|climate/i.test(text)) return "climate";
  if (/窗帘|cover|curtain/i.test(text)) return "cover";
  if (/电视|音箱|音乐|media/i.test(text)) return "media";
  return "general";
}
