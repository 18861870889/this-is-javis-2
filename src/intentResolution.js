export const INTENT_TYPES = {
  DEVICE_CONTROL: "device_control",
  STATE_QUERY: "state_query",
  INVENTORY_QUERY: "inventory_query",
  SCENE: "scene",
  PREFERENCE: "preference",
  CORRECTION: "correction",
  UNKNOWN: "unknown",
};

export function normalizeIntentType(value, actions = [], query = null) {
  const text = String(value ?? "").trim().toLowerCase();
  if (Object.values(INTENT_TYPES).includes(text)) return text;
  if (query) return INTENT_TYPES.STATE_QUERY;
  if (actions.length > 1) return INTENT_TYPES.SCENE;
  if (actions.length === 1) return INTENT_TYPES.DEVICE_CONTROL;
  return INTENT_TYPES.UNKNOWN;
}

export function createIntentResolution({
  input,
  draft,
  intentType,
  stateQuery,
  actions = [],
  rejected = [],
} = {}) {
  const targetCandidates = [];
  if (stateQuery) {
    targetCandidates.push({
      thingId: stateQuery.thingId,
      thingName: stateQuery.thingName,
      role: "read_target",
      confidence: clampConfidence(draft?.confidence),
      evidence: evidenceList([stateQuery.reason, "llm_selected_query_target", "hcm_thing_exists"]),
    });
  }
  for (const action of actions) {
    targetCandidates.push({
      thingId: action.logicalAssetId ?? action.thingId,
      thingName: action.logicalAssetName ?? action.thingName,
      providerThingId: action.logicalAssetId ? action.thingId : undefined,
      roomId: action.logicalRoomId,
      role: "control_target",
      confidence: clampConfidence(draft?.confidence),
      evidence: evidenceList([action.reason, "llm_selected_action_target", "hcm_capability_exists"]),
    });
  }

  return {
    input,
    type: intentType,
    intent: typeof draft?.intent === "string" && draft.intent.trim() ? draft.intent.trim() : intentType,
    confidence: clampConfidence(draft?.confidence),
    targetResolution: {
      status: targetCandidates.length > 0 ? "resolved" : "unresolved",
      candidates: targetCandidates,
    },
    capabilityResolution: {
      status: actions.length > 0 ? "resolved" : stateQuery ? "read_only" : "none",
      capabilities: actions.map((action) => ({
        thingId: action.logicalAssetId ?? action.thingId,
        providerThingId: action.logicalAssetId ? action.thingId : undefined,
        roomId: action.logicalRoomId,
        capabilityId: action.capabilityId,
        capabilityName: action.capabilityName,
        value: action.value,
        risk: action.risk,
        confirmation: action.confirmation,
        evidence: evidenceList([action.reason, action.binding?.entityId, action.binding?.domain]),
      })),
    },
    parameterResolution: {
      status: actions.length > 0 ? "resolved" : "none",
      parameters: actions.map((action) => ({
        thingId: action.thingId,
        capabilityId: action.capabilityId,
        value: action.value,
      })),
    },
    rejected,
  };
}

function evidenceList(values) {
  return values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
}

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.6;
  return Math.max(0, Math.min(1, value));
}
