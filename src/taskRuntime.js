export const TASK_RUNTIME_VERSION = "0.1";

const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function createTaskRuntime({
  now = () => new Date(),
  writeAudit = () => {},
  ttlMs = DEFAULT_TASK_TTL_MS,
} = {}) {
  const tasks = new Map();

  function createTask(input = {}) {
    pruneExpiredTasks();
    const createdAt = now().toISOString();
    const task = normalizeTask({
      ...input,
      createdAt,
      updatedAt: createdAt,
      status: input.status || "queued",
      events: [{
        at: createdAt,
        status: input.status || "queued",
        summary: input.progressSummary || "任务已创建。",
      }],
    });
    tasks.set(task.taskId, task);
    writeAudit(taskAuditRecord(task, "created", now));
    return publicTask(task);
  }

  function updateTask(taskId, patch = {}) {
    const task = tasks.get(taskId);
    if (!task) return null;
    const updatedAt = now().toISOString();
    const next = normalizeTask({
      ...task,
      ...patch,
      taskId,
      updatedAt,
      events: [
        ...(task.events ?? []),
        {
          at: updatedAt,
          status: patch.status || task.status,
          summary: patch.progressSummary || patch.resultSummary || patch.error || task.progressSummary,
        },
      ],
    });
    tasks.set(taskId, next);
    writeAudit(taskAuditRecord(next, "updated", now));
    return publicTask(next);
  }

  function getTask(taskId) {
    const task = tasks.get(taskId);
    return task ? publicTask(task) : null;
  }

  function listTasks({ limit = 20, includeTerminal = true } = {}) {
    pruneExpiredTasks();
    return Array.from(tasks.values())
      .filter((task) => includeTerminal || !TERMINAL_STATUSES.has(task.status))
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
      .slice(0, limit)
      .map(publicTask);
  }

  function pruneExpiredTasks() {
    const cutoff = now().getTime() - ttlMs;
    for (const [taskId, task] of tasks) {
      if (TERMINAL_STATUSES.has(task.status) && new Date(task.updatedAt).getTime() < cutoff) {
        tasks.delete(taskId);
      }
    }
  }

  return {
    createTask,
    updateTask,
    getTask,
    listTasks,
  };
}

export function isLongRunningAgentTask(text = "") {
  const value = normalizeText(text);
  return /(写|做|开发|生成|实现|搭建|创建).*(app|应用|网站|网页|系统|项目|小游戏|小程序|插件|脚本|报告|方案)/i.test(value)
    || /(帮我)?(写|做|开发|实现|搭建)(一个|个)?.*(app|应用|网站|网页|系统|项目|小游戏|小程序)/i.test(value);
}

function normalizeTask(input = {}) {
  const taskId = normalizeText(input.taskId) || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    version: TASK_RUNTIME_VERSION,
    taskId,
    source: normalizeText(input.source),
    userIntent: normalizeText(input.userIntent),
    kind: normalizeText(input.kind) || "agent_task",
    status: normalizeTaskStatus(input.status),
    progressSummary: normalizeText(input.progressSummary),
    resultSummary: normalizeText(input.resultSummary),
    error: normalizeText(input.error),
    artifacts: Array.isArray(input.artifacts) ? input.artifacts.map(normalizeArtifact).filter(Boolean) : [],
    subagent: normalizeSubagent(input.subagent),
    origin: normalizeOrigin(input.origin),
    createdAt: normalizeText(input.createdAt),
    updatedAt: normalizeText(input.updatedAt || input.createdAt),
    events: Array.isArray(input.events) ? input.events.map(normalizeTaskEvent).filter(Boolean) : [],
  };
}

function normalizeTaskStatus(status) {
  const value = normalizeText(status);
  if (["queued", "running", "waiting_input", "completed", "failed", "cancelled"].includes(value)) return value;
  return "queued";
}

function normalizeArtifact(artifact = {}) {
  if (!artifact || typeof artifact !== "object") return null;
  return {
    type: normalizeText(artifact.type),
    name: normalizeText(artifact.name),
    path: normalizeText(artifact.path),
    url: normalizeText(artifact.url),
  };
}

function normalizeOrigin(origin = {}) {
  return {
    ingress: normalizeText(origin.ingress),
    trigger: normalizeText(origin.trigger),
    sourceDeviceId: normalizeText(origin.sourceDeviceId || origin.deviceId),
    roomId: normalizeText(origin.roomId),
    wakeSessionId: normalizeText(origin.wakeSessionId || origin.sessionId),
  };
}

function normalizeSubagent(subagent = {}) {
  if (!subagent || typeof subagent !== "object") return null;
  return {
    enabled: Boolean(subagent.enabled),
    id: normalizeText(subagent.id),
    runner: normalizeText(subagent.runner),
    status: normalizeText(subagent.status),
    exitCode: Number.isFinite(subagent.exitCode) ? subagent.exitCode : null,
    error: normalizeText(subagent.error),
    startedAt: normalizeText(subagent.startedAt),
    finishedAt: normalizeText(subagent.finishedAt),
  };
}

function normalizeTaskEvent(event = {}) {
  if (!event || typeof event !== "object") return null;
  return {
    at: normalizeText(event.at),
    status: normalizeTaskStatus(event.status),
    summary: normalizeText(event.summary),
  };
}

function publicTask(task) {
  return {
    ...task,
    artifacts: task.artifacts.map((artifact) => ({ ...artifact })),
    origin: { ...task.origin },
    events: task.events.map((event) => ({ ...event })),
  };
}

function taskAuditRecord(task, event, now) {
  return {
    version: TASK_RUNTIME_VERSION,
    event,
    task: publicTask(task),
    auditedAt: now().toISOString(),
  };
}

function normalizeText(value) {
  return String(value ?? "").trim();
}
