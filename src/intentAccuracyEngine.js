import { isReferentialControlInput, isRoomScopedFollowUpInput } from "./conversationContext.js";

const AMBIGUOUS_LOCATION_PATTERN = /这边|这里|附近|当前|有点热|太热|有点冷|太冷|有点闷|太亮|太暗|有点暗|不够亮|还是暗|亮一点|再亮点|关一下|打开一下|调一下/;
const CONTROL_VERB_PATTERN = /打开|关闭|关掉|停止|暂停|启动|调到|设置|准备|我要|播放|看电影|晾衣|清扫/;
const ROOM_CONFIDENCE_THRESHOLD = 0.6;

export function evaluateIntentAccuracy({
  input = "",
  plan,
  home,
  context,
  currentRoomId,
  selectedRoomId,
  conversation,
} = {}) {
  const text = String(input);
  const explicitSpaces = findExplicitSpaces(text, home);
  const actionTargets = resolveActionTargets(plan, home);
  const likelySpace = context?.likelySpace?.confidence >= ROOM_CONFIDENCE_THRESHOLD ? context.likelySpace : null;
  const conversationRoomIds = focusedConversationRoomIds(conversation);
  const issues = [];

  if (isReferentialControlInput(text) && !isRoomScopedFollowUpInput(text) && conversation?.focusedTargets?.length > 0 && actionTargets.length > 0) {
    const focusedIds = new Set(conversation.focusedTargets.map((target) => target.id));
    const matchesConversation = actionTargets.some((target) => focusedIds.has(target.logicalAssetId ?? target.thingId));
    if (!matchesConversation) {
      issues.push(issue("conversation_target_mismatch", "critical", "省略指令的执行目标与上一轮会话目标不一致"));
    }
  }

  if (isRoomScopedFollowUpInput(text) && conversationRoomIds.size > 0 && actionTargets.length > 0) {
    const matchesConversationRoom = actionTargets.some((target) => conversationRoomIds.has(target.spaceId));
    if (!matchesConversationRoom) {
      issues.push(issue("conversation_room_mismatch", "critical", "省略指令的执行房间与最近会话房间不一致"));
    }
  }

  if (plan?.intentType !== "state_query" && CONTROL_VERB_PATTERN.test(text) && actionTargets.length === 0) {
    issues.push(issue("no_executable_target", "high", "控制类表达没有解析出可执行目标"));
  }

  if (explicitSpaces.length > 0 && actionTargets.length > 0) {
    const explicitIds = new Set(explicitSpaces.map((space) => space.id));
    const mismatched = actionTargets.filter((target) => !explicitIds.has(target.spaceId));
    if (mismatched.length === actionTargets.length) {
      issues.push(issue("explicit_room_mismatch", "high", "用户明确提到的房间和计划目标不一致"));
    }
  }

  if (AMBIGUOUS_LOCATION_PATTERN.test(text) && explicitSpaces.length === 0) {
    const matchesConversationRoom = conversationRoomIds.size > 0 && actionTargets.some((target) => conversationRoomIds.has(target.spaceId));
    if (matchesConversationRoom) {
      // Recent conversational focus is a stronger signal than passive occupancy for omitted-room follow-ups.
    } else if (likelySpace && actionTargets.length > 0 && !actionTargets.some((target) => target.spaceId === likelySpace.id)) {
      issues.push(issue("context_room_mismatch", "high", `当前最可能有人区域是${likelySpace.name}，但计划目标在其它房间`));
    } else if (!likelySpace && !selectedRoomId && !currentRoomId && actionTargets.length > 0) {
      issues.push(issue("ambiguous_room_without_context", "medium", "模糊房间表达缺少人在位置、当前房间或选中房间上下文"));
    }
  }

  if ((plan?.confidence ?? 1) < 0.45 && actionTargets.length > 0) {
    issues.push(issue("low_model_confidence", "medium", "模型置信度较低但生成了执行动作"));
  }

  const severity = highestSeverity(issues);
  const requiresConfirmation = issues.some((item) => ["high", "critical"].includes(item.severity));
  return {
    version: "0.1",
    ok: !requiresConfirmation,
    severity,
    requiresConfirmation,
    explicitSpaces,
    likelySpace: likelySpace ? compactSpace(likelySpace) : null,
    actionTargets,
    issues,
    summary: summarizeAccuracy(issues),
  };
}

export function applyIntentAccuracyGate(plan, analysis) {
  if (!plan || !analysis?.requiresConfirmation) {
    return {
      plan,
      rejected: [],
    };
  }
  return {
    plan: {
      ...plan,
      needsConfirmation: true,
      intentAccuracy: analysis,
      summary: `${plan.summary || "已生成计划。"} 但意图精度检查认为需要确认：${analysis.summary}`,
    },
    rejected: [],
  };
}

function focusedConversationRoomIds(conversation) {
  const ids = new Set();
  for (const room of conversation?.focusedRooms ?? []) {
    if (room?.id) ids.add(room.id);
  }
  for (const target of conversation?.focusedTargets ?? []) {
    if (target?.roomId) ids.add(target.roomId);
  }
  return ids;
}

function findExplicitSpaces(input, home) {
  const matches = [];
  for (const space of home?.spaces ?? []) {
    const names = [space.name, space.id, ...(space.aliases ?? [])].filter(Boolean);
    if (names.some((name) => input.includes(name))) {
      matches.push(compactSpace(space));
    }
  }
  return dedupeById(matches);
}

function resolveActionTargets(plan, home) {
  const thingsById = new Map((home?.things ?? []).map((thing) => [thing.id, thing]));
  return (plan?.actions ?? [])
    .map((action) => {
      const thing = thingsById.get(action.thingId ?? action.device_id);
      if (!thing) return null;
      const capability = thing.capabilities?.find((item) => item.id === (action.capabilityId ?? action.capability));
      return {
        thingId: thing.id,
        thingName: thing.name,
        thingType: thing.type,
        spaceId: action.logicalRoomId ?? thing.spaceId,
        logicalAssetId: action.logicalAssetId,
        logicalAssetName: action.logicalAssetName,
        capabilityId: capability?.id ?? action.capabilityId ?? action.capability,
        capabilityName: capability?.name ?? action.capabilityName,
        value: action.value,
      };
    })
    .filter(Boolean);
}

function issue(code, severity, message) {
  return { code, severity, message };
}

function summarizeAccuracy(issues) {
  if (issues.length === 0) return "意图目标、房间上下文和执行动作一致。";
  return issues.map((item) => item.message).join("；");
}

function highestSeverity(issues) {
  return issues.reduce((highest, item) => (severityRank(item.severity) > severityRank(highest) ? item.severity : highest), "low");
}

function severityRank(severity) {
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  if (severity === "low") return 1;
  return 0;
}

function compactSpace(space) {
  return {
    id: space.id,
    name: space.name,
    confidence: space.confidence,
  };
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
