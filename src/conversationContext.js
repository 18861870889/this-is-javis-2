export const CONVERSATION_CONTEXT_VERSION = "0.1";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TURNS = 6;

export function createConversationContextStore({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const sessions = new Map();

  return {
    get(sessionId) {
      if (!sessionId) return emptyContext();
      const session = sessions.get(sessionId);
      if (!session || now() - session.updatedAt > ttlMs) {
        sessions.delete(sessionId);
        return emptyContext();
      }
      return compactContext(session);
    },
    record(sessionId, { input, plan, execution } = {}) {
      if (!sessionId || !input || !plan) return emptyContext();
      const current = sessions.get(sessionId) ?? { turns: [], focusedTargets: [], focusedRooms: [], updatedAt: now() };
      const targets = targetsFromPlan(plan);
      const rooms = roomsFromPlan(plan, targets);
      const pendingPartialExecution = pendingPartialExecutionFromPlan(plan, execution);
      const successful = ["answered", "executed", "dry_run"].includes(execution?.status);
      const canFocusClarification = execution?.status === "needs_clarification" && rooms.length > 0;
      const turn = {
        input,
        intent: plan.intent,
        intentType: plan.intentType,
        status: execution?.status ?? "unknown",
        targetIds: targets.map((target) => target.id),
        targetNames: targets.map((target) => target.name),
        roomIds: rooms.map((room) => room.id),
      };
      current.turns = [...current.turns, turn].slice(-MAX_TURNS);
      if (successful || canFocusClarification) {
        if (targets.length > 0) current.focusedTargets = targets;
        else if (rooms.length > 0) current.focusedTargets = [];
        if (rooms.length > 0) current.focusedRooms = rooms;
      }
      if (pendingPartialExecution) {
        current.pendingPartialExecution = pendingPartialExecution;
        current.focusedTargets = pendingPartialExecution.targets;
        current.focusedRooms = pendingPartialExecution.rooms;
      } else if (successful && execution?.status === "executed") {
        current.pendingPartialExecution = null;
      }
      current.updatedAt = now();
      sessions.set(sessionId, current);
      return compactContext(current);
    },
    clear(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

export function isReferentialControlInput(input) {
  const text = normalize(input);
  return /^(把)?(它|这个|那个)?(也)?(打开|开|关闭|关掉|关|停|停止|调一下|开一下|关一下)$/.test(text)
    || /^(再|也)(打开|开|关闭|关掉|关|停|停止)/.test(text)
    || isPartialExecutionConfirmationInput(input)
    || isComfortFollowUpInput(input);
}

export function isPartialExecutionConfirmationInput(input) {
  const text = normalize(input);
  return /^(执行|继续|可以|好|好的|确认|打开吧|关吧|执行吧|继续吧)$/.test(text)
    || /跳过.*(离线|不可用|失败)/.test(text)
    || /(执行|继续).*(其他|剩下|可执行)/.test(text)
    || /(只|仅).*(执行|操作).*(可执行|其他|剩下)/.test(text);
}

export function isRoomScopedFollowUpInput(input) {
  const text = normalize(input);
  return isComfortFollowUpInput(input)
    || isContextualTargetSelectionInput(input)
    || /^(把)?灯(都|全)?(打开|开|关闭|关掉|关)(吧|了)?$/.test(text)
    || /^(开|打开|关闭|关掉|关)(灯|照明)(吧|了|一下)?$/.test(text)
    || /^(灯|照明)(开|打开|关闭|关掉|关)(吧|了|一下)?$/.test(text);
}

export function isContextualTargetSelectionInput(input) {
  const text = normalize(input);
  return /^(射灯|吊灯|灯带|台灯|主灯|吸顶灯|筒灯|壁灯|落地灯|左边|右边|中间|第?[一二三四五六七八九十0-9]+个|[一二三四五六七八九十0-9]+号灯)(吧|呢)?$/.test(text);
}

export function isComfortFollowUpInput(input) {
  const text = normalize(input);
  return /^(还是)?(有点|太|不够|再)?(暗|亮|热|冷|闷)(啊|了|一点|点)?$/.test(text)
    || /^(还是)?(有点)?不够亮(啊|了)?$/.test(text)
    || /^(再)?亮一点$/.test(text)
    || /^暗一点$/.test(text);
}

function targetsFromPlan(plan) {
  const targets = [];
  if (plan.stateQuery?.thingId) {
    targets.push({ id: plan.stateQuery.thingId, name: plan.stateQuery.thingName, roomId: plan.stateQuery.roomId });
  }
  for (const action of plan.actions ?? []) {
    targets.push({
      id: action.logicalAssetId ?? action.thingId,
      name: action.logicalAssetName ?? action.thingName,
      roomId: action.logicalRoomId,
    });
  }
  return dedupeTargets(targets);
}

function compactContext(session) {
  return {
    version: CONVERSATION_CONTEXT_VERSION,
    focusedTargets: session.focusedTargets.map((target) => ({ ...target })),
    focusedRooms: (session.focusedRooms ?? []).map((room) => ({ ...room })),
    pendingPartialExecution: session.pendingPartialExecution
      ? {
          ...session.pendingPartialExecution,
          targets: session.pendingPartialExecution.targets.map((target) => ({ ...target })),
          rooms: session.pendingPartialExecution.rooms.map((room) => ({ ...room })),
          actions: session.pendingPartialExecution.actions.map((action) => ({ ...action })),
        }
      : null,
    recentTurns: session.turns.map((turn) => ({ ...turn })),
  };
}

function emptyContext() {
  return { version: CONVERSATION_CONTEXT_VERSION, focusedTargets: [], focusedRooms: [], pendingPartialExecution: null, recentTurns: [] };
}

function dedupeTargets(targets) {
  const seen = new Set();
  return targets.filter((target) => {
    if (!target.id || seen.has(target.id)) return false;
    seen.add(target.id);
    return true;
  });
}

function roomsFromPlan(plan, targets = []) {
  const rooms = [];
  if (plan.stateQuery?.roomId) rooms.push({ id: plan.stateQuery.roomId, name: plan.stateQuery.roomName });
  for (const room of plan.contextFocus?.rooms ?? []) {
    if (room?.id) rooms.push({ id: room.id, name: room.name });
  }
  for (const target of targets) {
    if (target.roomId) rooms.push({ id: target.roomId });
  }
  for (const action of plan.actions ?? []) {
    if (action.logicalRoomId) rooms.push({ id: action.logicalRoomId });
  }
  return dedupeRooms(rooms);
}

function pendingPartialExecutionFromPlan(plan, execution) {
  if (execution?.status !== "needs_confirmation") return null;
  if (execution?.decisionReview?.recovery?.mode !== "ask_partial_execution_confirmation") return null;
  const okAccepted = (execution.accepted ?? []).filter((item) => item.simulation?.ok);
  if (okAccepted.length === 0) return null;
  const okKeys = new Set(okAccepted.map(acceptedActionKey));
  const actions = (plan.actions ?? [])
    .filter((action) => okKeys.has(planActionKey(action)))
    .map((action) => ({
      thingId: action.thingId,
      thingName: action.thingName,
      logicalAssetId: action.logicalAssetId,
      logicalAssetName: action.logicalAssetName,
      logicalRoomId: action.logicalRoomId,
      capabilityId: action.capabilityId,
      capabilityName: action.capabilityName,
      value: action.value,
    }));
  const targets = okAccepted.map((item) => ({
    id: item.logicalAssetId ?? item.thingId,
    name: item.thingName,
    roomId: item.logicalRoomId,
  }));
  const rooms = dedupeRooms(
    targets
      .map((target) => ({ id: target.roomId }))
      .filter((room) => room.id),
  );
  return {
    intent: plan.intent,
    actions,
    targets: dedupeTargets(targets),
    rooms,
  };
}

function acceptedActionKey(item) {
  return `${item.logicalAssetId ?? item.thingId}:${item.capabilityId}:${String(item.value)}`;
}

function planActionKey(action) {
  return `${action.logicalAssetId ?? action.thingId}:${action.capabilityId}:${String(action.value)}`;
}

function dedupeRooms(rooms) {
  const seen = new Set();
  return rooms.filter((room) => {
    if (!room.id || seen.has(room.id)) return false;
    seen.add(room.id);
    return true;
  });
}

function normalize(input) {
  return String(input ?? "").trim().replace(/[，。！？,.!?\s]/g, "");
}
