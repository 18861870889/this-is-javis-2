import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const taskId = safeName(input.taskId || `task-${Date.now()}`);
  const text = String(input.text || "").trim();
  if (!text) throw new Error("Subagent task text is empty.");

  if (/失败测试|故意失败|subagent fail/i.test(text) || isEnabled(process.env.JARVIS_SUBAGENT_FORCE_FAIL)) {
    throw new Error(`Subagent deliberate failure for task ${taskId}`);
  }

  const resultDir = resolve(process.cwd(), process.env.JARVIS_SUBAGENT_RESULT_DIR || "data/subagent-results.local");
  const artifactPath = resolve(resultDir, `${taskId}.md`);
  if (!artifactPath.startsWith(resultDir)) throw new Error("Invalid artifact path.");
  mkdirSync(dirname(artifactPath), { recursive: true });

  const content = [
    `# Jarvis Subagent Result ${taskId}`,
    "",
    `- Task: ${text}`,
    `- Created: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    "本地 Jarvis subagent 已收到并处理这个长任务。当前 worker 是安全占位实现，用于验证异步任务、结果回流和 Delivery Router 闭环。",
    "",
  ].join("\n");
  writeFileSync(artifactPath, content, "utf8");

  console.log(JSON.stringify({
    status: "completed",
    resultSummary: `subagent 已处理：${text}`,
    artifacts: [{
      type: "markdown",
      name: `${taskId}.md`,
      path: artifactPath,
    }],
  }));
} catch (error) {
  console.log(JSON.stringify({
    status: "failed",
    error: error.message || "Subagent failed.",
  }));
  process.exitCode = 1;
}

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || `task-${Date.now()}`;
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
