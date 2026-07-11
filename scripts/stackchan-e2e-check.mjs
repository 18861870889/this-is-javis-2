import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jarvisBaseUrl = process.env.JARVIS_BASE_URL || "http://127.0.0.1:5183";
const xiaozhiOtaUrl = process.env.XIAOZHI_OTA_URL || "http://127.0.0.1:8003/xiaozhi/ota/";
const pcWorkspaceRoot = resolve(repoRoot, process.env.JARVIS_PC_WORKSPACE_ROOT || "data/pc-workspace.local");
const args = new Set(process.argv.slice(2));
const includeRealControl = args.has("--real-control");
const includeDevicePrompt = args.has("--device");

const checks = [];
const errors = [];

await checkJarvisRuntime();
await checkXiaozhiOta();
await checkMcpManifest();
await checkReadOnlyHomeState();
await checkPcMarkdown();
if (includeRealControl) await checkRealSecondBedroomControl();
if (includeDevicePrompt) printDeviceVoiceChecklist();

if (errors.length) {
  console.error(errors.map((item) => `ERROR: ${item}`).join("\n"));
  process.exit(1);
}

console.log(checks.map((item) => `OK: ${item}`).join("\n"));
console.log("");
console.log("Stack chain checks passed for the selected scope.");
if (!includeDevicePrompt) {
  console.log("Use `npm run jarvis:stack:e2e -- --device` after flashing to print physical voice prompts.");
}

async function checkJarvisRuntime() {
  const status = await getJson(`${jarvisBaseUrl}/api/runtime/status`, "Jarvis runtime");
  if (!status) return;
  checks.push(`Jarvis runtime mode: ${status.execution?.mode || "unknown"}`);
  if (!status.execution?.mode) errors.push("Jarvis runtime response did not include execution mode.");
}

async function checkXiaozhiOta() {
  const response = await getText(xiaozhiOtaUrl, "Xiaozhi OTA");
  if (!response) return;
  if (!/ws:\/\/192\.168\.31\.99:8000\/xiaozhi\/v1\//.test(response)) {
    errors.push(`Xiaozhi OTA did not return the expected LAN WebSocket endpoint. Response: ${response}`);
    return;
  }
  checks.push("Xiaozhi OTA returns ws://192.168.31.99:8000/xiaozhi/v1/.");
}

async function checkMcpManifest() {
  const manifest = await getJson(`${jarvisBaseUrl}/mcp`, "Jarvis MCP manifest");
  if (!manifest) return;
  const tools = new Set(manifest.tools || []);
  for (const tool of ["jarvis_home_command", "computer_create_markdown_file"]) {
    if (!tools.has(tool)) errors.push(`MCP manifest is missing ${tool}.`);
  }
  checks.push(`Jarvis MCP exposes ${Array.from(tools).length} tools.`);
}

async function checkReadOnlyHomeState() {
  const reply = await chat("次卧吸顶灯开着吗");
  if (!reply) return;
  if (!/次卧|吸顶灯|开着|关着/.test(reply)) {
    errors.push(`Read-only home state reply looked wrong: ${reply}`);
    return;
  }
  checks.push(`Read-only HA state query answered: ${reply}`);
}

async function checkPcMarkdown() {
  const filename = `stackchan-e2e-${Date.now()}.md`;
  const reply = await chat(`在电脑工作区新建 ${filename} 并写入 helloworld`);
  if (!reply) return;
  const filePath = resolve(pcWorkspaceRoot, filename);
  if (!existsSync(filePath)) {
    errors.push(`PC markdown file was not created: ${filePath}. Reply: ${reply}`);
    return;
  }
  const content = readFileSync(filePath, "utf8");
  if (content !== "helloworld") {
    errors.push(`PC markdown content mismatch in ${filePath}: ${JSON.stringify(content)}`);
    return;
  }
  checks.push(`PC markdown tool created ${filename} (${statSync(filePath).size} bytes).`);
}

async function checkRealSecondBedroomControl() {
  if (process.env.JARVIS_E2E_REAL_CONTROL_APPROVED !== "I_UNDERSTAND_THIS_CONTROLS_SECOND_BEDROOM_LIGHT") {
    errors.push("Refusing real HA control. Set JARVIS_E2E_REAL_CONTROL_APPROVED=I_UNDERSTAND_THIS_CONTROLS_SECOND_BEDROOM_LIGHT.");
    return;
  }
  const reply = await chat("打开次卧吸顶灯");
  if (!reply) return;
  if (!/已打开|已经打开|开/.test(reply)) {
    errors.push(`Real control reply did not confirm opening the light: ${reply}`);
    return;
  }
  checks.push(`Real HA control reply: ${reply}`);

  const stateReply = await chat("次卧吸顶灯开着吗");
  if (!stateReply) return;
  if (!/吸顶灯开着/.test(stateReply)) {
    errors.push(`Read-back did not confirm the ceiling light is on: ${stateReply}`);
    return;
  }
  checks.push(`Real HA read-back reply: ${stateReply}`);
}

function printDeviceVoiceChecklist() {
  checks.push("Physical StackChan voice prompts:");
  checks.push("1. Hold StackChan head, say: 次卧吸顶灯开着吗, then release.");
  checks.push("2. Hold StackChan head, say: 在电脑工作区新建 stackchan-voice-final.md 并写入 helloworld, then release.");
  checks.push("3. If real-control approval is active, hold head, say: 打开次卧吸顶灯, then release.");
  checks.push("4. Then verify wake word separately: say 小黑, then say 次卧吸顶灯开着吗.");
  checks.push("5. Confirm StackChan speaks each Jarvis result naturally.");
}

async function chat(text) {
  const body = {
    model: "jarvis",
    messages: [{ role: "user", content: text }],
  };
  const response = await postJson(`${jarvisBaseUrl}/v1/chat/completions`, body, `Jarvis chat: ${text}`);
  return response?.choices?.[0]?.message?.content || "";
}

async function getJson(url, label) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    errors.push(`${label} failed: ${error.message}`);
    return null;
  }
}

async function getText(url, label) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } catch (error) {
    errors.push(`${label} failed: ${error.message}`);
    return null;
  }
}

async function postJson(url, body, label) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `${response.status} ${response.statusText}`);
    return payload;
  } catch (error) {
    errors.push(`${label} failed: ${error.message}`);
    return null;
  }
}
