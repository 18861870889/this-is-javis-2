#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ensureHexRuntimeSecret,
  writeRuntimeSecretFile,
} from "../src/runtimeSecret.js";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), "..");
const imageName = process.env.JARVIS_CONTAINER_IMAGE || "harness-house-jarvis:local";
const containerName = process.env.JARVIS_CONTAINER_NAME || "harness-house-jarvis";
const bindHost = process.env.JARVIS_CONTAINER_BIND_HOST || "127.0.0.1";
const hostPort = parsePort(process.env.JARVIS_CONTAINER_PORT || "5183");
const requestedMode = process.env.JARVIS_CONTAINER_EXECUTION_MODE === "real" ? "real" : "dry_run";
const command = process.argv[2] || "check";
const containerDataDir = resolve(
  process.env.JARVIS_CONTAINER_DATA_DIR || join(rootDir, "data/container-runtime.local"),
);
const CONTAINER_PASSTHROUGH_ENV_KEYS = [
  "HA_BASE_URL",
  "HOME_ASSISTANT_URL",
  "JARVIS_STACKCHAN_DEVICE_ROOMS",
  "JARVIS_XIAOZHI_DEVICE_ID",
  "JARVIS_XIAOZHI_ROOM_ID",
  "JARVIS_UTTERANCE_DEDUPE_WINDOW_MS",
  "JARVIS_ALLOWED_ACTION_ROOM_IDS",
  "JARVIS_ALLOWED_ENTITY_IDS",
  "JARVIS_INGRESS_ALLOWED_DEVICE_IDS",
  "JARVIS_INGRESS_ALLOWED_ROOM_IDS",
  "JARVIS_INGRESS_REQUIRE_TEXT_PATTERN",
  "JARVIS_INGRESS_ALLOWED_TEXTS",
  "JARVIS_MCP_ALLOWED_ROOM_IDS",
  "JARVIS_MCP_REQUIRE_TEXT_PATTERN",
  "JARVIS_MCP_ALLOWED_TEXTS",
  "JARVIS_SEMANTIC_CACHE_ENABLED",
];
const CONFIRMED_NON_RUNNING_CONTAINER_STATES = new Set([
  "created",
  "dead",
  "exited",
  "stopped",
]);

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid container port: ${value}`);
  }
  return port;
}

function readEnvironmentFile(path) {
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

function validateEnvironmentValue(key, value) {
  const text = String(value ?? "");
  if (/[\r\n\0]/.test(text)) {
    throw new Error(`Container environment value contains an unsafe character: ${key}`);
  }
  return text;
}

function environmentEntry(key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid container environment key: ${key}`);
  }
  return `${key}=${validateEnvironmentValue(key, value)}`;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env || process.env,
  });

  if (result.error) {
    if (options.allowFailure) return result;
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture
      ? redactSensitiveText((result.stderr || result.stdout || "").trim())
      : "";
    const commandText = redactSensitiveText(`${executable} ${args.join(" ")}`);
    throw new Error(`${commandText} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function redactSensitiveText(value) {
  return String(value || "")
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|AUTHORIZATION)[A-Z0-9_]*)=([^\s]+)/gi,
      "$1=<redacted>",
    )
    .replace(/(\bAuthorization:\s*Bearer\s+)[^\s]+/gi, "$1<redacted>");
}

function hasCommand(executable, args = ["--version"]) {
  return run(executable, args, { capture: true, allowFailure: true }).status === 0;
}

function selectEngine() {
  const requested = (process.env.JARVIS_CONTAINER_ENGINE || "auto").toLowerCase();
  const appleAvailable = process.platform === "darwin" && hasCommand("container");
  const dockerAvailable = hasCommand("docker", ["compose", "version"]);

  if (["apple", "container"].includes(requested)) {
    if (!appleAvailable) throw new Error("Apple Container CLI is not available on this Mac.");
    return "apple";
  }
  if (requested === "docker") {
    if (!dockerAvailable) throw new Error("Docker with Compose is not available.");
    return "docker";
  }
  if (requested !== "auto") {
    throw new Error("JARVIS_CONTAINER_ENGINE must be auto, apple, or docker.");
  }
  if (appleAvailable) return "apple";
  if (dockerAvailable) return "docker";
  throw new Error("Install Apple Container or Docker before running Jarvis in a container.");
}

function ensureAppleSystem() {
  const status = run("container", ["system", "status"], { capture: true, allowFailure: true });
  const output = `${status.stdout || ""}\n${status.stderr || ""}`;
  if (status.status !== 0 || !/running/i.test(output)) {
    console.log("Starting Apple Container system...");
    run("container", ["system", "start"]);
  }
}

function build(engine) {
  console.log(`Building ${imageName} with ${engine === "apple" ? "Apple Container" : "Docker"}...`);
  if (engine === "apple") {
    ensureAppleSystem();
    run("container", ["build", "--target", "runtime", "--tag", imageName, "."]);
    return;
  }
  run("docker", ["build", "--target", "runtime", "--tag", imageName, "."]);
}

function commonEnvironment(mode = requestedMode, additional = []) {
  return [
    "NODE_ENV=production",
    "JARVIS_BIND_HOST=0.0.0.0",
    "PORT=5173",
    `HARNESS_EXECUTION_MODE=${mode}`,
    "HERMES_API_TRANSPORT=api",
    "HERMES_API_TIMEOUT_MS=30000",
    "JARVIS_BRAIN_INTENT_CLASSIFIER=hermes",
    "JARVIS_BRAIN_INTENT_REQUIRED=true",
    "JARVIS_BRAIN_INTENT_TIMEOUT_MS=20000",
    "JARVIS_HOME_INTENT_PLANNER=hermes",
    "JARVIS_HOME_INTENT_REQUIRED=true",
    "JARVIS_HOME_INTENT_TIMEOUT_MS=20000",
    "JARVIS_PC_TASK_MODE=hermes",
    "JARVIS_SUBAGENT_COMMAND=",
    "JARVIS_DELIVERY_WECHAT_ENABLED=false",
    "JARVIS_XIAOZHI_DELIVERY_BASE_URL=",
    "JARVIS_XIAOZHI_DELIVERY_API_KEY=",
    "JARVIS_XIAOZHI_DELIVERY_API_KEY_FILE=",
    "HERMES_API_KEY=",
    "HERMES_API_KEY_FILE=",
    "HA_TOKEN=",
    "HOME_ASSISTANT_TOKEN=",
    "HA_TOKEN_FILE=",
    `JARVIS_MCP_ALLOW_REAL=${mode === "real" ? "true" : "false"}`,
    `JARVIS_XIAOZHI_ALLOW_REAL=${mode === "real" ? "true" : "false"}`,
    "OPENAI_API_KEY=",
    "OPENAI_BASE_URL=",
    "OPENAI_MODEL=",
    ...additional,
  ];
}

function removeAppleContainer(name) {
  const inspected = run("container", ["inspect", name], { capture: true, allowFailure: true });
  if (inspected.status !== 0) return;
  run("container", ["stop", name], { allowFailure: true });
  run("container", ["rm", name], { allowFailure: true });
}

function startApple({
  name,
  port,
  mode,
  dataDir,
  environment = [],
  secretMounts = [],
}) {
  ensureAppleSystem();
  removeAppleContainer(name);
  mkdirSync(dataDir, { recursive: true });

  const hostUid = process.getuid?.() ?? 1000;
  const hostGid = process.getgid?.() ?? 1000;
  const generatedEnvironmentDirectory = mkdtempSync(join(tmpdir(), "jarvis-container-env-"));
  const generatedEnvironmentPath = join(generatedEnvironmentDirectory, "runtime.env");
  writeFileSync(
    generatedEnvironmentPath,
    `${commonEnvironment(mode, environment).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(generatedEnvironmentPath, 0o600);

  const args = [
    "run",
    "--name", name,
    "--detach",
    "--read-only",
    "--cap-drop", "ALL",
    "--cpus", "2",
    "--memory", "1G",
    "--uid", String(hostUid === 0 ? 1000 : hostUid),
    "--gid", String(hostUid === 0 ? 1000 : hostGid),
  ];
  args.push("--env-file", generatedEnvironmentPath);
  for (const mount of secretMounts) {
    args.push(
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target},readonly`,
    );
  }
  args.push(
    "--publish", `${bindHost}:${port}:5173`,
    "--volume", `${dataDir}:/app/data`,
    "--tmpfs", "/tmp",
    imageName,
  );
  try {
    run("container", args);
  } finally {
    rmSync(generatedEnvironmentDirectory, { recursive: true, force: true });
  }
}

function startDocker(hermes, xiaozhiDelivery, runtimeConfig, mode = requestedMode) {
  const env = {
    ...process.env,
    JARVIS_CONTAINER_IMAGE: imageName,
    JARVIS_CONTAINER_NAME: containerName,
    JARVIS_CONTAINER_BIND_HOST: bindHost,
    JARVIS_CONTAINER_PORT: String(hostPort),
    JARVIS_CONTAINER_EXECUTION_MODE: mode,
    HERMES_API_BASE_URL: hermes.containerBaseUrl,
    HERMES_API_KEY: "",
    HERMES_API_KEY_FILE: "/run/secrets/hermes/api.key",
    JARVIS_HERMES_PC_WORKSPACE_ROOT: hermes.pcWorkspaceRoot,
    JARVIS_XIAOZHI_DELIVERY_BASE_URL: xiaozhiDelivery.containerBaseUrl,
    JARVIS_XIAOZHI_DELIVERY_API_KEY: "",
    JARVIS_XIAOZHI_DELIVERY_API_KEY_FILE: "/run/secrets/xiaozhi/api.key",
    HA_TOKEN: "",
    HOME_ASSISTANT_TOKEN: "",
    HA_TOKEN_FILE: "/run/secrets/container/ha_token",
    JARVIS_HERMES_API_KEY_SOURCE: dirname(hermes.keyPath),
    JARVIS_XIAOZHI_DELIVERY_KEY_SOURCE: dirname(xiaozhiDelivery.keyPath),
    JARVIS_HA_TOKEN_SOURCE: dirname(runtimeConfig.haTokenPath),
    JARVIS_MCP_ALLOW_REAL: mode === "real" ? "true" : "false",
    JARVIS_XIAOZHI_ALLOW_REAL: mode === "real" ? "true" : "false",
    ...runtimeConfig.safeEnvironment,
  };
  run("docker", ["compose", "up", "--detach", "--build"], { env });
}

export function evaluateContainerStartupGate({ mode, readiness } = {}) {
  const executionMode = mode === "real" ? "real" : "dry_run";
  const checks = {
    storage: readiness?.storage?.writable === true,
    hermes: readiness?.dependencies?.hermes?.configured === true
      && readiness?.dependencies?.hermes?.reachable === true,
    homeAssistant: readiness?.dependencies?.homeAssistant?.configured === true
      && readiness?.dependencies?.homeAssistant?.reachable === true,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const fullyReady = readiness?.ready === true && failedChecks.length === 0;

  return {
    executionMode,
    allowed: executionMode === "dry_run" || fullyReady,
    shouldStop: executionMode === "real" && !fullyReady,
    state: fullyReady ? "ready" : executionMode === "real" ? "blocked" : "degraded",
    failedChecks,
  };
}

export function containerStartupPhases(mode) {
  return mode === "real" ? ["dry_run", "real"] : ["dry_run"];
}

export async function cleanupRejectedContainerStart({
  mode,
  startAttempted,
  stopContainer,
  inspectContainerState,
} = {}) {
  if (mode !== "real" || startAttempted !== true) return false;
  if (typeof stopContainer !== "function") {
    throw new Error("Real-mode startup cleanup requires a stop function.");
  }
  if (typeof inspectContainerState !== "function") {
    throw new Error("Real-mode startup cleanup requires a container state inspector.");
  }

  let stopError = null;
  try {
    await stopContainer();
  } catch (error) {
    stopError = error;
  }

  let observedState;
  try {
    observedState = await inspectContainerState();
  } catch (error) {
    const stopDetail = stopError
      ? ` Stop/remove also failed: ${redactSensitiveText(stopError.message)}.`
      : "";
    throw new Error(
      `Rejected real-mode container cleanup could not be verified.${stopDetail} `
      + `State inspection failed: ${redactSensitiveText(error.message)}`,
    );
  }

  const observedStates = Array.isArray(observedState?.states)
    ? observedState.states
    : [observedState?.state];
  const confirmedNonRunning = (
    observedState?.exists === true
    && observedState?.running === false
    && observedStates.length > 0
    && observedStates.every((state) => (
      CONFIRMED_NON_RUNNING_CONTAINER_STATES.has(String(state || "").toLowerCase())
    ))
  );
  if (observedState?.exists === false || confirmedNonRunning) {
    return true;
  }

  const stopDetail = stopError
    ? ` Stop/remove failed: ${redactSensitiveText(stopError.message)}.`
    : "";
  if (observedState?.running === true) {
    throw new Error(
      `Rejected real-mode container cleanup failed: container is still running after stop/remove.`
      + stopDetail,
    );
  }
  throw new Error(
    `Rejected real-mode container cleanup could not confirm an absent or non-running container.`
    + stopDetail,
  );
}

async function start(engine) {
  build(engine);
  const hermes = ensureHermesForContainer(engine);
  const xiaozhiDelivery = ensureXiaozhiDeliveryForContainer(engine);
  const runtimeConfig = prepareContainerRuntimeConfiguration();
  let containerStartAttempted = false;

  try {
    if (containerStartupPhases(requestedMode).length > 1) {
      console.log("Running a dry-run dependency preflight before enabling real control...");
      containerStartAttempted = true;
      launchContainer(engine, hermes, xiaozhiDelivery, runtimeConfig, "dry_run");
      const preflightUrl = `http://${displayHost(bindHost)}:${hostPort}`;
      await waitForHealthy(preflightUrl, 45_000, "dry_run");
      const preflightReadiness = await readRuntimeReadiness(preflightUrl);
      const preflightGate = evaluateContainerStartupGate({
        mode: "real",
        readiness: preflightReadiness,
      });
      stop(engine);
      containerStartAttempted = false;
      if (!preflightGate.allowed) {
        throw new Error(
          `Real-mode preflight blocked by runtime readiness checks: ${preflightGate.failedChecks.join(", ")}.`,
        );
      }
    }

    containerStartAttempted = true;
    launchContainer(engine, hermes, xiaozhiDelivery, runtimeConfig, requestedMode);
    const url = `http://${displayHost(bindHost)}:${hostPort}`;
    await waitForHealthy(url, 45_000, requestedMode);
    const readiness = await readRuntimeReadiness(url);
    const gate = evaluateContainerStartupGate({
      mode: requestedMode,
      readiness,
    });
    if (!gate.allowed) {
      throw new Error(
        `Real-mode startup blocked by runtime readiness checks: ${gate.failedChecks.join(", ")}.`,
      );
    }
    console.log(`Jarvis is running at ${url}`);
    console.log(`Execution mode: ${requestedMode}`);
    console.log(`Runtime dependencies: ${gate.state}`);
  } catch (error) {
    let stopped = false;
    try {
      stopped = await cleanupRejectedContainerStart({
        mode: requestedMode,
        startAttempted: containerStartAttempted,
        stopContainer: () => stop(engine),
        inspectContainerState: () => inspectRejectedContainerState(engine),
      });
    } catch (cleanupError) {
      throw new Error(
        `${redactSensitiveText(error.message)} Failed to stop the rejected real-mode container: ${redactSensitiveText(cleanupError.message)}`,
      );
    }
    if (stopped) {
      throw new Error(
        `${redactSensitiveText(error.message)} The rejected real-mode container was confirmed absent or non-running.`,
      );
    }
    throw new Error(redactSensitiveText(error.message));
  }
}

function launchContainer(engine, hermes, xiaozhiDelivery, runtimeConfig, mode) {
  if (engine === "apple") {
    startApple({
      name: containerName,
      port: hostPort,
      mode,
      dataDir: containerDataDir,
      environment: [
        `HERMES_API_BASE_URL=${hermes.containerBaseUrl}`,
        "HERMES_API_KEY_FILE=/run/secrets/hermes/api.key",
        `JARVIS_HERMES_PC_WORKSPACE_ROOT=${hermes.pcWorkspaceRoot}`,
        `JARVIS_XIAOZHI_DELIVERY_BASE_URL=${xiaozhiDelivery.containerBaseUrl}`,
        "JARVIS_XIAOZHI_DELIVERY_API_KEY_FILE=/run/secrets/xiaozhi/api.key",
        "HA_TOKEN_FILE=/run/secrets/container/ha_token",
        ...Object.entries(runtimeConfig.safeEnvironment)
          .map(([key, value]) => environmentEntry(key, value)),
      ],
      secretMounts: [
        { source: dirname(hermes.keyPath), target: "/run/secrets/hermes" },
        { source: dirname(xiaozhiDelivery.keyPath), target: "/run/secrets/xiaozhi" },
        { source: dirname(runtimeConfig.haTokenPath), target: "/run/secrets/container" },
      ],
    });
    return;
  }
  startDocker(hermes, xiaozhiDelivery, runtimeConfig, mode);
}

function ensureXiaozhiDeliveryForContainer(engine) {
  const keyPath = join(rootDir, "data/jarvis-xiaozhi-delivery.local/api.key");
  const apiKey = ensureHexRuntimeSecret(keyPath);
  const port = parsePort(process.env.JARVIS_XIAOZHI_DELIVERY_PORT || "8004");
  const containerHost = engine === "apple"
    ? process.env.JARVIS_APPLE_XIAOZHI_DELIVERY_HOST || "203.0.113.113"
    : process.env.JARVIS_DOCKER_XIAOZHI_DELIVERY_HOST || "host.docker.internal";
  return {
    apiKey,
    keyPath,
    containerBaseUrl: `http://${containerHost}:${port}`,
  };
}

export function containerSafeEnvironment({
  env = process.env,
  envFile = {},
} = {}) {
  const source = { ...envFile, ...env };
  return Object.fromEntries(
    CONTAINER_PASSTHROUGH_ENV_KEYS
      .filter((key) => source[key] !== undefined && String(source[key]).trim() !== "")
      .map((key) => [key, validateEnvironmentValue(key, source[key])]),
  );
}

function prepareContainerRuntimeConfiguration() {
  const envFile = readEnvironmentFile(join(rootDir, ".env"));
  const source = { ...envFile, ...process.env };
  const haToken = source.HA_TOKEN || source.HOME_ASSISTANT_TOKEN || "";
  const haTokenPath = writeRuntimeSecretFile(
    join(rootDir, "data/jarvis-container-secrets.local/ha_token"),
    haToken,
  );
  return {
    haTokenPath,
    safeEnvironment: containerSafeEnvironment({ env: process.env, envFile }),
  };
}

function ensureHermesForContainer(engine) {
  const host = process.env.JARVIS_HERMES_API_HOST || "127.0.0.1";
  const port = parsePort(process.env.JARVIS_HERMES_API_PORT || "8642");
  const managerEnv = {
    ...process.env,
    JARVIS_HERMES_API_HOST: host,
    JARVIS_HERMES_API_PORT: String(port),
  };
  console.log("Preparing the authenticated native Hermes API...");
  run(process.execPath, ["scripts/jarvis-hermes-api.mjs", "ensure-service"], {
    capture: true,
    env: managerEnv,
  });

  const keyPath = join(rootDir, "data/jarvis-hermes-api.local/api.key");
  const apiKey = readFileSync(keyPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/i.test(apiKey)) {
    throw new Error(`Hermes API key is invalid: ${keyPath}`);
  }
  const containerHost = engine === "apple"
    ? process.env.JARVIS_APPLE_HERMES_HOST || "203.0.113.113"
    : process.env.JARVIS_DOCKER_HERMES_HOST || "host.docker.internal";
  const result = {
    apiKey,
    keyPath,
    containerBaseUrl: `http://${containerHost}:${port}`,
    pcWorkspaceRoot: process.env.JARVIS_HERMES_PC_WORKSPACE_ROOT
      || join(rootDir, "data/pc-workspace.local"),
  };
  if (engine === "apple") {
    assertAppleHostAccessConfigured();
    probeHermesFromAppleContainer(result);
  }
  return result;
}

function assertAppleHostAccessConfigured() {
  const result = run("container", ["system", "dns", "list"], {
    capture: true,
    allowFailure: true,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 && /(^|\s)host\.container\.internal(\s|$)/m.test(output)) return;
  throw new Error(
    "Apple Container host access is not configured. Run: "
    + "sudo container system dns create host.container.internal --localhost 203.0.113.113",
  );
}

function probeHermesFromAppleContainer({ keyPath, containerBaseUrl }) {
  const probeDirectory = mkdtempSync(join(tmpdir(), "jarvis-hermes-probe-"));
  const probeEnvironmentPath = join(probeDirectory, "probe.env");
  writeFileSync(
    probeEnvironmentPath,
    `HERMES_API_BASE_URL=${containerBaseUrl}\nHERMES_API_KEY_FILE=/run/secrets/hermes/api.key\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(probeEnvironmentPath, 0o600);
  const script = [
    "const fs = await import('node:fs');",
    "const apiKey = fs.readFileSync(process.env.HERMES_API_KEY_FILE, 'utf8').trim();",
    "const response = await fetch(`${process.env.HERMES_API_BASE_URL}/v1/models`, {",
    "headers: { Authorization: `Bearer ${apiKey}` },",
    "signal: AbortSignal.timeout(5000),",
    "});",
    "const body = await response.json();",
    "if (!response.ok || body?.object !== 'list' || !Array.isArray(body.data)) process.exit(9);",
  ].join(" ");
  try {
    run("container", [
      "run",
      "--rm",
      "--name", `jarvis-hermes-probe-${process.pid}`,
      "--env-file", probeEnvironmentPath,
      "--mount", `type=bind,source=${dirname(keyPath)},target=/run/secrets/hermes,readonly`,
      "--entrypoint", "/usr/local/bin/node",
      imageName,
      "-e", script,
    ], { capture: true });
  } catch (error) {
    throw new Error(
      `Hermes is healthy on host localhost but unreachable from Apple Container via ${containerBaseUrl}. `
      + "Recreate the host access rule after an Apple Container or macOS restart. "
      + `Details: ${redactSensitiveText(error.message)}`,
    );
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
  }
}

function stop(engine) {
  if (engine === "apple") {
    removeAppleContainer(containerName);
  } else {
    run("docker", ["compose", "down"]);
  }
}

export function inspectRejectedContainerState(engine, runCommand = run) {
  if (engine === "apple") {
    const inspected = runCommand("container", ["inspect", containerName], {
      capture: true,
      allowFailure: true,
    });
    if (inspected.status !== 0) {
      const output = `${inspected.stderr || ""}\n${inspected.stdout || ""}`.trim();
      if (/container not found|no such container|does not exist/i.test(output)) {
        return { exists: false, running: false, state: "absent" };
      }
      throw new Error(
        `Apple Container inspection failed${output ? `: ${redactSensitiveText(output)}` : ""}`,
      );
    }

    let records;
    try {
      const parsed = JSON.parse(inspected.stdout || "[]");
      records = Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      throw new Error(`Apple Container inspection returned invalid JSON: ${error.message}`);
    }
    const record = records[0];
    if (!record) return { exists: false, running: false, state: "absent" };
    const state = String(record?.status?.state || "").trim().toLowerCase();
    if (state === "running") {
      return { exists: true, running: true, state };
    }
    if (!CONFIRMED_NON_RUNNING_CONTAINER_STATES.has(state)) {
      throw new Error(
        `Apple Container inspection returned an unconfirmed state: ${state || "missing"}`,
      );
    }
    return { exists: true, running: false, state };
  }

  const allContainers = runCommand(
    "docker",
    ["compose", "ps", "--all", "--quiet"],
    { capture: true, allowFailure: true },
  );
  if (allContainers.status !== 0) {
    const detail = (allContainers.stderr || allContainers.stdout || "").trim();
    throw new Error(
      `Docker Compose inspection failed${detail ? `: ${redactSensitiveText(detail)}` : ""}`,
    );
  }
  const allIds = String(allContainers.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (allIds.length === 0) {
    return { exists: false, running: false, state: "absent" };
  }

  const inspected = runCommand(
    "docker",
    ["inspect", "--format", "{{.State.Status}}", ...allIds],
    { capture: true, allowFailure: true },
  );
  if (inspected.status !== 0) {
    const detail = (inspected.stderr || inspected.stdout || "").trim();
    throw new Error(
      `Docker container state inspection failed${detail ? `: ${redactSensitiveText(detail)}` : ""}`,
    );
  }
  const states = String(inspected.stdout || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.toLowerCase());
  if (states.length !== allIds.length) {
    throw new Error(
      `Docker container state inspection returned ${states.length} states for ${allIds.length} containers.`,
    );
  }
  const unconfirmedState = states.find((state) => (
    state !== "running" && !CONFIRMED_NON_RUNNING_CONTAINER_STATES.has(state)
  ));
  if (unconfirmedState) {
    throw new Error(
      `Docker container state inspection returned an unconfirmed state: ${unconfirmedState}`,
    );
  }
  const running = states.includes("running");
  return {
    exists: true,
    running,
    state: running ? "running" : states[0],
    states,
  };
}

function status(engine) {
  if (engine === "apple") {
    ensureAppleSystem();
    const inspected = run("container", ["inspect", containerName], { capture: true });
    const [record] = JSON.parse(inspected.stdout || "[]");
    const configuration = record?.configuration || {};
    console.log(JSON.stringify({
      name: record?.id || containerName,
      state: record?.status?.state || "unknown",
      image: configuration.image?.reference || imageName,
      publishedPorts: configuration.publishedPorts || [],
      readOnly: configuration.readOnly === true,
      droppedCapabilities: configuration.capDrop || [],
      user: configuration.initProcess?.user?.id || null,
      resources: configuration.resources || null,
    }, null, 2));
  } else {
    run("docker", ["compose", "ps"]);
  }
}

function check(engine) {
  for (const path of ["Dockerfile", "compose.yaml", "package.json", "package-lock.json", "server.mjs"]) {
    if (!existsSync(join(rootDir, path))) throw new Error(`Missing required file: ${path}`);
  }
  if (engine === "apple") {
    ensureAppleSystem();
  } else {
    run("docker", ["compose", "config", "--quiet"]);
  }
  console.log(`Container engine: ${engine === "apple" ? "Apple Container" : "Docker"}`);
  console.log(`Image: ${imageName}`);
  console.log(`Published endpoint: http://${displayHost(bindHost)}:${hostPort}`);
  console.log(`Execution mode: ${requestedMode}`);
}

function displayHost(host) {
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}

async function waitForHealthy(url, timeoutMs = 45_000, expectedMode = "dry_run") {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/runtime/status`);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.execution?.mode !== expectedMode) {
          throw new Error(`Smoke container started in unexpected mode: ${payload?.execution?.mode}`);
        }
        if (payload?.storage?.writable !== true) {
          throw new Error("Smoke container data directory is not writable.");
        }
        return payload;
      }
      lastError = new Error(`Status endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  throw new Error(`Jarvis did not become healthy: ${lastError?.message || "timeout"}`);
}

async function readRuntimeReadiness(url) {
  const response = await fetch(`${url}/api/runtime/readiness`);
  const payload = await response.json();
  return {
    ...payload,
    httpStatus: response.status,
  };
}

async function liveCheck() {
  const url = `http://${displayHost(bindHost)}:${hostPort}`;
  await waitForHealthy(url, 10_000, requestedMode);
  const readiness = await readRuntimeReadiness(url);
  console.log(JSON.stringify(readiness, null, 2));
  if (!readiness.ready) {
    throw new Error("Jarvis runtime dependencies are not ready.");
  }
}

function verifyFilesystem(engine, name) {
  const script = [
    'const fs = require("node:fs");',
    'for (const path of ["/app/data/.jarvis-smoke", "/tmp/.jarvis-smoke"]) {',
    '  fs.writeFileSync(path, "ok"); fs.rmSync(path);',
    '}',
    'try { fs.writeFileSync("/app/.jarvis-must-stay-read-only", "bad"); process.exit(9); }',
    'catch (error) { if (!["EROFS", "EACCES", "EPERM"].includes(error.code)) throw error; }',
  ].join(" ");
  if (engine === "apple") {
    run("container", ["exec", name, "node", "-e", script]);
  } else {
    run("docker", ["exec", name, "node", "-e", script]);
  }
}

async function smoke(engine) {
  build(engine);
  const smokeName = `${containerName}-smoke-${process.pid}`;
  const smokePort = parsePort(process.env.JARVIS_CONTAINER_SMOKE_PORT || "5193");
  const url = `http://${displayHost(bindHost)}:${smokePort}`;
  let appleDataDir;
  let dockerVolume;

  try {
    if (engine === "apple") {
      appleDataDir = mkdtempSync(join(tmpdir(), "jarvis-container-smoke-"));
      chmodSync(appleDataDir, 0o700);
      startApple({
        name: smokeName,
        port: smokePort,
        mode: "dry_run",
        dataDir: appleDataDir,
      });
    } else {
      dockerVolume = `${smokeName}-data`;
      run("docker", ["volume", "create", dockerVolume], { capture: true });
      const args = [
        "run", "--name", smokeName, "--detach", "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
        "--mount", `type=volume,source=${dockerVolume},target=/app/data`,
        "--publish", `${bindHost}:${smokePort}:5173`,
      ];
      for (const entry of commonEnvironment("dry_run")) args.push("--env", entry);
      args.push(imageName);
      run("docker", args);
    }

    await waitForHealthy(url, 45_000, "dry_run");
    verifyFilesystem(engine, smokeName);
    const homepage = await fetch(url);
    const html = await homepage.text();
    if (!homepage.ok || !/<html/i.test(html)) {
      throw new Error("Production homepage did not return HTML.");
    }
    console.log(`Container smoke test passed at ${url} (dry_run).`);
  } finally {
    if (engine === "apple") {
      removeAppleContainer(smokeName);
      if (appleDataDir) rmSync(appleDataDir, { recursive: true, force: true });
    } else {
      run("docker", ["rm", "--force", smokeName], { allowFailure: true });
      if (dockerVolume) run("docker", ["volume", "rm", dockerVolume], { allowFailure: true });
    }
  }
}

async function main() {
  const engine = selectEngine();
  switch (command) {
    case "check":
      check(engine);
      break;
    case "build":
      build(engine);
      break;
    case "start":
      await start(engine);
      break;
    case "stop":
      stop(engine);
      break;
    case "status":
      status(engine);
      break;
    case "smoke":
      await smoke(engine);
      break;
    case "live-check":
      await liveCheck();
      break;
    default:
      throw new Error("Usage: node scripts/jarvis-container.mjs check|build|start|stop|status|smoke|live-check");
  }
}

if (resolve(process.argv[1] || "") === resolve(scriptPath)) {
  main().catch((error) => {
    console.error(redactSensitiveText(error.message));
    process.exitCode = 1;
  });
}
