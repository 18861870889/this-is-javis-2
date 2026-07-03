import { normalizeIntentType } from "./intentResolution.js";

export const INTENT_FRAME_VERSION = "0.20";
export const PROMPT_CONTEXT_PACK_VERSION = "0.20";

export function buildPromptContextPackV2({
  input = "",
  home,
  devices = [],
  currentRoomId,
  selectedRoomId,
  personalSemantics = [],
  context,
  conversation,
  learningContext,
} = {}) {
  const spaces = (home?.spaces ?? []).map((space) => ({
    id: space.id,
    name: space.name,
    aliases: space.aliases ?? [],
    selected: space.id === selectedRoomId,
    current: space.id === currentRoomId,
    occupied: Boolean((context?.spaces ?? []).find((item) => item.id === space.id && item.occupied)),
  }));
  const roomNames = new Map(spaces.map((space) => [space.id, space.name]));
  const rooms = spaces.map((space) => ({
    id: space.id,
    name: space.name,
    selected: space.selected,
    current: space.current,
    occupied: space.occupied,
    affordances: summarizeRoomAffordances(devices.filter((device) => device.roomId === space.id)),
    devices: devices
      .filter((device) => device.roomId === space.id)
      .map((device) => compactPlannerDevice(device)),
  }));

  return {
    version: PROMPT_CONTEXT_PACK_VERSION,
    input,
    household: {
      provider: home?.provider ?? null,
      spaces,
      currentRoomId: currentRoomId ?? null,
      selectedRoomId: selectedRoomId ?? null,
      likelySpace: context?.likelySpace
        ? {
            id: context.likelySpace.id,
            name: context.likelySpace.name,
            confidence: context.likelySpace.confidence,
          }
        : null,
      occupiedSpaces: (context?.spaces ?? [])
        .filter((space) => space.occupied)
        .map((space) => ({
          id: space.id,
          name: space.name ?? roomNames.get(space.id) ?? space.id,
          confidence: space.confidence,
        })),
    },
    rooms,
    crossRoomDevices: devices
      .filter((device) => !device.roomId || !roomNames.has(device.roomId))
      .map((device) => compactPlannerDevice(device)),
    personalSemantics,
    learning: learningContext ?? null,
    conversation: compactConversation(conversation),
    policyContract: {
      plannerLevel: "semantic_home_intent",
      providerCallsAllowed: false,
      mustUseHcmIds: true,
      unsupportedAction: "ask_clarification_or_no_action",
      safety: [
        "Do not invent devices, rooms, or capabilities.",
        "Represent uncertainty explicitly instead of guessing.",
        "Return semantic intent and HCM-level actions only; Harness compiles provider calls.",
      ],
    },
  };
}

export function summarizePromptContextPack(pack) {
  return {
    version: pack?.version,
    rooms: pack?.rooms?.length ?? 0,
    devices: (pack?.rooms ?? []).reduce((sum, room) => sum + (room.devices?.length ?? 0), 0) + (pack?.crossRoomDevices?.length ?? 0),
    occupiedSpaces: pack?.household?.occupiedSpaces?.length ?? 0,
    learningHints: pack?.learning?.hints?.length ?? 0,
    personalSemanticHints: pack?.personalSemantics?.length ?? 0,
  };
}

export function normalizeIntentFrame(input, draft = {}) {
  const frame = draft?.intent_frame ?? draft?.intentFrame ?? draft?.frame ?? null;
  const actions = extractPlannerDraftActions(draft);
  const query = extractPlannerDraftQuery(draft);
  const intentType = normalizeIntentType(
    frame?.intent_type ?? frame?.intentType ?? draft?.intent_type,
    actions,
    query,
  );
  const goal = normalizeGoal(frame?.goal ?? frame, draft, input);
  const ambiguity = normalizeAmbiguity(frame?.ambiguity ?? draft?.ambiguity, draft);
  const decision = normalizeDecision(frame?.decision, draft, actions, intentType, ambiguity);

  return {
    version: INTENT_FRAME_VERSION,
    source: frame ? "llm_intent_frame" : "legacy_planner_draft",
    input,
    intentType,
    intent: stringOr(frame?.intent ?? draft?.intent, intentType),
    confidence: clampConfidence(frame?.confidence ?? draft?.confidence),
    goal,
    query,
    actions,
    grounding: {
      requiredFacts: arrayOfStrings(frame?.grounding?.required_facts ?? frame?.grounding?.requiredFacts),
      candidateTargets: normalizeCandidateTargets(
        frame?.grounding?.candidate_targets ?? frame?.grounding?.candidateTargets ?? frame?.candidate_targets,
      ),
      evidence: evidenceList([
        frame?.grounding?.evidence,
        frame?.evidence,
        draft?.summary,
      ]),
    },
    ambiguity,
    decision,
    response: {
      summary: stringOr(frame?.response?.summary ?? draft?.summary, ""),
      userMessage: stringOr(frame?.response?.user_message ?? frame?.response?.userMessage, ""),
    },
  };
}

export function extractPlannerDraftActions(draft = {}) {
  const frame = draft?.intent_frame ?? draft?.intentFrame ?? draft?.frame ?? {};
  const candidates = [
    ...(Array.isArray(draft?.actions) ? draft.actions : []),
    ...(Array.isArray(draft?.semantic_actions) ? draft.semantic_actions : []),
    ...(Array.isArray(frame?.actions) ? frame.actions : []),
    ...(Array.isArray(frame?.decision?.actions) ? frame.decision.actions : []),
    ...(Array.isArray(frame?.candidate_strategy) ? frame.candidate_strategy : []),
    ...(Array.isArray(frame?.candidateStrategy) ? frame.candidateStrategy : []),
  ];
  const seen = new Set();
  return candidates
    .map(normalizeDraftAction)
    .filter(Boolean)
    .filter((action) => {
      const key = `${action.device_id ?? action.target ?? ""}:${action.capability ?? ""}:${String(action.value)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function extractPlannerDraftQuery(draft = {}) {
  const frame = draft?.intent_frame ?? draft?.intentFrame ?? draft?.frame ?? {};
  const query = draft?.query ?? frame?.query ?? frame?.decision?.query ?? null;
  if (!query || typeof query !== "object") return null;
  return {
    mode: stringOr(query.mode, "state"),
    device_id: stringOr(query.device_id ?? query.thingId ?? query.target, ""),
    reason: stringOr(query.reason, ""),
  };
}

function compactPlannerDevice(device) {
  return {
    id: device.id,
    name: device.name,
    roomId: device.roomId,
    type: device.type,
    logicalAsset: Boolean(device.logicalAsset),
    aliases: device.aliases ?? [],
    state: device.state,
    capabilities: (device.capabilities ?? []).map((capability) => ({
      id: capability.id,
      name: capability.name,
      access: capability.access,
      operation: capability.operation,
      valueType: capability.valueType,
      state: capability.state,
    })),
  };
}

function summarizeRoomAffordances(devices) {
  const domains = new Set();
  const controls = [];
  const readables = [];
  for (const device of devices) {
    for (const capability of device.capabilities ?? []) {
      if (capability.operation) domains.add(capability.operation);
      const item = {
        deviceId: device.id,
        deviceName: device.name,
        capabilityId: capability.id,
        capabilityName: capability.name,
        operation: capability.operation,
        state: capability.state,
      };
      if (capability.access === "read") readables.push(item);
      else controls.push(item);
    }
  }
  return {
    operations: Array.from(domains).sort(),
    executable: controls.slice(0, 12),
    readOnly: readables.slice(0, 12),
  };
}

function compactConversation(conversation) {
  if (!conversation) return null;
  return {
    focusedTargets: (conversation.focusedTargets ?? []).map((target) => ({
      id: target.id,
      name: target.name,
      roomId: target.roomId,
    })),
    focusedRooms: (conversation.focusedRooms ?? []).map((room) => ({
      id: room.id,
      name: room.name,
    })),
    recentTurns: (conversation.recentTurns ?? []).slice(-4),
  };
}

function normalizeGoal(goal, draft, input) {
  const outcome = stringOr(goal?.desired_outcome ?? goal?.desiredOutcome ?? goal?.outcome ?? draft?.intent, "");
  return {
    domain: stringOr(goal?.domain, inferDomain(`${input} ${outcome}`)),
    outcome,
    spaceRefs: arrayOfStrings(goal?.space_refs ?? goal?.spaceRefs ?? goal?.spaces),
    targetRefs: arrayOfStrings(goal?.target_refs ?? goal?.targetRefs ?? goal?.targets),
    constraints: arrayOfStrings(goal?.constraints),
  };
}

function normalizeAmbiguity(ambiguity, draft) {
  const level = stringOr(ambiguity?.level, draft?.needs_confirmation ? "medium" : "low");
  return {
    level: ["low", "medium", "high"].includes(level) ? level : "low",
    needsClarification: Boolean(ambiguity?.needs_clarification ?? ambiguity?.needsClarification ?? false),
    ambiguousTerms: arrayOfStrings(ambiguity?.ambiguous_terms ?? ambiguity?.ambiguousTerms),
    alternatives: Array.isArray(ambiguity?.alternatives)
      ? ambiguity.alternatives.map((item) => stringOr(item, "")).filter(Boolean)
      : [],
  };
}

function normalizeDecision(decision, draft, actions, intentType, ambiguity) {
  const mode = stringOr(decision?.mode, inferDecisionMode(draft, actions, intentType, ambiguity));
  return {
    mode,
    reason: stringOr(decision?.reason ?? draft?.summary, ""),
    actions,
  };
}

function inferDecisionMode(draft, actions, intentType, ambiguity) {
  if (ambiguity?.needsClarification || ambiguity?.level === "high") return "ask_clarification";
  if (intentType === "state_query" || intentType === "inventory_query") return "answer";
  if (intentType === "preference") return "remember_preference";
  if (actions.length > 0) return "execute";
  if (draft?.needs_confirmation) return "ask_clarification";
  return "no_action";
}

function normalizeCandidateTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets
    .map((target) => {
      if (typeof target === "string") return { targetRef: target, confidence: 0.6, evidence: [] };
      if (!target || typeof target !== "object") return null;
      return {
        targetRef: stringOr(target.target_ref ?? target.targetRef ?? target.id ?? target.device_id ?? target.name, ""),
        name: stringOr(target.name ?? target.thingName, ""),
        roomId: stringOr(target.room_id ?? target.roomId, ""),
        confidence: clampConfidence(target.confidence),
        evidence: evidenceList([target.why, target.reason, target.evidence]),
      };
    })
    .filter(Boolean)
    .filter((target) => target.targetRef || target.name);
}

function normalizeDraftAction(action) {
  if (!action || typeof action !== "object") return null;
  const deviceId = stringOr(action.device_id ?? action.thingId ?? action.target_id ?? action.targetId, "");
  const target = stringOr(action.target ?? action.targetRef ?? action.name, "");
  const capability = stringOr(action.capability ?? action.capabilityId ?? action.operation, "");
  return {
    ...action,
    device_id: deviceId,
    target,
    room_id: stringOr(action.room_id ?? action.roomId, ""),
    capability,
    value: action.value,
    reason: stringOr(action.reason ?? action.why, ""),
  };
}

function inferDomain(text) {
  if (/灯|照明|亮|暗/.test(text)) return "lighting";
  if (/空调|热|冷|温度/.test(text)) return "climate";
  if (/窗帘|窗户/.test(text)) return "cover";
  if (/电视|电影|音箱|音乐|播放/.test(text)) return "media";
  if (/晾衣|衣服/.test(text)) return "laundry";
  return "general";
}

function evidenceList(values) {
  return [values]
    .flat(Infinity)
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function arrayOfStrings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.6;
  return Math.max(0, Math.min(1, value));
}
