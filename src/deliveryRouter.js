import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DELIVERY_ROUTER_VERSION = "0.1";

const ROUTED_INGRESSES = new Set([
  "stackchan",
  "xiaozhi",
  "xiaozhi_llm",
  "mcp",
  "jarvis_mcp",
  "voice_bridge",
  "wake_word",
]);
const DIRECT_CHAT_INGRESSES = new Set(["wechat", "weixin", "hermes_wechat", "direct_wechat"]);
const DEFAULT_PRIORITY = "normal";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createDeliveryRouter({
  now = () => new Date(),
  writeAudit = () => {},
  wechatSender = null,
} = {}) {
  const voiceQueue = [];

  async function route(input) {
    const message = normalizeDeliveryMessage(input, now);
    const channelResults = [];
    const usesRouter = shouldUseDeliveryRouter(message.origin);

    if (!usesRouter) {
      const result = {
        ...message,
        status: "skipped",
        channelResults: [{
          channel: "router",
          status: "skipped",
          reason: "origin_not_routed",
        }],
      };
      writeAudit(sanitizeAuditRecord(result, now));
      return result;
    }

    if (message.channels.includes("voice")) {
      const voiceResult = enqueueVoiceMessage(voiceQueue, message, now);
      channelResults.push(voiceResult);
    }

    if (message.channels.includes("wechat")) {
      channelResults.push(await deliverWechatMessage(message, wechatSender));
    }

    const status = summarizeDeliveryStatus(channelResults);
    const result = {
      ...message,
      status,
      channelResults,
    };
    writeAudit(sanitizeAuditRecord(result, now));
    return result;
  }

  function drainVoiceQueue(filter = {}) {
    const currentTime = now().getTime();
    const drained = [];
    for (const item of voiceQueue) {
      if (item.status !== "pending") continue;
      if (new Date(item.expiresAt).getTime() <= currentTime) {
        item.status = "skipped";
        item.reason = "expired";
        item.updatedAt = now().toISOString();
        drained.push({ ...item });
        continue;
      }
      if (filter.targetDeviceId && item.targetDeviceId && item.targetDeviceId !== filter.targetDeviceId) continue;
      if (filter.roomId && item.roomId && item.roomId !== filter.roomId) continue;
      item.status = "delivered";
      item.updatedAt = now().toISOString();
      drained.push({ ...item });
    }
    return drained;
  }

  return {
    route,
    drainVoiceQueue,
    getVoiceQueue: () => voiceQueue.map((item) => ({ ...item })),
  };
}

export function shouldUseDeliveryRouter(origin = {}) {
  const ingress = normalizeOriginIngress(origin);
  if (DIRECT_CHAT_INGRESSES.has(ingress)) return false;
  if (ROUTED_INGRESSES.has(ingress)) return true;
  const trigger = normalizeToken(origin.trigger);
  if (DIRECT_CHAT_INGRESSES.has(trigger)) return false;
  return ROUTED_INGRESSES.has(trigger);
}

export function createDeliveryMessage({
  taskId = "",
  origin = {},
  voiceSummary = "",
  wechatTitle = "",
  wechatBody = "",
  channels = ["voice"],
  priority = DEFAULT_PRIORITY,
  expiresAt = "",
  source = "",
} = {}, now = () => new Date()) {
  return normalizeDeliveryMessage({
    taskId,
    origin,
    voiceSummary,
    wechatTitle,
    wechatBody,
    channels,
    priority,
    expiresAt,
    source,
  }, now);
}

export function createHermesWechatSender({
  enabled = parseBoolean(process.env.JARVIS_DELIVERY_WECHAT_ENABLED),
  command = process.env.JARVIS_HERMES_WECHAT_COMMAND || "",
  hermesHome = process.env.HERMES_HOME || resolve(homedir(), ".hermes"),
  hermesAgentRoot = process.env.JARVIS_HERMES_AGENT_ROOT || resolve(hermesHome, "hermes-agent"),
  python = process.env.JARVIS_HERMES_PYTHON || resolve(hermesAgentRoot, "venv/bin/python3"),
  target = process.env.JARVIS_DELIVERY_WECHAT_TARGET || "weixin",
  timeoutMs = Number(process.env.JARVIS_HERMES_WECHAT_TIMEOUT_MS || 8000),
  cwd = process.env.JARVIS_HERMES_WECHAT_CWD || process.cwd(),
  env = process.env,
  runCommand = runSpawnedCommand,
} = {}) {
  return async function sendViaHermesWechat({ title, body }) {
    if (!enabled) {
      return {
        status: "skipped",
        reason: "wechat_delivery_disabled",
      };
    }
    if (!command.trim()) {
      const result = await runHermesWechatTool({
        python,
        hermesHome,
        hermesAgentRoot,
        target,
        message: title ? `${title}\n\n${body}` : body,
        env,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000,
      });
      return {
        status: result.exitCode === 0 ? "delivered" : "failed",
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 300),
        stderr: result.stderr.slice(0, 300),
      };
    }
    const message = title ? `${title}\n\n${body}` : body;
    const rendered = renderCommandTemplate(command, { title, body, message });
    const result = await runCommand({
      command: rendered.command,
      args: rendered.args,
      cwd,
      env,
      input: "",
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000,
    });
    return {
      status: result.exitCode === 0 ? "delivered" : "failed",
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 300),
      stderr: result.stderr.slice(0, 300),
    };
  };
}

export function buildDeliveryForVoiceBridgeResult(result, {
  utterance = {},
  source = "voice_bridge",
  now = () => new Date(),
} = {}) {
  const voiceSummary = result?.replyText || result?.display || "";
  const origin = originFromUtterance(utterance, result);
  return createDeliveryMessage({
    taskId: result?.commandId || result?.dedupeKey || "",
    origin,
    voiceSummary,
    channels: ["voice"],
    priority: "normal",
    source,
  }, now);
}

export function buildDeliveryForPcResult(result, {
  origin = {},
  source = "pc_action",
  now = () => new Date(),
} = {}) {
  const voiceSummary = result?.replyText || "电脑操作已完成。";
  return createDeliveryMessage({
    taskId: result?.path || result?.filename || "",
    origin,
    voiceSummary,
    wechatTitle: "Jarvis 电脑操作完成",
    wechatBody: [
      voiceSummary,
      result?.path ? `路径：${result.path}` : "",
    ].filter(Boolean).join("\n"),
    channels: ["voice", "wechat"],
    priority: "normal",
    source,
  }, now);
}

export function summarizeForVoiceWithWechat(fullText, {
  maxChars = 80,
  suffix = "完整内容我发到微信了。",
} = {}) {
  const normalized = normalizeText(fullText);
  if (normalized.length <= maxChars) return normalized;
  const head = normalized.slice(0, Math.max(0, maxChars - suffix.length - 1)).trim();
  return `${head}，${suffix}`;
}

function normalizeDeliveryMessage(input = {}, now) {
  const createdAt = now().toISOString();
  const expiresAt = input.expiresAt
    ? new Date(input.expiresAt).toISOString()
    : new Date(now().getTime() + DEFAULT_TTL_MS).toISOString();
  const voiceSummary = normalizeText(input.voiceSummary);
  const wechatBody = normalizeText(input.wechatBody);
  const channels = normalizeChannels(input.channels, { hasWechatBody: Boolean(wechatBody) });
  const origin = normalizeOrigin(input.origin);
  return {
    version: DELIVERY_ROUTER_VERSION,
    id: input.id || `delivery-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: normalizeText(input.taskId),
    origin,
    voiceSummary,
    wechatTitle: normalizeText(input.wechatTitle),
    wechatBody,
    channels,
    priority: normalizeText(input.priority) || DEFAULT_PRIORITY,
    expiresAt,
    source: normalizeText(input.source),
    createdAt,
    status: "pending",
  };
}

function normalizeOrigin(origin = {}) {
  return {
    ingress: normalizeOriginIngress(origin),
    trigger: normalizeToken(origin.trigger),
    sourceDeviceId: normalizeText(origin.sourceDeviceId || origin.deviceId),
    userId: normalizeText(origin.userId),
    roomId: normalizeText(origin.roomId),
    wakeSessionId: normalizeText(origin.wakeSessionId || origin.sessionId),
  };
}

function normalizeOriginIngress(origin = {}) {
  return normalizeToken(origin.ingress || origin.source || origin.trigger);
}

function normalizeChannels(channels, { hasWechatBody }) {
  const values = Array.isArray(channels) ? channels : ["voice"];
  const normalized = [...new Set(values.map(normalizeToken).filter(Boolean))];
  if (!normalized.length) normalized.push("voice");
  return normalized.filter((channel) => channel === "voice" || (channel === "wechat" && hasWechatBody));
}

function enqueueVoiceMessage(queue, message, now) {
  const entry = {
    id: `voice-${message.id}`,
    taskId: message.taskId,
    targetDeviceId: message.origin.sourceDeviceId,
    roomId: message.origin.roomId,
    text: message.voiceSummary,
    priority: message.priority,
    expiresAt: message.expiresAt,
    status: "delivered",
    createdAt: message.createdAt,
    updatedAt: now().toISOString(),
  };
  queue.push(entry);
  return {
    channel: "voice",
    status: message.voiceSummary ? "delivered" : "skipped",
    reason: message.voiceSummary ? "" : "empty_voice_summary",
    queueId: entry.id,
    text: message.voiceSummary,
  };
}

async function deliverWechatMessage(message, wechatSender) {
  if (!message.wechatBody) {
    return { channel: "wechat", status: "skipped", reason: "empty_wechat_body" };
  }
  if (!wechatSender) {
    return { channel: "wechat", status: "skipped", reason: "wechat_sender_unconfigured" };
  }
  try {
    const result = await wechatSender({
      title: message.wechatTitle,
      body: message.wechatBody,
      message,
    });
    return {
      channel: "wechat",
      status: result?.status || "delivered",
      reason: result?.reason || "",
      detail: result ?? {},
    };
  } catch (error) {
    return {
      channel: "wechat",
      status: "failed",
      reason: error.message || "wechat_sender_failed",
    };
  }
}

function summarizeDeliveryStatus(channelResults) {
  if (channelResults.some((result) => result.status === "failed")) return "partial_failed";
  if (channelResults.some((result) => result.status === "delivered")) return "delivered";
  if (channelResults.some((result) => result.status === "skipped")) return "skipped";
  return "pending";
}

function sanitizeAuditRecord(result, now) {
  return {
    version: DELIVERY_ROUTER_VERSION,
    id: result.id,
    taskId: result.taskId,
    source: result.source,
    origin: result.origin,
    channels: result.channels,
    priority: result.priority,
    status: result.status,
    channelResults: result.channelResults?.map((item) => ({
      channel: item.channel,
      status: item.status,
      reason: item.reason || "",
      queueId: item.queueId || "",
    })) ?? [],
    voiceSummary: result.voiceSummary,
    hasWechatBody: Boolean(result.wechatBody),
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
    auditedAt: now().toISOString(),
  };
}

function originFromUtterance(utterance = {}, result = {}) {
  return {
    ingress: utterance.trigger || result.trigger || "voice_bridge",
    trigger: utterance.trigger || result.trigger || "",
    sourceDeviceId: utterance.deviceId || result.deviceId || "",
    roomId: utterance.roomId || result.roomId || "",
    wakeSessionId: utterance.wakeSessionId || result.wakeSessionId || "",
  };
}

function renderCommandTemplate(command, values) {
  if (command.includes("{message}") || command.includes("{body}") || command.includes("{title}")) {
    return splitCommandLine(command
      .replaceAll("{title}", values.title)
      .replaceAll("{body}", values.body)
      .replaceAll("{message}", values.message));
  }
  const parsed = splitCommandLine(command);
  return {
    command: parsed.command,
    args: [...parsed.args, values.message],
  };
}

function splitCommandLine(commandLine) {
  const parts = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return {
    command: parts[0] || "",
    args: parts.slice(1),
  };
}

function runHermesWechatTool({ python, hermesHome, hermesAgentRoot, target, message, env, timeoutMs }) {
  const code = `
import json
import sys
from hermes_cli.env_loader import load_hermes_dotenv

load_hermes_dotenv(hermes_home=${JSON.stringify(hermesHome)})

from tools.send_message_tool import send_message_tool

payload = json.load(sys.stdin)
print(send_message_tool({
  "action": "send",
  "target": payload["target"],
  "message": payload["message"],
}))
`;
  return runSpawnedCommand({
    command: python,
    args: ["-c", code],
    cwd: hermesAgentRoot,
    env: {
      ...env,
      HERMES_HOME: hermesHome,
      PYTHONPATH: hermesAgentRoot,
    },
    input: JSON.stringify({ target, message }),
    timeoutMs,
  });
}

function runSpawnedCommand({ command, args = [], cwd, env, input = "", timeoutMs }) {
  if (!command) {
    return Promise.resolve({ exitCode: 127, stdout: "", stderr: "empty command" });
  }
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeToken(value) {
  return normalizeText(value).toLowerCase();
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
