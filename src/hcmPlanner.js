import { CAPABILITY_KINDS, POLICY_LEVELS } from "./hcm.js";
import {
  answerHcmOccupancyStateQuery,
  answerHcmRoomLightStateQuery,
  answerHcmStateQuery,
  answerHcmThingStateQuery,
  looksLikeStateQuery,
} from "./hcmStateQuery.js";
import { answerHcmCapabilityQuery, answerHcmInventoryQuery, looksLikeInventoryQuery } from "./hcmKnowledgeQuery.js";
import { isContextualTargetSelectionInput, isReferentialControlInput, isRoomScopedFollowUpInput } from "./conversationContext.js";
import { INTENT_TYPES, createIntentResolution, normalizeIntentType } from "./intentResolution.js";
import { findExplicitRoomIds, getHcmControlGraph, resolveControlAsset } from "./hcmControlGraph.js";
import { normalizeIntentFrame } from "./intentFrame.js";
import { normalizeSemanticPlannerActions, resolveSemanticGrounding } from "./semanticGroundingResolver.js";
import { getRoomLabels, hasSpecificRoomReference } from "./roomAliases.js";

const CONTROL_REQUEST_PATTERN = /打开|开启|启动|关闭|关一下|关掉|停止|暂停|调到|设置|播放|清扫|没关|忘了关|还开着/;
const BEDROOM_GENERIC_PATTERN = /卧室|睡房|房间/;
const BEDROOM_OPTION_PATTERN = /卧室|睡房|主卧|次卧|小孩房|儿童房/;

export function compileHcmForPlanner(
  home,
  { input = "", currentRoomId, selectedRoomId, focusTargetIds = [], focusRoomIds = [], limit = 80 } = {},
) {
  if (!home?.things) return [];
  const preferredSpaces = new Set([currentRoomId, selectedRoomId, ...focusRoomIds].filter(Boolean));
  const focusedTargets = new Set(focusTargetIds);
  const focusedRooms = new Set(focusRoomIds);
  let explicitSpaces = new Set(findExplicitRoomIds(input, home));
  const graph = getHcmControlGraph(home);
  const mappedEntityIds = new Set(graph.endpoints.map((endpoint) => endpoint.entityId));
  const genericBedroomResolution = resolveGenericBedroomReference(input, home, {
    currentRoomId,
    selectedRoomId,
    focusRoomIds,
  });
  if (genericBedroomResolution === "ambiguous") return [];
  if (genericBedroomResolution) explicitSpaces = new Set([genericBedroomResolution]);

  const physicalThings = home.things
    .map((thing) =>
      compileThing(
        thing,
        thing.type === "switch_panel"
          ? (capability) => capability.binding?.domain === "light" && !mappedEntityIds.has(capability.binding?.entityId)
          : () => true,
      ),
    );
  const logicalAssets = compileControlAssets(home);

  let candidates = [...logicalAssets, ...physicalThings].filter((thing) => thing.capabilities.length > 0);
  const focusedTargetRooms = new Set(candidates.filter((thing) => focusedTargets.has(thing.id)).map((thing) => thing.roomId).filter(Boolean));
  const referentialRooms = new Set([...focusedRooms, ...focusedTargetRooms]);
  if (explicitSpaces.size > 0) {
    candidates = candidates.filter((thing) => explicitSpaces.has(thing.roomId) || focusedTargets.has(thing.id));
  } else if (referentialRooms.size > 0 && isRoomScopedFollowUpInput(input)) {
    candidates = candidates.filter((thing) => referentialRooms.has(thing.roomId));
    candidates = applyContextualTargetSelection(input, candidates);
  } else if (focusedTargets.size > 0 && isReferentialControlInput(input)) {
    candidates = candidates.filter((thing) => focusedTargets.has(thing.id));
  } else if (focusedRooms.size > 0 && isReferentialControlInput(input)) {
    candidates = candidates.filter((thing) => focusedRooms.has(thing.roomId));
  }

  return candidates
    .sort((first, second) => {
      const focusDelta = Number(focusedTargets.has(second.id)) - Number(focusedTargets.has(first.id));
      if (focusDelta !== 0) return focusDelta;
      const spaceDelta = Number(preferredSpaces.has(second.roomId)) - Number(preferredSpaces.has(first.roomId));
      if (spaceDelta !== 0) return spaceDelta;
      const lightingPreferenceDelta = preferredLightRank(first, input) - preferredLightRank(second, input);
      if (lightingPreferenceDelta !== 0) return lightingPreferenceDelta;
      return second.capabilities.length - first.capabilities.length;
    })
    .slice(0, limit);
}

function resolveGenericBedroomReference(input, home, { currentRoomId, selectedRoomId, focusRoomIds = [] } = {}) {
  const text = normalizeText(input);
  if (!BEDROOM_GENERIC_PATTERN.test(text) || BEDROOM_OPTION_PATTERN.test(text.replace(/卧室|睡房|房间/g, ""))) return null;
  const bedroomOptions = bedroomClarificationOptions(home);
  if (bedroomOptions.length <= 1) return null;
  const optionIds = new Set(bedroomOptions.map((room) => room.id));
  const trustedRooms = Array.from(new Set([currentRoomId, selectedRoomId, ...focusRoomIds]
    .filter((roomId) => optionIds.has(roomId))));
  return trustedRooms.length === 1 ? trustedRooms[0] : "ambiguous";
}

export function buildNoPlannerDevicesDraft(input = "", home) {
  const text = normalizeText(input);
  const bedroomOptions = BEDROOM_GENERIC_PATTERN.test(text) ? bedroomClarificationOptions(home) : [];
  const summary = bedroomOptions.length > 1
    ? `你是指${bedroomOptions.map((room) => room.name).join("还是")}？我先不操作灯。`
    : "这个房间暂时没有可自动执行的设备，或者目标还不够明确。我先不操作设备。";
  return {
    intent_type: CONTROL_REQUEST_PATTERN.test(text) ? "device_control" : "unknown",
    intent: input,
    confidence: 0.25,
    summary,
    needs_confirmation: false,
    actions: [],
    intent_frame: {
      intent_type: CONTROL_REQUEST_PATTERN.test(text) ? "device_control" : "unknown",
      intent: input,
      confidence: 0.25,
      goal: {
        domain: text.includes("灯") ? "lighting" : "general",
        desired_outcome: summary,
        space_refs: bedroomOptions.map((room) => room.name),
        target_refs: [],
        constraints: [],
      },
      grounding: {
        required_facts: ["clarify_room"],
        candidate_targets: [],
      },
      ambiguity: {
        level: "high",
        needs_clarification: true,
        ambiguous_terms: bedroomOptions.length > 1 ? ["卧室"] : ["房间或设备"],
        alternatives: bedroomOptions.map((room) => room.name),
      },
      decision: {
        mode: "ask_clarification",
        reason: summary,
      },
    },
  };
}

function applyContextualTargetSelection(input, candidates) {
  if (!isContextualTargetSelectionInput(input)) return candidates;
  const text = normalizeText(input).replace(/^(第)?/, "").replace(/(吧|呢)$/, "");
  const matched = candidates.filter((thing) => targetSelectionMatchesThing(text, thing.name));
  return matched.length > 0 ? matched : candidates;
}

function targetSelectionMatchesThing(text, name) {
  const normalizedName = normalizeText(name);
  if (!text) return false;
  if (normalizedName.includes(text)) return true;
  if (text === "吊灯" || text === "主灯") return /吊灯|主灯|吸顶灯/.test(normalizedName);
  if (text === "灯带") return /灯带|氛围灯/.test(normalizedName);
  return false;
}

function bedroomClarificationOptions(home) {
  const bedroomRooms = (home?.spaces ?? [])
    .filter((space) => isBedroomLikeSpace(space) && hasRoomPlannerDevices(home, space.id))
    .map((space) => ({ id: space.id, name: space.name ?? space.id }));
  const seen = new Set();
  return bedroomRooms.filter((room) => {
    if (!room.id || seen.has(room.id)) return false;
    seen.add(room.id);
    return true;
  });
}

function isBedroomLikeSpace(space) {
  const labels = [space?.id, space?.name, ...(space?.aliases ?? [])].map(normalizeText).filter(Boolean);
  if (labels.some((label) => /卫生间|洗手间|主卫|公卫|bath/.test(label))) return false;
  return labels.some((label) => BEDROOM_OPTION_PATTERN.test(label));
}

function hasRoomPlannerDevices(home, roomId) {
  const graph = getHcmControlGraph(home);
  if (
    graph.assets.some((asset) => {
      const resolved = resolveControlAsset(home, asset.id);
      return asset.spaceId === roomId && asset.type === "light" && isPlannerExecutableCapability(resolved?.capability);
    })
  ) {
    return true;
  }
  return (home?.things ?? []).some((thing) => thing.spaceId === roomId && compileThing(thing).capabilities.length > 0);
}

export function normalizeHcmPlannerDraft(input, draft, home) {
  const intentFrame = normalizeIntentFrame(input, draft);
  const semanticActions = normalizeSemanticPlannerActions(intentFrame.actions, { input, home });
  const normalizedDraft = {
    ...draft,
    intent_type: intentFrame.intentType,
    query: intentFrame.query ?? draft?.query,
  };
  const correctionPlan = maybeCorrectionFeedbackPlan(input, normalizedDraft);
  if (correctionPlan) {
    return attachSemanticDiagnostics(correctionPlan, {
      input,
      intentFrame: { ...intentFrame, intentType: INTENT_TYPES.CORRECTION },
      draftActions: intentFrame.actions,
      normalizedActions: [],
      stateQuery: null,
      rejected: [],
      home,
    });
  }
  const preferencePlan = maybePreferenceFeedbackPlan(input, normalizedDraft);
  if (preferencePlan) {
    return attachSemanticDiagnostics(preferencePlan, {
      input,
      intentFrame,
      draftActions: intentFrame.actions,
      normalizedActions: [],
      stateQuery: null,
      rejected: [],
      home,
    });
  }

  const actions = semanticActions.actions;
  let normalizedActions = [];
  const rejected = [...semanticActions.rejected];
  const requestedIntentType = normalizeIntentType(intentFrame.intentType, [], null);
  const controlRequested = CONTROL_REQUEST_PATTERN.test(input) || ["device_control", "scene"].includes(requestedIntentType);

  for (const action of actions) {
    const result = resolvePlannerAction(input, action, home);
    if (!result.ok) {
      rejected.push(result.message);
      continue;
    }
    normalizedActions.push(toNormalizedAction(result, action));
  }
  normalizedActions = applyLightingComfortPolicy(input, normalizedActions, home, rejected);
  if (normalizedActions.length === 0 && controlRequested) {
    normalizedActions.push(...resolveResidualGroupActions(input, home));
  }
  const groupResolution = expandNumberedAssetGroup(input, normalizedActions, home);
  const resolvedActions = groupResolution.blocked ? [] : groupResolution.actions;
  if (groupResolution.blocked) rejected.push(...groupResolution.unresolved.map((item) => `${item.name} 没有已确认的可执行控制通道`));
  const capabilityQuery = resolvedActions.length === 0 && !controlRequested
    ? answerHcmCapabilityQuery(input, home, normalizedDraft?.query?.reason)
    : null;
  const inventoryQuery = resolvedActions.length === 0 && !controlRequested && !capabilityQuery && looksLikeInventoryQuery(input)
    ? answerHcmInventoryQuery(input, home, normalizedDraft?.query?.reason)
    : null;
  const roomLightStateQuery =
    resolvedActions.length === 0 && !controlRequested && !capabilityQuery && !inventoryQuery && requestedIntentType === "state_query"
      ? answerHcmRoomLightStateQuery(input, home, normalizedDraft?.query?.reason)
      : null;
  const selectedStateQuery =
    resolvedActions.length === 0 && !controlRequested && !capabilityQuery && !inventoryQuery && !roomLightStateQuery && requestedIntentType === "state_query" && looksLikeStateQuery(input) && hasStateQueryTarget(normalizedDraft)
      ? resolvePlannerStateQuery(input, normalizedDraft, home, rejected)
      : null;
  const occupancyStateQuery =
    resolvedActions.length === 0 && !controlRequested && !capabilityQuery && !inventoryQuery && !roomLightStateQuery && !selectedStateQuery && requestedIntentType === "state_query"
      ? answerHcmOccupancyStateQuery(input, home, normalizedDraft?.query?.reason)
      : null;
  const localStateQuery =
    resolvedActions.length === 0 && !controlRequested && !capabilityQuery && !inventoryQuery && !roomLightStateQuery && !selectedStateQuery && !occupancyStateQuery && requestedIntentType === "state_query" && looksLikeStateQuery(input)
      ? answerHcmStateQuery(input, home, normalizedDraft?.query?.reason)
      : null;
  const stateQuery =
    capabilityQuery ??
    roomLightStateQuery ??
    selectedStateQuery ??
    occupancyStateQuery ??
    localStateQuery ??
    inventoryQuery;
  const intentType = capabilityQuery || inventoryQuery
    ? "inventory_query"
    : controlRequested
      ? requestedIntentType === "scene" || resolvedActions.length > 1 ? "scene" : "device_control"
      : normalizeIntentType(draft?.intent_type, resolvedActions, stateQuery);
  const unresolvedControl = controlRequested && resolvedActions.length === 0 && !groupResolution.satisfied;
  const unresolvedStateQuery = requestedIntentType === "state_query" && !stateQuery && !inventoryQuery && looksLikeStateQuery(input);
  if (unresolvedStateQuery && rejected.length === 0) rejected.push("状态查询目标不够明确");
  const resolution = createIntentResolution({
    input,
    draft: normalizedDraft,
    intentType,
    stateQuery,
    actions: resolvedActions,
    rejected,
  });

  const plan = {
    id: crypto.randomUUID(),
    kind: inventoryQuery
      ? "hcm_inventory_query"
      : capabilityQuery
        ? "hcm_capability_query"
      : stateQuery
        ? "hcm_state_query"
        : unresolvedControl
          ? "unresolved_control"
          : unresolvedStateQuery
            ? "needs_clarification"
          : resolvedActions.length > 0
            ? "real_hcm"
            : "empty",
    input,
    path: "hcm-real",
    intent: typeof draft?.intent === "string" ? draft.intent : intentFrame.intent || intentType,
    intentType,
    confidence: clampConfidence(intentFrame.confidence),
    summary:
      stateQuery
        ? stateQuery.summary
        : groupResolution.satisfied
          ? "目标集合已经处于期望状态，无需执行设备动作。"
        : unresolvedControl && rejected.length > 0
          ? `没有继续执行：${rejected.join("；")}。`
        : unresolvedStateQuery
          ? summarizeStateClarification(input, home)
        : typeof draft?.summary === "string" && draft.summary.trim()
          ? draft.summary.trim()
        : resolvedActions.length > 0
          ? `准备执行 ${resolvedActions.length} 个真实设备动作。`
          : `没有找到可执行的真实设备动作。${rejected.join("；")}`,
    needsConfirmation:
      Boolean(draft?.needs_confirmation) ||
      unresolvedControl ||
      unresolvedStateQuery ||
      resolvedActions.some((action) => ["high", "sensitive"].includes(action.risk) || action.confirmation === "always"),
    requiresClarification: unresolvedControl || unresolvedStateQuery || intentFrame.decision?.mode === "ask_clarification" || intentFrame.ambiguity?.needsClarification,
    actions: resolvedActions,
    stateQuery,
    contextFocus: createContextFocus(input, home, {
      actions: resolvedActions,
      stateQuery,
      unresolvedControl,
    }),
    groupResolution,
    resolution,
    rejected,
    createdAt: new Date().toISOString(),
  };

  return attachSemanticDiagnostics(plan, {
    input,
    intentFrame,
    draftActions: intentFrame.actions,
    normalizedActions: resolvedActions,
    stateQuery,
    rejected,
    home,
  });
}

export function buildHcmPlannerSystemPrompt() {
  return [
    "You are Harness House HCM Planner.",
    "Convert the user's Chinese smart-home instruction into strict JSON only.",
    "Think at the semantic home layer first. Harness will compile HCM actions into provider calls later.",
    "Use only the provided HCM devices and capability ids.",
    "Never invent devices, rooms, or capabilities.",
    "Every user command must be interpreted by you first, including read-only state questions.",
    "Use personal_semantics as hints for household phrases, but still output only valid HCM device ids and capability ids.",
    "Use conversation.focused_targets as the primary referent for short follow-ups such as 关一下, 打开它, or 也打开. Never replace that referent with the selected room.",
    "Use conversation.focused_rooms for short follow-ups when the prior turn was a room-level query instead of a single device query.",
    "For generic follow-ups such as 关灯吧, 开灯吧, 吊灯, 射灯, 还是暗, or 不够亮, conversation.focused_rooms and the room of conversation.focused_targets are a hard scope. Do not jump to another room.",
    "If conversation.pending_partial_execution exists and the user confirms with phrases such as 执行其他可执行设备, 跳过离线的, or 继续吧, output exactly those pending actions with the same device ids, capabilities, and values.",
    "Prefer the user's selected/current room when the command is ambiguous.",
    "If the user is giving advice, preference, correction, or a default rule such as 建议, 以后, 下次, 默认, 我希望, or 记住, set intent_type to preference and return no actions.",
    "For ambiguous room light turn-on commands, prefer the household's learned/default light order instead of arbitrarily choosing a lamp.",
    "For brightness discomfort such as 太暗 or 还是有点暗, seek a brighter result: turn on another currently-off light in the same room before repeating an already-on switch.",
    "roomId is the semantic location of the controlled object, not necessarily the physical controller location.",
    "When the user explicitly names a room, only choose devices with that exact roomId.",
    "A logical light may be backed by a multi-gang wall switch; target the logical light device, never guess a switch panel.",
    "Only choose capabilities whose operation matches the user's intent.",
    "For state questions, choose exactly one HCM device in query.device_id and set query.mode to state.",
    "For inventory/count/list questions, set intent_type to inventory_query, query.mode to count or list, and return no actions.",
    "For control or scene commands, choose one or more executable capabilities in actions.",
    "Read-only capabilities may only be used to answer state questions; never put read_state capabilities in actions.",
    "For on/off controls, use boolean true or false.",
    "For temperature, brightness, fan percentage, or cover position, use a number.",
    "Return exactly this JSON shape. Keep actions as HCM-level actions, not provider service calls:",
    '{"intent_frame":{"intent_type":"state_query|inventory_query|device_control|scene|preference|unknown","intent":"string","confidence":0.0,"goal":{"domain":"lighting|climate|media|cover|laundry|general","desired_outcome":"string","space_refs":["room name or id"],"target_refs":["device name or id"],"constraints":[]},"grounding":{"required_facts":["string"],"candidate_targets":[{"target_ref":"thing id","name":"中文名","confidence":0.0,"reason":"中文短句"}]},"ambiguity":{"level":"low|medium|high","needs_clarification":false,"ambiguous_terms":[],"alternatives":[]},"decision":{"mode":"execute|answer|remember_preference|ask_clarification|no_action","reason":"中文短句"}},"intent_type":"state_query|inventory_query|device_control|scene|preference|unknown","intent":"string","confidence":0.0,"summary":"中文短句","needs_confirmation":false,"query":{"mode":"state|count|list","device_id":"thing id or empty","reason":"中文短句"},"actions":[{"device_id":"thing id","capability":"capability id","value":true,"reason":"中文短句"}]}',
  ].join("\n");
}

function attachSemanticDiagnostics(plan, { input, intentFrame, draftActions, normalizedActions, stateQuery, rejected, home }) {
  return {
    ...plan,
    intentFrame,
    grounding: resolveSemanticGrounding({
      input,
      intentFrame,
      draftActions,
      normalizedActions,
      stateQuery,
      rejected,
      home,
    }),
  };
}

function compileThing(thing, includeCapability = () => true) {
  const plannerCapabilities = (thing.capabilities ?? []).filter(includeCapability).filter(isPlannerCapability).map((capability) => ({
    id: capability.id,
    name: capability.name,
    kind: capability.kind,
    valueType: plannerValueType(capability),
    operation: operationForCapability(capability),
    state: capability.state,
    domain: capability.binding?.domain,
    access: capability.kind === CAPABILITY_KINDS.SENSOR ? "read" : "execute",
  }));

  return {
    id: thing.id,
    name: thing.name,
    roomId: thing.spaceId,
    type: thing.type,
    aliases: thing.aliases ?? [],
    state: compactThingState(thing),
    capabilities: plannerCapabilities,
  };
}

function compileControlAssets(home) {
  const graph = getHcmControlGraph(home);
  return graph.assets
    .map((asset) => {
      const resolved = resolveControlAsset(home, asset.id);
      const capability = resolved?.capability;
      const executable = capability && isPlannerExecutableCapability(capability);
      const capabilities = [];
      if (executable) {
        capabilities.push({
          id: "power",
          name: `${asset.name}开关`,
          kind: CAPABILITY_KINDS.CONTROL,
          valueType: "boolean",
          operation: "on_off",
          state: asset.state?.commandedState,
          domain: capability.binding?.domain,
          access: "execute",
        });
      }
      if (!executable && asset.state?.commandedState !== "unknown") {
        capabilities.push({
          id: "power_state",
          name: `${asset.name}回路状态`,
          kind: CAPABILITY_KINDS.SENSOR,
          valueType: "boolean",
          operation: "read_state",
          state: asset.state.commandedState,
          domain: capability?.binding?.domain,
          access: "read",
        });
      }
      return {
        id: asset.id,
        name: asset.name,
        roomId: asset.spaceId,
        type: asset.type,
        aliases: asset.aliases ?? [],
        logicalAsset: true,
        mappingStatus: asset.mappingStatus,
        mappingConfidence: asset.mappingConfidence,
        state: asset.state,
        capabilities,
      };
    })
    .filter((asset) => asset.capabilities.length > 0);
}

function isPlannerCapability(capability) {
  if (isPlannerReadableCapability(capability)) return true;
  if (!capability?.policy?.autoExecutable) return false;
  if (capability.policy.risk !== POLICY_LEVELS.LOW) return false;
  if (capability.policy.confirmation !== "never") return false;
  if (![CAPABILITY_KINDS.CONTROL, CAPABILITY_KINDS.ACTION].includes(capability.kind)) return false;
  return Boolean(operationForCapability(capability));
}

function isPlannerReadableCapability(capability) {
  return capability?.kind === CAPABILITY_KINDS.SENSOR && capability.state !== undefined;
}

function operationForCapability(capability) {
  if (capability.kind === CAPABILITY_KINDS.SENSOR) return "read_state";
  const domain = capability.binding?.domain;
  if (["light", "switch", "fan", "media_player"].includes(domain)) return "on_off";
  if (domain === "climate") return "temperature_or_on_off";
  if (domain === "cover") return "position_or_open_close";
  if (domain === "button") return "press";
  return null;
}

function plannerValueType(capability) {
  const operation = operationForCapability(capability);
  if (operation === "temperature_or_on_off" || operation === "position_or_open_close") return "boolean_or_number";
  if (operation === "press") return "boolean";
  return capability.valueType || "boolean";
}

function resolvePlannerAction(input, action, home) {
  const logical = resolveControlAsset(home, action?.device_id);
  if (logical?.asset) {
    if (action?.capability !== "power") {
      return { ok: false, message: `${logical.asset.name} 不支持 ${action?.capability ?? ""}` };
    }
    const explicitRoomIds = findSpecificRoomIds(input, home);
    if (
      explicitRoomIds.length > 0 &&
      !explicitRoomIds.includes(logical.asset.spaceId) &&
      !targetMentionsAnyRoom([logical.asset.id, logical.asset.name, ...(logical.asset.aliases ?? [])], explicitRoomIds, home)
    ) {
      return { ok: false, message: `${logical.asset.name} 不在用户指定的房间` };
    }
    if (!logical.endpoint || !logical.thing || !logical.capability) {
      return { ok: false, message: `${logical.asset.name} 没有已确认的可执行控制通道` };
    }
    if (!isPlannerExecutableCapability(logical.capability)) {
      return { ok: false, message: `${logical.asset.name} 的控制通道不是可自动执行能力` };
    }
    return {
      ok: true,
      logicalAsset: logical.asset,
      endpoint: logical.endpoint,
      thing: logical.thing,
      capability: logical.capability,
    };
  }
  const thing = home.things.find((item) => item.id === action?.device_id);
  if (!thing) return { ok: false, message: `未知设备 ${action?.device_id ?? ""}` };
  const explicitRoomIds = findSpecificRoomIds(input, home);
  if (
    explicitRoomIds.length > 0 &&
    thing.spaceId &&
    !explicitRoomIds.includes(thing.spaceId) &&
    !targetMentionsAnyRoom([thing.id, thing.name, ...(thing.aliases ?? [])], explicitRoomIds, home)
  ) {
    return { ok: false, message: `${thing.name} 不在用户指定的房间` };
  }
  const capability = thing.capabilities.find((item) => item.id === action?.capability)
    ?? (action?.capability === "power" ? thing.capabilities.find((item) => isPlannerExecutableCapability(item) && operationForCapability(item) === "on_off") : null);
  if (!capability) return { ok: false, message: `${thing.name} 不支持 ${action?.capability ?? ""}` };
  if (!isPlannerExecutableCapability(capability)) {
    return { ok: false, message: `${thing.name} ${capability.name} 不是可执行控制能力` };
  }
  return { ok: true, thing, capability };
}

function isPlannerExecutableCapability(capability) {
  if (!capability?.policy?.autoExecutable) return false;
  if (capability.policy.risk !== POLICY_LEVELS.LOW) return false;
  if (capability.policy.confirmation !== "never") return false;
  if (![CAPABILITY_KINDS.CONTROL, CAPABILITY_KINDS.ACTION].includes(capability.kind)) return false;
  return Boolean(operationForCapability(capability));
}

function findSpecificRoomIds(input, home) {
  if (!hasSpecificRoomReference(input)) return [];
  return findExplicitRoomIds(input, home);
}

function targetMentionsAnyRoom(labels, roomIds, home) {
  const text = labels.map(normalizeText).join(" ");
  return roomIds.some((roomId) =>
    getRoomLabels(roomId, home)
      .map(normalizeText)
      .filter(Boolean)
      .some((label) => text.includes(label)),
  );
}

function normalizePlannerValue(value, capability) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  if (capability.binding?.domain === "button") return true;
  return value;
}

function resolvePlannerStateQuery(input, draft, home, rejected) {
  const query = draft?.query;
  if (!query || typeof query !== "object") return null;
  const thingId = query.device_id || query.thingId;
  if (typeof thingId !== "string" || !thingId.trim()) {
    rejected.push("状态查询缺少 HCM device_id");
    return null;
  }
  const answer = answerHcmThingStateQuery(input, home, thingId, query.reason);
  if (!answer) {
    rejected.push(`状态查询目标不存在 ${thingId}`);
    return null;
  }
  return answer;
}

function hasStateQueryTarget(draft) {
  const query = draft?.query;
  if (!query || typeof query !== "object") return false;
  const thingId = query.device_id || query.thingId;
  return typeof thingId === "string" && thingId.trim().length > 0;
}

function resolveResidualGroupActions(input, home) {
  if (!(/还有|另一个|剩下/.test(input) && /没关|还开着|未关闭/.test(input))) return [];
  const graph = getHcmControlGraph(home);
  const groups = new Map();
  for (const asset of graph.assets) {
    const stem = numberedStem(asset.name);
    if (!stem || !String(input).includes(stem)) continue;
    const key = `${asset.spaceId}:${stem}`;
    const group = groups.get(key) ?? [];
    group.push(asset);
    groups.set(key, group);
  }
  const actions = [];
  for (const assets of groups.values()) {
    if (assets.length < 2) continue;
    for (const asset of assets.filter((item) => item.state?.commandedState !== false)) {
      const result = resolvePlannerAction(input, { device_id: asset.id, capability: "power", value: false }, home);
      if (result.ok) actions.push(toNormalizedAction(result, { value: false, reason: "根据当前回路状态关闭剩余开启成员" }));
    }
  }
  return dedupeActions(actions);
}

function toNormalizedAction(result, action) {
  return {
    thingId: result.thing.id,
    thingName: result.logicalAsset?.name ?? result.thing.name,
    providerThingName: result.logicalAsset ? result.thing.name : undefined,
    logicalAssetId: result.logicalAsset?.id,
    logicalAssetName: result.logicalAsset?.name,
    logicalRoomId: result.logicalAsset?.spaceId,
    capabilityId: result.capability.id,
    capabilityName: result.logicalAsset ? `${result.logicalAsset.name}开关` : result.capability.name,
    value: normalizePlannerValue(action.value, result.capability),
    reason: action.reason || `${result.thing.name} ${result.capability.name}`,
    risk: result.capability.policy.risk,
    confirmation: result.capability.policy.confirmation,
    binding: result.capability.binding,
  };
}

function expandNumberedAssetGroup(input, actions, home) {
  const graph = getHcmControlGraph(home);
  let expanded = [...actions];
  const unresolved = [];
  const groups = [];
  const processed = new Set();
  let satisfied = false;

  for (const action of actions) {
    if (!action.logicalAssetId || typeof action.value !== "boolean") continue;
    const stem = numberedStem(action.logicalAssetName);
    if (!stem || !String(input).includes(stem) || String(input).includes(action.logicalAssetName)) continue;
    const siblings = graph.assets.filter((asset) => asset.spaceId === action.logicalRoomId && numberedStem(asset.name) === stem);
    if (siblings.length < 2) continue;
    const groupKey = `${action.logicalRoomId}:${stem}:${action.value}`;
    if (processed.has(groupKey)) continue;
    processed.add(groupKey);
    const residualOnly = /还有|另一个|剩下/.test(input) && /没关|还开着|未关闭/.test(input) && action.value === false;
    const targets = residualOnly
      ? siblings.filter((asset) => asset.state?.commandedState !== action.value)
      : siblings;
    if (residualOnly) {
      expanded = expanded.filter((item) => !siblings.some((sibling) => sibling.id === item.logicalAssetId));
      satisfied = targets.length === 0;
    }
    groups.push({ stem, assetIds: siblings.map((asset) => asset.id), targetAssetIds: targets.map((asset) => asset.id), residualOnly });
    for (const sibling of targets) {
      if (expanded.some((item) => item.logicalAssetId === sibling.id)) continue;
      const result = resolvePlannerAction(input, { device_id: sibling.id, capability: "power", value: action.value }, home);
      if (!result.ok) {
        unresolved.push({ id: sibling.id, name: sibling.name, reason: result.message });
        continue;
      }
      expanded.push({
        thingId: result.thing.id,
        thingName: sibling.name,
        providerThingName: result.thing.name,
        logicalAssetId: sibling.id,
        logicalAssetName: sibling.name,
        logicalRoomId: sibling.spaceId,
        capabilityId: result.capability.id,
        capabilityName: `${sibling.name}开关`,
        value: action.value,
        reason: `集合指令 ${stem}`,
        risk: result.capability.policy.risk,
        confirmation: result.capability.policy.confirmation,
        binding: result.capability.binding,
      });
    }
  }

  return {
    mode: groups.length > 0 ? "numbered_group" : "single",
    groups,
    actions: dedupeActions(expanded),
    unresolved,
    blocked: unresolved.length > 0,
    satisfied,
  };
}

function numberedStem(name) {
  const text = String(name ?? "").trim();
  const stem = text.replace(/[0-9一二三四五六七八九十]+$/, "");
  return stem !== text && stem.length >= 2 ? stem : null;
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.thingId}:${action.capabilityId}:${action.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function maybePreferenceFeedbackPlan(input, draft) {
  if (!looksLikePreferenceFeedback(input, draft)) return null;
  const summary = summarizePreferenceFeedback(input);
  const intentType = "preference";
  return {
    id: crypto.randomUUID(),
    kind: "hcm_preference_feedback",
    input,
    path: "hcm-real",
    intent: typeof draft?.intent === "string" && draft.intent.trim() ? draft.intent.trim() : "记录家庭偏好",
    intentType,
    confidence: clampConfidence(draft?.confidence ?? 0.82),
    summary,
    needsConfirmation: false,
    requiresClarification: false,
    actions: [],
    stateQuery: null,
    groupResolution: { mode: "single", groups: [], unresolved: [], blocked: false },
    resolution: createIntentResolution({
      input,
      draft: { ...draft, intent_type: intentType, intent: "记录家庭偏好", confidence: draft?.confidence ?? 0.82 },
      intentType,
      stateQuery: null,
      actions: [],
      rejected: [],
    }),
    preference: inferPreferenceFeedback(input),
    rejected: [],
    createdAt: new Date().toISOString(),
  };
}

function maybeCorrectionFeedbackPlan(input, draft) {
  if (!looksLikeCorrectionFeedback(input, draft)) return null;
  const intentType = INTENT_TYPES.CORRECTION;
  return {
    id: crypto.randomUUID(),
    kind: "hcm_correction_feedback",
    input,
    path: "hcm-real",
    intent: typeof draft?.intent === "string" && draft.intent.trim() ? draft.intent.trim() : "记录纠错反馈",
    intentType,
    confidence: clampConfidence(draft?.confidence ?? 0.82),
    summary: "收到，我会把这条作为纠错反馈记录下来；这次不会操作设备，也不会自动改设备映射。",
    needsConfirmation: false,
    requiresClarification: false,
    actions: [],
    stateQuery: null,
    groupResolution: { mode: "single", groups: [], unresolved: [], blocked: false },
    resolution: createIntentResolution({
      input,
      draft: { ...draft, intent_type: intentType, intent: "记录纠错反馈", confidence: draft?.confidence ?? 0.82 },
      intentType,
      stateQuery: null,
      actions: [],
      rejected: [],
    }),
    correction: {
      source: "user_feedback",
      input,
      autoApply: false,
    },
    rejected: [],
    createdAt: new Date().toISOString(),
  };
}

function looksLikeCorrectionFeedback(input, draft) {
  const text = normalizeText(input);
  if (normalizeIntentType(draft?.intent_type, [], null) === INTENT_TYPES.CORRECTION) return true;
  return /(说错|搞错|错了|不对|不是这个|不是.*是|应该是|我看.*只有|其实.*是)/.test(text);
}

function looksLikePreferenceFeedback(input, draft) {
  const text = normalizeText(input);
  if (normalizeIntentType(draft?.intent_type, [], null) === "preference") return true;
  if (!/(建议|以后|下次|默认|优先|习惯|记住|我希望|我觉得|如果.*就)/.test(text)) return false;
  if (!/(灯|照明|亮|暗|射灯|吊灯|灯带|台灯|主灯)/.test(text)) return false;
  return /(默认|优先|先|再|如果|建议|以后|下次|记住)/.test(text);
}

function summarizePreferenceFeedback(input) {
  const preference = inferPreferenceFeedback(input);
  if (preference?.domain === "lighting" && preference.primary && preference.fallback) {
    return `收到，我会把这条作为灯光偏好：模糊开灯优先选${preference.primary}；如果你说还是暗，再补开${preference.fallback}。这次不会操作设备。`;
  }
  if (preference?.domain === "lighting" && preference.primary) {
    return `收到，我会把这条作为灯光偏好：模糊开灯优先选${preference.primary}。这次不会操作设备。`;
  }
  return "收到，我会把这条作为偏好反馈记录下来。这次不会操作设备。";
}

function inferPreferenceFeedback(input) {
  const text = normalizeText(input);
  const order = ["射灯", "台灯", "灯带", "吊灯", "主灯"].filter((name) => text.includes(name));
  return {
    domain: /灯|照明|亮|暗/.test(text) ? "lighting" : "general",
    primary: order[0] ?? null,
    fallback: /暗/.test(text) ? order[1] ?? null : null,
    order,
    source: "user_feedback",
  };
}

function applyLightingComfortPolicy(input, actions, home, rejected = []) {
  const text = normalizeText(input);
  if (actions.length === 0) return actions;
  if (looksLikeBrightnessBoost(text)) return resolveBrightnessBoostActions(input, actions, home, rejected);
  if (looksLikeAmbiguousLightTurnOn(text)) return resolvePreferredLightTurnOn(input, actions, home) ?? actions;
  return actions;
}

function looksLikeBrightnessBoost(text) {
  return /暗|不够亮|亮一点|再亮点|调亮/.test(text) && !/(关闭|关掉|关一下|太亮)/.test(text);
}

function looksLikeAmbiguousLightTurnOn(text) {
  if (!/(打开|开启|开一下|开灯|亮一点)/.test(text)) return false;
  if (mentionsSpecificLightName(text)) return false;
  return /灯|照明|开一下/.test(text);
}

function mentionsSpecificLightName(text) {
  return /射灯|吊灯|灯带|台灯|主灯|壁灯|筒灯|吸顶灯|[0-9一二三四五六七八九十]+号灯/.test(text);
}

function resolvePreferredLightTurnOn(input, actions, home) {
  const roomId = preferredRoomForLightPolicy(input, actions, home);
  if (!roomId) return null;
  const preferred = sortedRoomLightAssets(home, roomId)[0];
  if (!preferred) return null;
  const result = resolvePlannerAction(input, { device_id: preferred.id, capability: "power", value: true }, home);
  if (!result.ok) return null;
  return [toNormalizedAction(result, { value: true, reason: "模糊开灯使用灯光偏好顺序" })];
}

function resolveBrightnessBoostActions(input, actions, home, rejected) {
  const roomId = preferredRoomForLightPolicy(input, actions, home);
  if (!roomId) return actions;
  const candidate = sortedRoomLightAssets(home, roomId).find((asset) => asset.state?.commandedState !== true);
  if (!candidate) {
    const roomName = home.spaces?.find((space) => space.id === roomId)?.name ?? roomId;
    rejected.push(`${roomName}没有可继续打开的关闭灯光，也没有已确认的调光能力`);
    return [];
  }
  const result = resolvePlannerAction(input, { device_id: candidate.id, capability: "power", value: true }, home);
  if (!result.ok) {
    rejected.push(result.message);
    return [];
  }
  return [toNormalizedAction(result, { value: true, reason: "亮度补救：优先打开同房间仍关闭的灯" })];
}

function preferredRoomForLightPolicy(input, actions, home) {
  const explicitRoomIds = findExplicitRoomIds(input, home);
  if (explicitRoomIds.length === 1) return explicitRoomIds[0];
  const actionRoomIds = Array.from(new Set(actions.map((action) => action.logicalRoomId).filter(Boolean)));
  if (actionRoomIds.length === 1) return actionRoomIds[0];
  return null;
}

function createContextFocus(input, home, { actions = [], stateQuery, unresolvedControl = false } = {}) {
  const roomIds = new Set();
  if (stateQuery?.roomId) roomIds.add(stateQuery.roomId);
  for (const action of actions) {
    if (action.logicalRoomId) roomIds.add(action.logicalRoomId);
  }
  if (unresolvedControl) {
    for (const roomId of findExplicitRoomIds(input, home)) roomIds.add(roomId);
  }
  const rooms = Array.from(roomIds)
    .map((roomId) => {
      const room = home.spaces?.find((space) => space.id === roomId);
      return { id: roomId, name: room?.name ?? roomId };
    })
    .filter((room) => room.id);
  return {
    rooms,
    reason: rooms.length > 0 ? "用于后续省略指令和澄清回复的房间焦点" : "",
  };
}

function summarizeStateClarification(input, home) {
  const roomIds = findExplicitRoomIds(input, home);
  const roomName = roomIds.length === 1 ? home.spaces?.find((space) => space.id === roomIds[0])?.name ?? roomIds[0] : "";
  if (/传感器/.test(normalizeText(input)) && roomName) {
    return `${roomName}有多个可能的传感器目标。你想查人在/人体传感器、门窗传感器，还是其它传感器？`;
  }
  if (roomName) return `${roomName}里有多个可能目标，我需要你再说具体一点。`;
  return "这个状态查询目标还不够明确，我需要你补充房间或设备名称。";
}

function sortedRoomLightAssets(home, roomId) {
  return getHcmControlGraph(home).assets
    .filter((asset) => asset.spaceId === roomId && asset.type === "light")
    .sort((first, second) => preferredLightNameRank(first.name) - preferredLightNameRank(second.name) || first.name.localeCompare(second.name, "zh-CN"));
}

function preferredLightRank(thing, input) {
  const text = normalizeText(input);
  if (!looksLikeAmbiguousLightTurnOn(text) && !looksLikeBrightnessBoost(text)) return 99;
  if (thing?.type !== "light" && !thing?.logicalAsset) return 99;
  return preferredLightNameRank(thing.name);
}

function preferredLightNameRank(name) {
  const text = normalizeText(name);
  if (/射灯/.test(text)) return 0;
  if (/台灯/.test(text)) return 1;
  if (/灯带/.test(text)) return 2;
  if (/吊灯|主灯|吸顶灯/.test(text)) return 3;
  if (/灯/.test(text)) return 4;
  return 9;
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/[，。！？,.!?\s]/g, "");
}

function compactThingState(thing) {
  const state = {};
  for (const [key, value] of Object.entries(thing.state ?? {})) {
    if (["capabilityCount"].includes(key)) continue;
    state[key] = value;
  }
  return state;
}

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.6;
  return Math.max(0, Math.min(1, value));
}
