export const JARVIS_CONTEXT_MEMORY_VERSION = "0.1";

const DEFAULT_MAX_PC_FILES = 20;
const DEFAULT_MAX_TASKS = 20;

export function createJarvisContextMemory({
  read = () => null,
  write = () => {},
  now = () => new Date(),
  maxPcFiles = DEFAULT_MAX_PC_FILES,
  maxTasks = DEFAULT_MAX_TASKS,
} = {}) {
  function getState() {
    return normalizeContextMemory(read());
  }

  function rememberPcFile(result = {}, origin = {}) {
    if (!result?.path || !result?.filename) return getState();
    const state = getState();
    const item = {
      type: "pc_file",
      filename: normalizeText(result.filename),
      path: normalizeText(result.path),
      workspaceRoot: normalizeText(result.workspaceRoot),
      operation: normalizeText(result.fileOperation || result.operation || "created"),
      bytes: Number.isFinite(result.bytes) ? result.bytes : 0,
      origin: normalizeOrigin(origin),
      createdAt: now().toISOString(),
    };
    const next = {
      ...state,
      updatedAt: item.createdAt,
      recentPcFiles: [item, ...state.recentPcFiles.filter((file) => file.path !== item.path)].slice(0, maxPcFiles),
    };
    write(next);
    return next;
  }

  function rememberTask(task = {}) {
    if (!task?.taskId) return getState();
    const state = getState();
    const item = {
      taskId: normalizeText(task.taskId),
      kind: normalizeText(task.kind),
      userIntent: normalizeText(task.userIntent),
      status: normalizeText(task.status),
      progressSummary: normalizeText(task.progressSummary),
      resultSummary: normalizeText(task.resultSummary),
      error: normalizeText(task.error),
      subagent: task.subagent && typeof task.subagent === "object" ? { ...task.subagent } : null,
      origin: normalizeOrigin(task.origin),
      updatedAt: normalizeText(task.updatedAt || now().toISOString()),
    };
    const next = {
      ...state,
      updatedAt: now().toISOString(),
      recentTasks: [item, ...state.recentTasks.filter((record) => record.taskId !== item.taskId)].slice(0, maxTasks),
    };
    write(next);
    return next;
  }

  function answer(text = {}) {
    return answerFromContextMemory(getState(), text);
  }

  return {
    getState,
    rememberPcFile,
    rememberTask,
    answer,
  };
}

export function answerFromContextMemory(memory, text = "") {
  const state = normalizeContextMemory(memory);
  const normalized = normalizeQuestionText(text);
  if (!normalized) return null;

  if (looksLikeRecentPcFileLocationQuestion(normalized)) {
    const file = findReferencedPcFile(state.recentPcFiles, normalized);
    if (!file) return {
      type: "pc_file_location",
      handled: false,
      replyText: "我这边没有找到最近创建的电脑文件记录。",
    };
    const directory = file.workspaceRoot || parentDirectory(file.path);
    return {
      type: "pc_file_location",
      handled: true,
      replyText: `${file.filename} 在电脑工作区：${directory}。完整路径是：${file.path}`,
      item: file,
    };
  }

  if (looksLikeRecentTaskContextQuestion(normalized)) {
    const task = state.recentTasks[0];
    if (!task) return null;
    const summary = task.resultSummary || task.progressSummary || task.error || task.userIntent;
    return {
      type: "task_context",
      handled: true,
      replyText: `刚才那个任务现在是${task.status || "未知状态"}：${summary}`,
      item: task,
    };
  }

  return null;
}

export function summarizeContextMemory(memory) {
  const state = normalizeContextMemory(memory);
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    recentPcFileCount: state.recentPcFiles.length,
    recentTaskCount: state.recentTasks.length,
    latestPcFile: state.recentPcFiles[0] ?? null,
    latestTask: state.recentTasks[0] ?? null,
  };
}

export function looksLikeRecentPcFileLocationQuestion(text = "") {
  const value = normalizeQuestionText(text);
  return /(刚才|刚刚|上次|之前|那个|文件|文档|md|markdown|小黑)/i.test(value)
    && /(在哪|哪里|目录|路径|位置|放哪|存哪|工作区)/.test(value)
    && /(文件|文档|md|markdown|创建|新建|写入|小黑|那个|目录|路径)/i.test(value);
}

function looksLikeRecentTaskContextQuestion(text = "") {
  const value = normalizeQuestionText(text);
  return /(刚才|刚刚|上个|那个|任务|app|应用|项目).*(结果|返回|说了什么)/.test(value);
}

function findReferencedPcFile(files = [], normalizedQuestion = "") {
  if (!Array.isArray(files) || files.length === 0) return null;
  const explicitName = extractReferencedFilename(normalizedQuestion);
  if (explicitName) {
    const byName = files.find((file) => normalizeQuestionText(file.filename).includes(explicitName));
    if (byName) return byName;
  }
  return files[0];
}

function extractReferencedFilename(text = "") {
  const value = normalizeQuestionText(text);
  const match = value.match(/(?:创建|新建|写入|那个)?([a-z0-9_\-\u4e00-\u9fa5]+?)(?:md|markdown|文件|文档)/i);
  const stem = normalizeText(match?.[1]).replace(/^(刚才|刚刚|让你|创建|新建|的)+/, "").replace(/的$/, "");
  if (!stem || ["刚才", "刚刚", "那个", "文件", "文档"].includes(stem)) return "";
  return stem.toLowerCase();
}

function parentDirectory(path = "") {
  const value = normalizeText(path);
  const index = value.lastIndexOf("/");
  return index > 0 ? value.slice(0, index) : value;
}

function normalizeContextMemory(input) {
  const base = input && typeof input === "object" ? input : {};
  return {
    version: JARVIS_CONTEXT_MEMORY_VERSION,
    updatedAt: normalizeText(base.updatedAt),
    recentPcFiles: Array.isArray(base.recentPcFiles) ? base.recentPcFiles.map(normalizePcFile).filter(Boolean) : [],
    recentTasks: Array.isArray(base.recentTasks) ? base.recentTasks.map(normalizeTask).filter(Boolean) : [],
  };
}

function normalizePcFile(file = {}) {
  if (!file || typeof file !== "object" || !file.path) return null;
  return {
    type: "pc_file",
    filename: normalizeText(file.filename),
    path: normalizeText(file.path),
    workspaceRoot: normalizeText(file.workspaceRoot),
    operation: normalizeText(file.operation),
    bytes: Number.isFinite(file.bytes) ? file.bytes : 0,
    origin: normalizeOrigin(file.origin),
    createdAt: normalizeText(file.createdAt),
  };
}

function normalizeTask(task = {}) {
  if (!task || typeof task !== "object" || !task.taskId) return null;
  return {
    taskId: normalizeText(task.taskId),
    kind: normalizeText(task.kind),
    userIntent: normalizeText(task.userIntent),
    status: normalizeText(task.status),
    progressSummary: normalizeText(task.progressSummary),
    resultSummary: normalizeText(task.resultSummary),
    error: normalizeText(task.error),
    subagent: task.subagent && typeof task.subagent === "object" ? { ...task.subagent } : null,
    origin: normalizeOrigin(task.origin),
    updatedAt: normalizeText(task.updatedAt),
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

function normalizeQuestionText(text = "") {
  return normalizeText(text).replace(/[，。！？,.!?\s]/g, "").toLowerCase();
}

function normalizeText(value) {
  return String(value ?? "").trim();
}
