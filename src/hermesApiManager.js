import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureHermesApiIsolation } from "./hermesApiIsolation.js";

const MANAGER_ID = "jarvis-hermes-api";
const PROCESS_ARGS = ["-m", "hermes_cli.main", "gateway", "run", "--replace"];
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8642;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export function resolveHermesApiConfig({
  repoRoot = process.cwd(),
  env = process.env,
  runtimeDir,
} = {}) {
  const hermesHome = resolve(env.HERMES_HOME || join(homedir(), ".hermes"));
  const hermesRoot = resolve(
    env.JARVIS_HERMES_AGENT_ROOT || join(hermesHome, "hermes-agent"),
  );
  const host = String(env.JARVIS_HERMES_API_HOST || DEFAULT_HOST).trim();
  const port = parseInteger(env.JARVIS_HERMES_API_PORT, DEFAULT_PORT, "JARVIS_HERMES_API_PORT", {
    minimum: 1,
    maximum: 65_535,
  });
  const startTimeoutMs = parseInteger(
    env.JARVIS_HERMES_API_START_TIMEOUT_MS,
    DEFAULT_START_TIMEOUT_MS,
    "JARVIS_HERMES_API_START_TIMEOUT_MS",
    { minimum: 1 },
  );
  const stopTimeoutMs = parseInteger(
    env.JARVIS_HERMES_API_STOP_TIMEOUT_MS,
    DEFAULT_STOP_TIMEOUT_MS,
    "JARVIS_HERMES_API_STOP_TIMEOUT_MS",
    { minimum: 1 },
  );
  const resolvedRuntimeDir = resolve(
    runtimeDir || join(repoRoot, "data/jarvis-hermes-api.local"),
  );
  const pythonPath = resolve(
    env.JARVIS_HERMES_API_PYTHON
      || env.HERMES_CLI_PYTHON
      || join(hermesRoot, "venv/bin/python"),
  );

  if (!host) throw new Error("JARVIS_HERMES_API_HOST must not be empty.");

  return {
    managerId: MANAGER_ID,
    repoRoot: resolve(repoRoot),
    runtimeDir: resolvedRuntimeDir,
    keyPath: join(resolvedRuntimeDir, "api.key"),
    pidPath: join(resolvedRuntimeDir, "process.json"),
    logPath: join(resolvedRuntimeDir, "hermes-api.log"),
    hermesHome,
    hermesEnvPath: join(hermesHome, ".env"),
    hermesRoot,
    pythonPath,
    processArgs: [...PROCESS_ARGS],
    host,
    port,
    readinessUrl: buildReadinessUrl(host, port),
    startTimeoutMs,
    stopTimeoutMs,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };
}

export function createApiKey(randomBytesImpl = randomBytes) {
  return randomBytesImpl(32).toString("hex");
}

export function isExpectedHermesProcess({ record, snapshot, config }) {
  if (!record || record.managerId !== MANAGER_ID || !snapshot) return false;
  if (Number(record.pid) !== Number(snapshot.pid)) return false;
  if (!record.processStartedAt || record.processStartedAt !== snapshot.startedAt) return false;

  const command = normalizeCommand(snapshot.command);
  const pythonPath = normalizeCommand(config.pythonPath);
  const moduleInvocation = normalizeCommand(PROCESS_ARGS.join(" "));
  return command.includes(pythonPath) && command.includes(moduleInvocation);
}

export function sanitizeHermesApiStatus(status) {
  return JSON.parse(JSON.stringify(status, (key, value) => {
    if (/key|token|secret|authorization/i.test(key)) return undefined;
    return value;
  }));
}

export function createHermesApiManager(options = {}) {
  const config = resolveHermesApiConfig(options);
  const launchEnv = options.env || process.env;
  const dependencies = {
    spawn: nodeSpawn,
    inspectProcess: inspectProcessSnapshot,
    signalProcess: signalDetachedProcess,
    fetch: globalThis.fetch,
    sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    now: () => Date.now(),
    randomBytes,
    restartGateway: restartInstalledGateway,
    ensureIsolation: ensureHermesApiIsolation,
    ...options.dependencies,
  };

  if (typeof dependencies.fetch !== "function") {
    throw new Error("Hermes API manager requires a fetch implementation.");
  }

  return {
    config,
    prepare: () => prepareHermesApi({ config, dependencies }),
    ensureService: () => ensureInstalledHermesApi({ config, dependencies, launchEnv }),
    disableService: () => disableInstalledHermesApi({ config, dependencies, launchEnv }),
    ensure: () => ensureHermesApi({ config, dependencies, launchEnv }),
    status: () => getHermesApiStatus({ config, dependencies }),
    stop: () => stopHermesApi({ config, dependencies }),
  };
}

async function disableInstalledHermesApi({ config, dependencies, launchEnv }) {
  assertHermesInstallation(config);
  const changed = updateHermesEnvironment(config.hermesEnvPath, {
    API_SERVER_ENABLED: "false",
    API_SERVER_HOST: config.host,
    API_SERVER_PORT: String(config.port),
    API_SERVER_KEY: null,
  });
  if (changed) {
    dependencies.restartGateway({ config, env: launchEnv });
  }
  return sanitizeHermesApiStatus({
    manager: MANAGER_ID,
    status: "stopped",
    lifecycle: "installed_gateway_service",
    reason: changed ? "service_disabled" : "already_disabled",
    host: config.host,
    port: config.port,
  });
}

async function ensureInstalledHermesApi({ config, dependencies, launchEnv }) {
  prepareHermesApi({ config, dependencies });
  const apiKey = readApiKey(config.keyPath);
  const isolation = dependencies.ensureIsolation({
    repoRoot: config.repoRoot,
    hermesHome: config.hermesHome,
    env: launchEnv,
  });
  const environmentChanged = updateHermesEnvironment(config.hermesEnvPath, {
    API_SERVER_ENABLED: "true",
    API_SERVER_HOST: config.host,
    API_SERVER_PORT: String(config.port),
    API_SERVER_KEY: apiKey,
  });
  const changed = environmentChanged || isolation.changed;
  let health = await probeHealth({
    url: config.readinessUrl,
    apiKey,
    fetchImpl: dependencies.fetch,
  });

  if (changed || !health.ok) {
    dependencies.restartGateway({ config, env: launchEnv });
    health = await waitForHealth({ config, apiKey, dependencies });
  }

  return sanitizeHermesApiStatus({
    manager: MANAGER_ID,
    status: health.ok ? "running" : "degraded",
    lifecycle: "installed_gateway_service",
    configurationUpdated: changed,
    isolatedApiTools: isolation.toolsets,
    health,
    host: config.host,
    port: config.port,
    readinessUrl: config.readinessUrl,
  });
}

function prepareHermesApi({ config, dependencies }) {
  ensureRuntimeDirectory(config.runtimeDir);
  assertHermesInstallation(config);
  ensureApiKey(config.keyPath, dependencies.randomBytes);
  return sanitizeHermesApiStatus({
    manager: MANAGER_ID,
    status: "prepared",
    host: config.host,
    port: config.port,
    readinessUrl: config.readinessUrl,
    keyPath: config.keyPath,
    pidPath: config.pidPath,
    logPath: config.logPath,
  });
}

async function ensureHermesApi({ config, dependencies, launchEnv }) {
  prepareHermesApi({ config, dependencies });
  dependencies.ensureIsolation({
    repoRoot: config.repoRoot,
    hermesHome: config.hermesHome,
    env: launchEnv,
  });
  const existingRecord = readPidRecord(config.pidPath);

  if (existingRecord) {
    const snapshot = dependencies.inspectProcess(existingRecord.pid);
    if (snapshot && !isExpectedHermesProcess({ record: existingRecord, snapshot, config })) {
      throw new Error(
        `Refusing to replace PID ${existingRecord.pid}: the recorded process identity does not match this Hermes API manager.`,
      );
    }
    if (snapshot) {
      const apiKey = readApiKey(config.keyPath);
      const health = await probeHealth({
        url: config.readinessUrl,
        apiKey,
        fetchImpl: dependencies.fetch,
      });
      return sanitizeHermesApiStatus(buildStatus({
        config,
        record: existingRecord,
        snapshot,
        health,
      }));
    }
    unlinkIfExists(config.pidPath);
  }

  const apiKey = readApiKey(config.keyPath);
  secureFile(config.logPath);
  const logDescriptor = openSync(config.logPath, "a", 0o600);
  let child;

  try {
    child = dependencies.spawn(config.pythonPath, config.processArgs, {
      cwd: config.hermesRoot,
      detached: true,
      env: {
        ...launchEnv,
        API_SERVER_ENABLED: "true",
        API_SERVER_HOST: config.host,
        API_SERVER_PORT: String(config.port),
        API_SERVER_KEY: apiKey,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
    child.unref?.();
    await waitForSpawn(child);
  } finally {
    closeSync(logDescriptor);
  }

  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    throw new Error("Hermes API process did not provide a valid PID.");
  }

  const snapshot = await waitForProcessSnapshot({
    pid: child.pid,
    config,
    dependencies,
  });
  const record = {
    version: 1,
    managerId: MANAGER_ID,
    pid: child.pid,
    processStartedAt: snapshot.startedAt,
    startedAt: new Date(dependencies.now()).toISOString(),
    hermesRoot: config.hermesRoot,
    pythonPath: config.pythonPath,
    host: config.host,
    port: config.port,
    logPath: config.logPath,
  };
  writeJsonAtomic(config.pidPath, record, 0o600);

  try {
    const health = await waitForHealth({
      config,
      apiKey,
      dependencies,
    });
    return sanitizeHermesApiStatus(buildStatus({ config, record, snapshot, health }));
  } catch (error) {
    const stopped = await stopHermesApi({ config, dependencies });
    const suffix = stopped.status === "refused"
      ? " Cleanup was refused because process ownership could not be verified."
      : "";
    throw new Error(`Hermes API failed to become healthy: ${error.message}.${suffix}`);
  }
}

function waitForSpawn(child) {
  if (typeof child?.once !== "function") return Promise.resolve();
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
}

async function getHermesApiStatus({ config, dependencies }) {
  const record = readPidRecord(config.pidPath);
  if (!record) {
    if (existsSync(config.keyPath)) {
      const apiKey = readApiKey(config.keyPath);
      const health = await probeHealth({
        url: config.readinessUrl,
        apiKey,
        fetchImpl: dependencies.fetch,
      });
      if (health.ok) {
        return sanitizeHermesApiStatus({
          manager: MANAGER_ID,
          status: "running",
          lifecycle: "installed_gateway_service",
          processVerified: false,
          health,
          host: config.host,
          port: config.port,
          readinessUrl: config.readinessUrl,
        });
      }
    }
    return sanitizeHermesApiStatus({
      manager: MANAGER_ID,
      status: "stopped",
      host: config.host,
      port: config.port,
      readinessUrl: config.readinessUrl,
      pidPath: config.pidPath,
      logPath: config.logPath,
    });
  }

  const snapshot = dependencies.inspectProcess(record.pid);
  if (!snapshot) {
    return sanitizeHermesApiStatus(buildStatus({
      config,
      record,
      status: "stale",
      reason: "recorded_process_not_running",
    }));
  }
  if (!isExpectedHermesProcess({ record, snapshot, config })) {
    return sanitizeHermesApiStatus(buildStatus({
      config,
      record,
      snapshot,
      status: "refused",
      reason: "process_identity_mismatch",
    }));
  }

  let health;
  try {
    const apiKey = readApiKey(config.keyPath);
    health = await probeHealth({
      url: config.readinessUrl,
      apiKey,
      fetchImpl: dependencies.fetch,
    });
  } catch (error) {
    health = { ok: false, error: error.message };
  }
  return sanitizeHermesApiStatus(buildStatus({ config, record, snapshot, health }));
}

async function stopHermesApi({ config, dependencies }) {
  const record = readPidRecord(config.pidPath);
  if (!record) {
    return sanitizeHermesApiStatus({
      manager: MANAGER_ID,
      status: "stopped",
      reason: "not_recorded",
    });
  }

  let snapshot = dependencies.inspectProcess(record.pid);
  if (!snapshot) {
    unlinkIfExists(config.pidPath);
    return sanitizeHermesApiStatus({
      manager: MANAGER_ID,
      status: "stopped",
      reason: "stale_record_removed",
      pid: record.pid,
    });
  }
  if (!isExpectedHermesProcess({ record, snapshot, config })) {
    return sanitizeHermesApiStatus({
      manager: MANAGER_ID,
      status: "refused",
      reason: "process_identity_mismatch",
      pid: record.pid,
    });
  }

  dependencies.signalProcess(record.pid, "SIGTERM");
  const deadline = dependencies.now() + config.stopTimeoutMs;
  while (dependencies.now() < deadline) {
    await dependencies.sleep(config.pollIntervalMs);
    snapshot = dependencies.inspectProcess(record.pid);
    if (!snapshot) {
      unlinkIfExists(config.pidPath);
      return sanitizeHermesApiStatus({
        manager: MANAGER_ID,
        status: "stopped",
        reason: "terminated",
        pid: record.pid,
      });
    }
    if (!isExpectedHermesProcess({ record, snapshot, config })) {
      unlinkIfExists(config.pidPath);
      return sanitizeHermesApiStatus({
        manager: MANAGER_ID,
        status: "stopped",
        reason: "original_process_exited_pid_reused",
        pid: record.pid,
      });
    }
  }

  snapshot = dependencies.inspectProcess(record.pid);
  if (snapshot && isExpectedHermesProcess({ record, snapshot, config })) {
    dependencies.signalProcess(record.pid, "SIGKILL");
  }

  const remaining = dependencies.inspectProcess(record.pid);
  if (!remaining || !isExpectedHermesProcess({ record, snapshot: remaining, config })) {
    unlinkIfExists(config.pidPath);
    return sanitizeHermesApiStatus({
      manager: MANAGER_ID,
      status: "stopped",
      reason: "force_terminated",
      pid: record.pid,
    });
  }

  return sanitizeHermesApiStatus({
    manager: MANAGER_ID,
    status: "failed",
    reason: "process_did_not_exit",
    pid: record.pid,
  });
}

async function waitForProcessSnapshot({ pid, config, dependencies }) {
  const deadline = dependencies.now() + Math.min(config.startTimeoutMs, 5_000);
  let lastSnapshot = null;

  while (dependencies.now() < deadline) {
    lastSnapshot = dependencies.inspectProcess(pid);
    if (lastSnapshot) {
      const provisionalRecord = {
        managerId: MANAGER_ID,
        pid,
        processStartedAt: lastSnapshot.startedAt,
      };
      if (isExpectedHermesProcess({
        record: provisionalRecord,
        snapshot: lastSnapshot,
        config,
      })) {
        return lastSnapshot;
      }
      throw new Error("Spawned process identity does not match the expected Hermes API command.");
    }
    await dependencies.sleep(config.pollIntervalMs);
  }

  throw new Error(`Hermes API process ${pid} exited before its identity could be verified.`);
}

async function waitForHealth({ config, apiKey, dependencies }) {
  const deadline = dependencies.now() + config.startTimeoutMs;
  let lastHealth = { ok: false, error: "not_checked" };

  while (dependencies.now() < deadline) {
    lastHealth = await probeHealth({
      url: config.readinessUrl,
      apiKey,
      fetchImpl: dependencies.fetch,
    });
    if (lastHealth.ok) return lastHealth;
    await dependencies.sleep(config.pollIntervalMs);
  }

  throw new Error(lastHealth.error || `timed out after ${config.startTimeoutMs}ms`);
}

export async function probeHealth({ url, apiKey, fetchImpl = globalThis.fetch }) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return { ok: false, httpStatus: response.status, error: `HTTP ${response.status}` };
    }
    const body = await response.json();
    if (body?.object !== "list" || !Array.isArray(body.data)) {
      return { ok: false, httpStatus: response.status, error: "unexpected models response" };
    }
    return {
      ok: true,
      httpStatus: response.status,
      endpoint: "models",
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function buildStatus({
  config,
  record,
  snapshot,
  health,
  status,
  reason,
}) {
  const resolvedStatus = status || (health?.ok ? "running" : "degraded");
  return {
    manager: MANAGER_ID,
    status: resolvedStatus,
    reason,
    pid: record?.pid,
    startedAt: record?.startedAt,
    processVerified: Boolean(
      snapshot && record && isExpectedHermesProcess({ record, snapshot, config }),
    ),
    health: health
      ? {
          ok: Boolean(health.ok),
          httpStatus: health.httpStatus,
          endpoint: health.endpoint,
          error: health.error,
        }
      : undefined,
    host: config.host,
    port: config.port,
    readinessUrl: config.readinessUrl,
    pidPath: config.pidPath,
    logPath: config.logPath,
  };
}

function ensureApiKey(keyPath, randomBytesImpl) {
  if (existsSync(keyPath)) {
    const metadata = lstatSync(keyPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Hermes API key path must be a regular file: ${keyPath}`);
    }
    chmodSync(keyPath, 0o600);
    return readApiKey(keyPath);
  }

  const apiKey = createApiKey(randomBytesImpl);
  writeFileSync(keyPath, `${apiKey}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(keyPath, 0o600);
  return apiKey;
}

function readApiKey(keyPath) {
  if (!existsSync(keyPath)) {
    throw new Error(`Hermes API key file is missing: ${keyPath}`);
  }
  const apiKey = readFileSync(keyPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/i.test(apiKey)) {
    throw new Error(`Hermes API key file is invalid: ${keyPath}`);
  }
  return apiKey;
}

function ensureRuntimeDirectory(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
}

function secureFile(path) {
  if (existsSync(path)) chmodSync(path, 0o600);
}

function updateHermesEnvironment(envPath, values) {
  mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
  if (existsSync(envPath)) {
    const metadata = lstatSync(envPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Hermes environment path must be a regular file: ${envPath}`);
    }
  }

  const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const pending = new Map(Object.entries(values));
  const output = [];
  for (const line of original.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !pending.has(match[1])) {
      output.push(line);
      continue;
    }
    if (pending.get(match[1]) !== null) {
      output.push(`${match[1]}=${pending.get(match[1])}`);
      pending.set(match[1], null);
    }
  }
  for (const [key, value] of pending) {
    if (value !== null) output.push(`${key}=${value}`);
  }
  const next = `${output.join("\n").replace(/\n*$/, "")}\n`;
  if (next === original) {
    chmodSync(envPath, 0o600);
    return false;
  }
  writeAtomicFile(envPath, next, 0o600);
  return true;
}

function assertHermesInstallation(config) {
  if (!existsSync(config.hermesRoot)) {
    throw new Error(`Hermes agent root does not exist: ${config.hermesRoot}`);
  }
  if (!existsSync(config.pythonPath)) {
    throw new Error(`Hermes Python does not exist: ${config.pythonPath}`);
  }
}

function readPidRecord(pidPath) {
  if (!existsSync(pidPath)) return null;
  try {
    const record = JSON.parse(readFileSync(pidPath, "utf8"));
    if (
      record?.managerId !== MANAGER_ID
      || !Number.isInteger(record.pid)
      || record.pid <= 0
      || typeof record.processStartedAt !== "string"
    ) {
      throw new Error("invalid process record");
    }
    return record;
  } catch (error) {
    throw new Error(`Cannot read Hermes API process record ${pidPath}: ${error.message}`);
  }
}

function writeJsonAtomic(path, value, mode) {
  writeAtomicFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function writeAtomicFile(path, contents, mode) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
    chmodSync(path, mode);
  } finally {
    unlinkIfExists(temporaryPath);
  }
}

function restartInstalledGateway({ config, env }) {
  execFileSync(config.pythonPath, ["-m", "hermes_cli.main", "gateway", "restart"], {
    cwd: config.hermesRoot,
    env: {
      ...env,
      HERMES_HOME: config.hermesHome,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function unlinkIfExists(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function inspectProcessSnapshot(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    if (error?.code === "ESRCH") return null;
    if (error?.code !== "EPERM") throw error;
  }

  try {
    const startedAt = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
    if (!startedAt || !command) return null;
    return { pid: Number(pid), startedAt, command };
  } catch {
    return null;
  }
}

function signalDetachedProcess(pid, signal) {
  try {
    process.kill(-Number(pid), signal);
  } catch (groupError) {
    if (groupError?.code === "ESRCH") return;
    process.kill(Number(pid), signal);
  }
}

function buildReadinessUrl(host, port) {
  const probeHost = ["0.0.0.0", "::", "[::]"].includes(host) ? "127.0.0.1" : host;
  const formattedHost = probeHost.includes(":") && !probeHost.startsWith("[")
    ? `[${probeHost}]`
    : probeHost;
  return `http://${formattedHost}:${port}/v1/models`;
}

function normalizeCommand(command) {
  return String(command || "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseInteger(value, fallback, name, { minimum, maximum = Number.MAX_SAFE_INTEGER }) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
