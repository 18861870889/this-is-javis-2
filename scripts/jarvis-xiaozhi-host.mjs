#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ensureHexRuntimeSecret } from "../src/runtimeSecret.js";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const defaultXiaozhiRoot = resolve(repoRoot, "../xiaozhi-esp32-server-jarvis/main/xiaozhi-server");
const xiaozhiRoot = resolve(process.env.XIAOZHI_SERVER_ROOT || defaultXiaozhiRoot);
const pythonPath = resolve(process.env.XIAOZHI_SERVER_PYTHON || join(xiaozhiRoot, ".venv/bin/python"));
const runtimeDir = join(repoRoot, "data/jarvis-xiaozhi-host.local");
const keyPath = join(repoRoot, "data/jarvis-xiaozhi-delivery.local/api.key");
const pidPath = join(runtimeDir, "process.json");
const logPath = join(runtimeDir, "xiaozhi.log");
const wsPort = parsePort(process.env.JARVIS_STACK_XIAOZHI_WS_PORT || "8000");
const httpPort = parsePort(process.env.JARVIS_STACK_XIAOZHI_HTTP_PORT || "8003");
const deliveryPort = parsePort(process.env.JARVIS_XIAOZHI_DELIVERY_PORT || "8004");
const command = process.argv[2] || "status";

export function validateXiaozhiJarvisConfig(config = {}) {
  const selected = config.selected_module || {};
  const auth = config.server?.auth || {};
  const failures = [];
  if (selected.LLM !== "JarvisLLM") {
    failures.push("selected_module.LLM must be JarvisLLM");
  }
  if (selected.Intent !== "nointent") {
    failures.push("selected_module.Intent must be nointent");
  }
  if (auth.enabled !== true) {
    failures.push("server.auth.enabled must be true");
  }
  if (!Array.isArray(auth.allowed_devices) || auth.allowed_devices.length === 0) {
    failures.push("server.auth.allowed_devices must contain at least one device");
  }
  return {
    ok: failures.length === 0,
    failures,
    allowedDeviceCount: Array.isArray(auth.allowed_devices) ? auth.allowed_devices.length : 0,
    llm: String(selected.LLM || ""),
    intent: String(selected.Intent || ""),
  };
}

export function isExpectedXiaozhiCommand(commandLine = "", {
  root = xiaozhiRoot,
} = {}) {
  const value = String(commandLine || "");
  return value.includes(resolve(root)) && /(^|\s)app\.py(\s|$)/.test(value);
}

export async function prepareXiaozhiHost() {
  const configPath = join(xiaozhiRoot, "data/.config.yaml");
  for (const required of [xiaozhiRoot, pythonPath, configPath, join(xiaozhiRoot, "app.py")]) {
    if (!existsSync(required)) throw new Error(`Required Xiaozhi path is missing: ${required}`);
  }
  const validation = validateXiaozhiJarvisConfig(parseYaml(readFileSync(configPath, "utf8")) || {});
  if (!validation.ok) {
    throw new Error(`Xiaozhi security/config preflight failed: ${validation.failures.join("; ")}`);
  }
  const apiKey = ensureHexRuntimeSecret(keyPath);
  return {
    status: "prepared",
    xiaozhiRoot,
    pythonPath,
    keyPath,
    deliveryHost: "127.0.0.1",
    deliveryPort,
    wsPort,
    httpPort,
    allowedDeviceCount: validation.allowedDeviceCount,
    apiKey,
  };
}

async function startXiaozhiHost() {
  const prepared = await prepareXiaozhiHost();
  const existing = readProcessRecord();
  if (existing && isProcessAlive(existing.pid)) {
    assertManagedProcess(existing.pid);
    const health = await probeDelivery(prepared.apiKey);
    if (!health) throw new Error("Managed Xiaozhi process is running but delivery API is unavailable.");
    printStatus("running", prepared, existing.pid);
    return;
  }
  if (existing) rmSync(pidPath, { force: true });

  const occupied = [];
  for (const port of [wsPort, httpPort, deliveryPort]) {
    if (await isTcpOpen("127.0.0.1", port)) occupied.push(port);
  }
  if (occupied.length) {
    throw new Error(`Refusing to replace unowned listeners on localhost ports: ${occupied.join(", ")}`);
  }

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  const logDescriptor = openSync(logPath, "a", 0o600);
  const child = spawn(pythonPath, ["app.py"], {
    cwd: xiaozhiRoot,
    detached: true,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      JARVIS_DELIVERY_API_KEY: prepared.apiKey,
      JARVIS_DELIVERY_HOST: "127.0.0.1",
      JARVIS_DELIVERY_PORT: String(deliveryPort),
    },
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  child.unref();
  writeFileSync(pidPath, JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    xiaozhiRoot,
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(pidPath, 0o600);

  try {
    await waitForReady(prepared.apiKey, 90_000);
  } catch (error) {
    terminateManagedProcess(child.pid);
    rmSync(pidPath, { force: true });
    throw error;
  }
  printStatus("running", prepared, child.pid);
}

async function stopXiaozhiHost() {
  const existing = readProcessRecord();
  if (!existing) {
    console.log("Xiaozhi host service is not recorded as running.");
    return;
  }
  if (isProcessAlive(existing.pid)) {
    assertManagedProcess(existing.pid);
    terminateManagedProcess(existing.pid);
    await waitForExit(existing.pid, 10_000);
  }
  rmSync(pidPath, { force: true });
  console.log("Xiaozhi host service stopped.");
}

async function showXiaozhiHostStatus() {
  const existing = readProcessRecord();
  const running = Boolean(existing && isProcessAlive(existing.pid));
  if (running) assertManagedProcess(existing.pid);
  let deliveryReachable = false;
  if (running && existsSync(keyPath)) {
    const apiKey = ensureHexRuntimeSecret(keyPath);
    deliveryReachable = await probeDelivery(apiKey);
  }
  console.log(JSON.stringify({
    status: running ? "running" : "stopped",
    pid: running ? existing.pid : null,
    websocket: `ws://<this-mac-lan-ip>:${wsPort}/xiaozhi/v1/`,
    ota: `http://<this-mac-lan-ip>:${httpPort}/xiaozhi/ota/`,
    delivery: {
      bind: `127.0.0.1:${deliveryPort}`,
      authenticated: true,
      reachable: deliveryReachable,
    },
  }, null, 2));
}

async function waitForReady(apiKey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [wsReady, httpReady, deliveryReady] = await Promise.all([
      isTcpOpen("127.0.0.1", wsPort),
      isTcpOpen("127.0.0.1", httpPort),
      probeDelivery(apiKey),
    ]);
    if (wsReady && httpReady && deliveryReady) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for Xiaozhi ports ${wsPort}, ${httpPort}, and ${deliveryPort}.`);
}

async function probeDelivery(apiKey) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${deliveryPort}/internal/v1/delivery/tts/jarvis-health-probe`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(1000),
      },
    );
    return response.status === 404;
  } catch {
    return false;
  }
}

function printStatus(status, prepared, pid) {
  console.log(JSON.stringify({
    status,
    pid,
    websocket: `ws://<this-mac-lan-ip>:${prepared.wsPort}/xiaozhi/v1/`,
    ota: `http://<this-mac-lan-ip>:${prepared.httpPort}/xiaozhi/ota/`,
    delivery: {
      bind: `${prepared.deliveryHost}:${prepared.deliveryPort}`,
      authenticated: true,
      keyPath: prepared.keyPath,
    },
    allowedDeviceCount: prepared.allowedDeviceCount,
  }, null, 2));
}

function readProcessRecord() {
  if (!existsSync(pidPath)) return null;
  try {
    return JSON.parse(readFileSync(pidPath, "utf8"));
  } catch {
    return null;
  }
}

function assertManagedProcess(pid) {
  let commandLine = "";
  try {
    commandLine = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(`Cannot verify recorded Xiaozhi PID ${pid}.`);
  }
  if (!isExpectedXiaozhiCommand(commandLine)) {
    throw new Error(`Refusing to manage PID ${pid}: process identity does not match Xiaozhi app.py.`);
  }
}

function terminateManagedProcess(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for Xiaozhi PID ${pid} to stop.`);
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

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main() {
  switch (command) {
    case "prepare": {
      const prepared = await prepareXiaozhiHost();
      printStatus("prepared", prepared, null);
      break;
    }
    case "start":
      await startXiaozhiHost();
      break;
    case "stop":
      await stopXiaozhiHost();
      break;
    case "status":
      await showXiaozhiHostStatus();
      break;
    default:
      throw new Error("Usage: node scripts/jarvis-xiaozhi-host.mjs prepare|start|stop|status");
  }
}

if (resolve(process.argv[1] || "") === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
