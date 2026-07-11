import { existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultXiaozhiRoot = resolve(repoRoot, "../xiaozhi-esp32-server-jarvis/main/xiaozhi-server");
const xiaozhiRoot = resolve(process.env.XIAOZHI_SERVER_ROOT || defaultXiaozhiRoot);
const runtimeDir = resolve(repoRoot, "data/jarvis-stack.local");
const pidFile = resolve(runtimeDir, "pids.json");
const jarvisPort = Number(process.env.JARVIS_STACK_JARVIS_PORT || 5183);
const xiaozhiWsPort = Number(process.env.JARVIS_STACK_XIAOZHI_WS_PORT || 8000);
const xiaozhiHttpPort = Number(process.env.JARVIS_STACK_XIAOZHI_HTTP_PORT || 8003);
const hermesAgentBaseUrl = process.env.HERMES_API_BASE_URL || process.env.HERMES_API_URL || "http://127.0.0.1:19998";
const hermesCliPython = process.env.HERMES_CLI_PYTHON || "/Users/jerf/.hermes/hermes-agent/venv/bin/python";

const command = process.argv[2] || "status";
const mode = process.argv[3] || "dry-run";

if (!["start", "stop", "restart", "status", "check"].includes(command)) {
  die(`Unknown command: ${command}`);
}
if (!["dry-run", "real-second", "real-home"].includes(mode)) {
  die(`Unknown mode: ${mode}. Use dry-run, real-second, or real-home.`);
}

if (command === "check") await check({ mode });
if (command === "status") status();
if (command === "stop") await stop();
if (command === "restart") {
  await stop({ quiet: true });
  await start({ mode });
}
if (command === "start") await start({ mode });

async function start({ mode }) {
  ensureRuntimeDir();
  await check({ mode, failOnBusyPorts: true });

  const jarvisLog = resolve(runtimeDir, "jarvis.log");
  const xiaozhiLog = resolve(runtimeDir, "xiaozhi.log");
  const jarvisEnv = buildJarvisEnv(mode);

  const jarvis = spawn("npm", ["run", "dev"], {
    cwd: repoRoot,
    env: jarvisEnv,
    detached: true,
    stdio: ["ignore", appendLog(jarvisLog), appendLog(jarvisLog)],
  });
  jarvis.unref();

  try {
    await waitForHttp(`http://127.0.0.1:${jarvisPort}/api/runtime/status`, 20_000);
  } catch (error) {
    terminateProcessGroup(jarvis.pid);
    throw error;
  }

  const xiaozhiPython = resolve(xiaozhiRoot, ".venv/bin/python");
  const xiaozhi = spawn(xiaozhiPython, ["app.py"], {
    cwd: xiaozhiRoot,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    detached: true,
    stdio: ["ignore", appendLog(xiaozhiLog), appendLog(xiaozhiLog)],
  });
  xiaozhi.unref();

  try {
    await waitForTcp("127.0.0.1", xiaozhiWsPort, 60_000);
    await waitForTcp("127.0.0.1", xiaozhiHttpPort, 60_000);
  } catch (error) {
    terminateProcessGroup(jarvis.pid);
    terminateProcessGroup(xiaozhi.pid);
    throw error;
  }

  writeFileSync(pidFile, JSON.stringify({
    mode,
    startedAt: new Date().toISOString(),
    jarvis: { pid: jarvis.pid, port: jarvisPort, log: jarvisLog },
    xiaozhi: { pid: xiaozhi.pid, wsPort: xiaozhiWsPort, httpPort: xiaozhiHttpPort, log: xiaozhiLog },
  }, null, 2));

  console.log(`Jarvis stack started in ${mode} mode.`);
  console.log(`Jarvis: http://127.0.0.1:${jarvisPort}/`);
  console.log(`Xiaozhi OTA: http://127.0.0.1:${xiaozhiHttpPort}/xiaozhi/ota/`);
  console.log(`Logs: ${runtimeDir}`);
}

async function stop({ quiet = false } = {}) {
  const pids = readPidFile();
  if (!pids) {
    if (!quiet) console.log("Jarvis stack is not recorded as running.");
    return;
  }
  terminateProcessGroup(pids.jarvis?.pid);
  terminateProcessGroup(pids.xiaozhi?.pid);
  try {
    unlinkSync(pidFile);
  } catch {
    // Nothing to clean up.
  }
  await waitForPortsClosed([jarvisPort, xiaozhiWsPort, xiaozhiHttpPort], 10_000);
  if (!quiet) console.log("Jarvis stack stop signal sent.");
}

function status() {
  const pids = readPidFile();
  if (!pids) {
    console.log("Jarvis stack: stopped");
    return;
  }
  console.log(`Jarvis stack: ${pids.mode || "unknown"} mode`);
  console.log(`Jarvis pid ${pids.jarvis?.pid}: ${isPidAlive(pids.jarvis?.pid) ? "running" : "not running"}`);
  console.log(`Xiaozhi pid ${pids.xiaozhi?.pid}: ${isPidAlive(pids.xiaozhi?.pid) ? "running" : "not running"}`);
  console.log(`Logs: ${runtimeDir}`);
}

async function check({ mode, failOnBusyPorts = false }) {
  const errors = [];
  const warnings = [];
  const env = readEnvFile(resolve(repoRoot, ".env"));

  const xiaozhiConfig = resolve(xiaozhiRoot, "data/.config.yaml");
  const xiaozhiPython = resolve(xiaozhiRoot, ".venv/bin/python");
  const senseVoiceModel = resolve(xiaozhiRoot, "models/SenseVoiceSmall/model.pt");

  if (!existsSync(resolve(repoRoot, "server.mjs"))) errors.push("server.mjs not found in Jarvis repo.");
  if (!existsSync(resolve(repoRoot, "node_modules"))) errors.push("Jarvis node_modules is missing. Run npm install.");
  if (!existsSync(xiaozhiRoot)) errors.push(`Xiaozhi server root not found: ${xiaozhiRoot}`);
  if (!existsSync(xiaozhiConfig)) errors.push(`Xiaozhi local config missing: ${xiaozhiConfig}`);
  if (!existsSync(xiaozhiPython)) errors.push(`Xiaozhi Python venv missing: ${xiaozhiPython}`);
  if (!existsSync(senseVoiceModel)) {
    errors.push(`SenseVoiceSmall model missing: ${senseVoiceModel}`);
  } else if (statSync(senseVoiceModel).size < 500_000_000) {
    errors.push(`SenseVoiceSmall model looks too small: ${senseVoiceModel}`);
  }

  if (["real-second", "real-home"].includes(mode) && !hasHaConfig(env)) {
    errors.push(`${mode} mode requires HA_BASE_URL + HA_TOKEN or HOME_ASSISTANT_URL + HOME_ASSISTANT_TOKEN in the environment or local .env.`);
  }
  if (mode === "dry-run" && !hasHaConfig(env)) {
    warnings.push("HA is not configured. Dry-run can start, but home commands will say HA is not connected until .env contains HA_BASE_URL/HA_TOKEN.");
  }

  for (const [label, port] of [["Jarvis", jarvisPort], ["Xiaozhi WS", xiaozhiWsPort], ["Xiaozhi HTTP", xiaozhiHttpPort]]) {
    const open = await isTcpOpen("127.0.0.1", port);
    if (open && failOnBusyPorts) errors.push(`${label} port ${port} is already listening.`);
    if (open && !failOnBusyPorts) warnings.push(`${label} port ${port} is already listening.`);
  }
  if ((process.env.HERMES_API_TRANSPORT || "cli") === "cli") {
    if (!existsSync(hermesCliPython)) {
      warnings.push(`Hermes CLI Python is missing at ${hermesCliPython}; non-home StackChan questions will use a speakable fallback until Hermes is available.`);
    }
  } else {
    const hermesUrl = new URL(hermesAgentBaseUrl);
    const hermesPort = Number(hermesUrl.port || (hermesUrl.protocol === "https:" ? 443 : 80));
    if (!await isTcpOpen(hermesUrl.hostname, hermesPort)) {
      warnings.push(`Hermes/Jarvis Agent endpoint is not listening at ${hermesAgentBaseUrl}; non-home StackChan questions will use a speakable fallback until Hermes is running.`);
    }
  }

  if (errors.length) {
    console.error(errors.map((item) => `ERROR: ${item}`).join("\n"));
    process.exit(1);
  }
  if (warnings.length) console.error(warnings.map((item) => `WARN: ${item}`).join("\n"));
  console.log(`Preflight OK for ${mode} mode.`);
}

function buildJarvisEnv(mode) {
  const real = mode === "real-second" || mode === "real-home";
  const base = {
    ...process.env,
    JARVIS_BIND_HOST: "127.0.0.1",
    PORT: String(jarvisPort),
    HARNESS_EXECUTION_MODE: real ? "real" : "dry_run",
    JARVIS_XIAOZHI_DEVICE_ID: process.env.JARVIS_XIAOZHI_DEVICE_ID || "stackchan-second",
    JARVIS_XIAOZHI_ROOM_ID: process.env.JARVIS_XIAOZHI_ROOM_ID || "second",
    JARVIS_XIAOZHI_ALLOW_REAL: real ? "true" : "false",
    JARVIS_MCP_ALLOW_REAL: real ? "true" : (process.env.JARVIS_MCP_ALLOW_REAL || "false"),
    HERMES_API_TRANSPORT: process.env.HERMES_API_TRANSPORT || "cli",
    HERMES_CLI_PYTHON: hermesCliPython,
    HERMES_API_BASE_URL: process.env.HERMES_API_BASE_URL || process.env.HERMES_API_URL || hermesAgentBaseUrl,
    ...(process.env.HERMES_API_MODEL ? { HERMES_API_MODEL: process.env.HERMES_API_MODEL } : {}),
    JARVIS_PC_WORKSPACE_ROOT: process.env.JARVIS_PC_WORKSPACE_ROOT || "data/pc-workspace.local",
    JARVIS_STACKCHAN_DEVICE_ROOMS: process.env.JARVIS_STACKCHAN_DEVICE_ROOMS || '{"stackchan-second":"second"}',
  };
  if (mode === "real-second") {
    return {
      ...base,
      JARVIS_ALLOWED_ACTION_ROOM_IDS: process.env.JARVIS_ALLOWED_ACTION_ROOM_IDS || "second",
      JARVIS_INGRESS_ALLOWED_DEVICE_IDS: process.env.JARVIS_INGRESS_ALLOWED_DEVICE_IDS || "stackchan-second",
      JARVIS_INGRESS_ALLOWED_ROOM_IDS: process.env.JARVIS_INGRESS_ALLOWED_ROOM_IDS || "second",
      JARVIS_INGRESS_REQUIRE_TEXT_PATTERN: process.env.JARVIS_INGRESS_REQUIRE_TEXT_PATTERN || "次卧|吸顶灯|入户射灯|床头|床尾|射灯",
    };
  }
  if (mode === "real-home") {
    return {
      ...base,
      JARVIS_ALLOWED_ACTION_ROOM_IDS: process.env.JARVIS_ALLOWED_ACTION_ROOM_IDS || "",
      JARVIS_INGRESS_ALLOWED_DEVICE_IDS: process.env.JARVIS_INGRESS_ALLOWED_DEVICE_IDS || "",
      JARVIS_INGRESS_ALLOWED_ROOM_IDS: process.env.JARVIS_INGRESS_ALLOWED_ROOM_IDS || "",
      JARVIS_INGRESS_REQUIRE_TEXT_PATTERN: process.env.JARVIS_INGRESS_REQUIRE_TEXT_PATTERN || "",
      JARVIS_INGRESS_ALLOWED_TEXTS: process.env.JARVIS_INGRESS_ALLOWED_TEXTS || "",
      JARVIS_MCP_ALLOWED_ROOM_IDS: process.env.JARVIS_MCP_ALLOWED_ROOM_IDS || "",
      JARVIS_MCP_REQUIRE_TEXT_PATTERN: process.env.JARVIS_MCP_REQUIRE_TEXT_PATTERN || "",
      JARVIS_MCP_ALLOWED_TEXTS: process.env.JARVIS_MCP_ALLOWED_TEXTS || "",
      JARVIS_ALLOWED_ENTITY_IDS: process.env.JARVIS_ALLOWED_ENTITY_IDS || "",
    };
  }
  return {
    ...base,
    JARVIS_ALLOWED_ACTION_ROOM_IDS: process.env.JARVIS_ALLOWED_ACTION_ROOM_IDS || "",
    JARVIS_INGRESS_ALLOWED_DEVICE_IDS: process.env.JARVIS_INGRESS_ALLOWED_DEVICE_IDS || "",
    JARVIS_INGRESS_ALLOWED_ROOM_IDS: process.env.JARVIS_INGRESS_ALLOWED_ROOM_IDS || "",
    JARVIS_INGRESS_REQUIRE_TEXT_PATTERN: process.env.JARVIS_INGRESS_REQUIRE_TEXT_PATTERN || "",
  };
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    result[key] = value;
  }
  return result;
}

function hasHaConfig(envFile) {
  const env = { ...envFile, ...process.env };
  return Boolean((env.HA_BASE_URL && env.HA_TOKEN) || (env.HOME_ASSISTANT_URL && env.HOME_ASSISTANT_TOKEN));
}

function appendLog(path) {
  ensureRuntimeDir();
  return openSync(path, "a");
}

function ensureRuntimeDir() {
  mkdirSync(runtimeDir, { recursive: true });
}

function readPidFile() {
  if (!existsSync(pidFile)) return null;
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return null;
  }
}

function terminateProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process is already gone.
    }
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown error"}`);
}

async function waitForTcp(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpOpen(host, port)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function waitForPortsClosed(ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const openStates = await Promise.all(ports.map((port) => isTcpOpen("127.0.0.1", port)));
    if (openStates.every((open) => !open)) return;
    await sleep(500);
  }
}

function isTcpOpen(host, port) {
  return new Promise((resolveOpen) => {
    const socket = net.connect({ host, port, timeout: 500 });
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveOpen(false);
    });
    socket.once("error", () => resolveOpen(false));
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function die(message) {
  console.error(message);
  process.exit(1);
}
