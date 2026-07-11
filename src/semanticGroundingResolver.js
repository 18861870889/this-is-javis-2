import { findExplicitRoomIds, getHcmControlGraph } from "./hcmControlGraph.js";
import { getRoomLabels, hasSpecificRoomReference } from "./roomAliases.js";

export const SEMANTIC_GROUNDING_VERSION = "0.21";

export function normalizeSemanticPlannerActions(actions = [], { input = "", home } = {}) {
  const normalized = [];
  const rejected = [];

  for (const action of actions) {
    const resolved = resolveSemanticTarget(action, { input, home });
    if (!resolved.ok && resolved.code === "ambiguous_target" && shouldExpandLightCategoryTarget(action, resolved.candidates, { input, home })) {
      for (const target of resolved.candidates) {
        normalized.push({
          ...action,
          device_id: target.id,
          capability: action.capability || defaultCapabilityForTarget(target),
          reason: action.reason || `${action.target || action.device_id || action.name} 已展开到 ${target.name}`,
        });
      }
      continue;
    }
    if (!resolved.ok) {
      rejected.push(resolved.message);
      normalized.push(action);
      continue;
    }
    normalized.push({
      ...action,
      device_id: action.device_id || resolved.target.id,
      capability: action.capability || defaultCapabilityForTarget(resolved.target),
      reason: action.reason || resolved.reason,
    });
  }

  return { actions: normalized, rejected };
}

export function resolveSemanticGrounding({
  input = "",
  intentFrame,
  draftActions = [],
  normalizedActions = [],
  stateQuery = null,
  rejected = [],
  home,
} = {}) {
  const explicitRoomIds = findSpecificRoomIds(input, home);
  const frameTargets = (intentFrame?.grounding?.candidateTargets ?? [])
    .map((target) => resolveSemanticTarget({ target: target.targetRef || target.name, room_id: target.roomId }, { input, home }))
    .map((result) => groundingCandidateFromResult(result))
    .filter(Boolean);
  const draftTargets = draftActions
    .map((action) => resolveSemanticTarget(action, { input, home }))
    .map((result) => groundingCandidateFromResult(result))
    .filter(Boolean);
  const actionTargets = normalizedActions.map((action) => ({
    id: action.logicalAssetId ?? action.thingId,
    name: action.logicalAssetName ?? action.thingName,
    providerThingId: action.logicalAssetId ? action.thingId : undefined,
    roomId: action.logicalRoomId,
    role: "execution_target",
    confidence: intentFrame?.confidence ?? 0.6,
    evidence: evidenceList([action.reason, "normalized_hcm_action"]),
  }));
  const stateTarget = stateQuery?.thingId
    ? [{
        id: stateQuery.thingId,
        name: stateQuery.thingName,
        roomId: stateQuery.roomId,
        role: "read_target",
        confidence: intentFrame?.confidence ?? 0.6,
        evidence: evidenceList([stateQuery.reason, "local_hcm_state_answer"]),
      }]
    : [];
  const inferredTargets = inferTargetsFromGoal({ input, intentFrame, home });
  const targetCandidates = dedupeCandidates([
    ...actionTargets,
    ...stateTarget,
    ...draftTargets,
    ...frameTargets,
    ...inferredTargets,
  ]);
  const ambiguity = classifyGroundingAmbiguity({
    intentFrame,
    targetCandidates,
    normalizedActions,
    stateQuery,
    rejected,
  });

  return {
    version: SEMANTIC_GROUNDING_VERSION,
    status: ambiguity.status,
    explicitRoomIds,
    targetCandidates,
    rejected,
    ambiguity,
    requiredFacts: intentFrame?.grounding?.requiredFacts ?? [],
    evidence: evidenceList([
      intentFrame?.grounding?.evidence,
      targetCandidates.flatMap((candidate) => candidate.evidence ?? []),
    ]),
  };
}

export function resolveSemanticTarget(action = {}, { input = "", home } = {}) {
  const targetRef = firstNonEmpty(action.device_id, action.thingId, action.target, action.target_id, action.name);
  if (!targetRef) return { ok: false, code: "missing_target", message: "语义动作缺少目标设备" };
  const actionRoomIds = new Set(action.room_id ? [action.room_id] : []);
  const inputRoomIds = new Set(findSpecificRoomIds(input, home));
  const explicitRoomIds = new Set([...actionRoomIds, ...inputRoomIds]);
  const semanticTargets = listSemanticTargets(home);
  let candidates = semanticTargets.filter((candidate) => matchesTarget(candidate, targetRef));
  const fallbackRoomIds = actionRoomIds.size > 0 ? actionRoomIds : inputRoomIds;
  if (candidates.length === 0 && fallbackRoomIds.size > 0 && looksLikeGenericLightTarget(targetRef)) {
    candidates = semanticTargets.filter((candidate) => fallbackRoomIds.has(candidate.roomId) && isLightTarget(candidate));
  }
  if (candidates.length === 0 && fallbackRoomIds.size > 0 && lightCategoryForTarget(targetRef)) {
    candidates = semanticTargets.filter((candidate) =>
      fallbackRoomIds.has(candidate.roomId) && targetLightCategoryMatchesCandidate(targetRef, candidate),
    );
  }
  const roomFiltered = explicitRoomIds.size > 0
    ? candidates.filter((candidate) => explicitRoomIds.has(candidate.roomId))
    : candidates;
  if (explicitRoomIds.size > 0 && roomFiltered.length === 0) {
    const nameFiltered = candidates.filter((candidate) => candidateMentionsAnyRoom(candidate, explicitRoomIds, home));
    if (nameFiltered.length > 0) {
      candidates = nameFiltered;
    } else {
      return { ok: false, code: "room_mismatch", message: `语义目标 ${targetRef} 不在指定房间` };
    }
  }
  const usable = explicitRoomIds.size > 0 ? (roomFiltered.length > 0 ? roomFiltered : candidates) : candidates;
  if (usable.length === 0) return { ok: false, code: "unknown_target", message: `未知语义目标 ${targetRef}` };
  const primaryRoomLight = preferPrimaryRoomLightForGenericTarget(targetRef, usable, { home });
  if (primaryRoomLight) {
    return {
      ok: true,
      target: primaryRoomLight,
      reason: `${targetRef} 已按房间主灯落地到 HCM ${primaryRoomLight.name}`,
    };
  }
  if (usable.length > 1) {
    return {
      ok: false,
      code: "ambiguous_target",
      message: `语义目标 ${targetRef} 匹配到多个候选：${usable.map((item) => item.name).join("、")}`,
      candidates: usable,
    };
  }
  return {
    ok: true,
    target: usable[0],
    reason: `${targetRef} 已落地到 HCM ${usable[0].name}`,
  };
}

function listSemanticTargets(home) {
  const graph = getHcmControlGraph(home);
  const logicalAssets = graph.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    aliases: asset.aliases ?? [],
    roomId: asset.spaceId,
    type: asset.type,
    role: "logical_asset",
    defaultCapability: "power",
    mappingStatus: asset.mappingStatus,
  }));
  const things = (home?.things ?? []).map((thing) => ({
    id: thing.id,
    name: thing.name,
    aliases: thing.aliases ?? [],
    roomId: thing.spaceId,
    type: thing.type,
    role: "hcm_thing",
    defaultCapability: firstExecutableCapability(thing),
  }));
  return [...logicalAssets, ...things];
}

function firstExecutableCapability(thing) {
  const capability = (thing.capabilities ?? []).find((item) => item.policy?.autoExecutable && ["control", "action"].includes(item.kind));
  return capability?.id ?? "";
}

function matchesTarget(candidate, targetRef) {
  const normalizedRef = normalizeText(targetRef);
  const labels = [candidate.id, candidate.name, ...(candidate.aliases ?? [])].map(normalizeText).filter(Boolean);
  return labels.some((label) => label === normalizedRef || label.includes(normalizedRef) || normalizedRef.includes(label));
}

function looksLikeGenericLightTarget(targetRef) {
  const text = normalizeText(targetRef);
  return /灯|照明|light/.test(text) && !/射灯|吊灯|灯带|台灯|主灯|吸顶灯|壁灯|筒灯/.test(text);
}

function isLightTarget(candidate) {
  return candidate.type === "light" || /灯|light/i.test(candidate.name);
}

function shouldExpandLightCategoryTarget(action, candidates = [], { input = "", home } = {}) {
  const targetRef = firstNonEmpty(action.target, action.device_id, action.thingId, action.name);
  const roomIds = new Set([
    ...(action.room_id ? [action.room_id] : []),
    ...findSpecificRoomIds(input, home),
  ]);
  return Boolean(lightCategoryForTarget(targetRef)) && roomIds.size > 0 && candidates.length > 1;
}

function targetLightCategoryMatchesCandidate(targetRef, candidate) {
  const category = lightCategoryForTarget(targetRef);
  const name = normalizeText(candidate?.name);
  if (!category || !isLightTarget(candidate)) return false;
  if (category === "spotlight") return /射灯/.test(name);
  if (category === "ceiling") return /吊灯|吸顶灯|主灯/.test(name);
  if (category === "strip") return /灯带|氛围灯/.test(name);
  return false;
}

function lightCategoryForTarget(targetRef) {
  const text = normalizeText(targetRef);
  if (/射灯/.test(text)) return "spotlight";
  if (/吊灯|吸顶灯|主灯/.test(text)) return "ceiling";
  if (/灯带|氛围灯/.test(text)) return "strip";
  return "";
}

function preferPrimaryRoomLightForGenericTarget(targetRef, candidates = [], { home } = {}) {
  if (!looksLikeGenericLightTarget(targetRef)) return null;
  const targetRooms = findSpecificRoomIds(targetRef, home);
  if (targetRooms.length === 0) return null;
  const sameRoom = candidates.filter((candidate) => targetRooms.includes(candidate.roomId) && isLightTarget(candidate));
  if (sameRoom.length <= 1) return null;
  const primary = sameRoom.filter((candidate) => /主灯|吸顶灯|吊灯/.test(normalizeText(candidate.name)));
  if (primary.length === 1) return primary[0];
  return null;
}

function findSpecificRoomIds(input, home) {
  if (!hasSpecificRoomReference(input, home)) return [];
  return findExplicitRoomIds(input, home);
}

function candidateMentionsAnyRoom(candidate, roomIds, home) {
  const text = [candidate.id, candidate.name, ...(candidate.aliases ?? [])].map(normalizeText).join(" ");
  return Array.from(roomIds).some((roomId) =>
    getRoomLabels(roomId, home)
      .map(normalizeText)
      .filter(Boolean)
      .some((label) => text.includes(label)),
  );
}

function defaultCapabilityForTarget(target) {
  return target.role === "logical_asset" ? "power" : target.defaultCapability || "";
}

function inferTargetsFromGoal({ input, intentFrame, home }) {
  const refs = [
    ...(intentFrame?.goal?.targetRefs ?? []),
    ...(intentFrame?.goal?.spaceRefs ?? []),
  ];
  const targets = [];
  for (const ref of refs) {
    const result = resolveSemanticTarget({ target: ref }, { input, home });
    const candidate = groundingCandidateFromResult(result);
    if (candidate) targets.push({ ...candidate, role: "goal_candidate" });
  }
  return targets;
}

function groundingCandidateFromResult(result) {
  if (!result?.ok || !result.target) return null;
  return {
    id: result.target.id,
    name: result.target.name,
    roomId: result.target.roomId,
    type: result.target.type,
    role: result.target.role,
    confidence: 0.75,
    evidence: evidenceList([result.reason, result.target.mappingStatus]),
  };
}

function classifyGroundingAmbiguity({ intentFrame, targetCandidates, normalizedActions, stateQuery, rejected }) {
  const unresolved = rejected.filter(Boolean);
  const frameHighAmbiguity = intentFrame?.ambiguity?.needsClarification || intentFrame?.ambiguity?.level === "high";
  if (frameHighAmbiguity) {
    return {
      status: "needs_clarification",
      level: "high",
      reason: "模型显式标记需要澄清",
      unresolved,
    };
  }
  if (normalizedActions.length > 0 || stateQuery) {
    return {
      status: "resolved",
      level: "low",
      reason: "目标已归一化到 HCM action/query",
      unresolved,
    };
  }
  if (targetCandidates.length > 1) {
    return {
      status: "ambiguous",
      level: "medium",
      reason: "存在多个语义候选，但尚未形成可执行动作",
      unresolved,
    };
  }
  if (targetCandidates.length === 1) {
    return {
      status: "candidate_only",
      level: "medium",
      reason: "只有候选目标，缺少能力或参数",
      unresolved,
    };
  }
  return {
    status: unresolved.length > 0 ? "unresolved" : "empty",
    level: unresolved.length > 0 ? "high" : "low",
    reason: unresolved.length > 0 ? unresolved.join("；") : "没有可落地目标",
    unresolved,
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.id}:${candidate.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function evidenceList(values) {
  return [values]
    .flat(Infinity)
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/[，。！？,.!?\s]/g, "").toLowerCase();
}
