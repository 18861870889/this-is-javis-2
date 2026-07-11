import { spawn } from "node:child_process";

export const SUBAGENT_RUNTIME_VERSION = "0.1";

export function isSubagentConfigured(env = process.env) {
  return Boolean(String(env.JARVIS_SUBAGENT_COMMAND || "").trim());
}

export async function runConfiguredSubagentTask({
  taskId = "",
  text = "",
  origin = {},
  env = process.env,
  timeoutMs = 120000,
} = {}) {
  const command = String(env.JARVIS_SUBAGENT_COMMAND || "").trim();
  if (!command) return null;
  const args = parseSubagentArgs(env.JARVIS_SUBAGENT_ARGS);
  const startedAt = new Date().toISOString();
  const input = JSON.stringify({
    version: SUBAGENT_RUNTIME_VERSION,
    taskId,
    text,
    origin,
  });
  const result = await runSubagentProcess({
    command,
    args,
    input,
    cwd: env.JARVIS_SUBAGENT_CWD || process.cwd(),
    env,
    timeoutMs,
  });
  const finishedAt = new Date().toISOString();
  const parsed = parseSubagentStdout(result.stdout);
  const ok = result.exitCode === 0 && !result.timedOut && parsed.status !== "failed";
  return {
    version: SUBAGENT_RUNTIME_VERSION,
    enabled: true,
    id: taskId,
    runner: command,
    status: ok ? "completed" : "failed",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    startedAt,
    finishedAt,
    resultSummary: parsed.resultSummary || parsed.replyText || parsed.summary || result.stdout.trim(),
    error: ok ? "" : parsed.error || result.stderr.trim() || (result.timedOut ? `Subagent timed out after ${timeoutMs}ms` : `Subagent exited ${result.exitCode}`),
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
  };
}

export function parseSubagentArgs(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {
    // Fall through to shell-like split below.
  }
  return raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((item) => item.replace(/^['"]|['"]$/g, "")) ?? [];
}

function runSubagentProcess({ command, args = [], input = "", cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: stderr || error.message, timedOut: false });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: Number.isFinite(code) ? code : 1,
        stdout,
        stderr,
        timedOut: signal === "SIGTERM",
      });
    });
    child.stdin.end(input);
  });
}

function parseSubagentStdout(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { resultSummary: text };
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { resultSummary: text };
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" ? parsed : { resultSummary: text };
    } catch {
      return { resultSummary: text };
    }
  }
}
