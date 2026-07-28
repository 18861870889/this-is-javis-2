import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiKey,
  createHermesApiManager,
  isExpectedHermesProcess,
  probeHealth,
  resolveHermesApiConfig,
  sanitizeHermesApiStatus,
} from "./hermesApiManager.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Hermes API manager", () => {
  it("uses the container-reachable host and native Hermes API defaults", () => {
    const config = resolveHermesApiConfig({
      repoRoot: "/tmp/jarvis",
      env: {},
    });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8642,
      hermesRoot: expect.stringMatching(/\.hermes\/hermes-agent$/),
      pythonPath: expect.stringMatching(/\.hermes\/hermes-agent\/venv\/bin\/python$/),
      processArgs: ["-m", "hermes_cli.main", "gateway", "run", "--replace"],
      readinessUrl: "http://127.0.0.1:8642/v1/models",
    });
  });

  it("generates exactly 32 random bytes as a hex API key", () => {
    const key = createApiKey((size) => {
      expect(size).toBe(32);
      return Buffer.alloc(size, 0xab);
    });

    expect(key).toBe("ab".repeat(32));
  });

  it("prepares a protected key without starting or replacing Hermes", async () => {
    const fixture = await createFixture();
    const spawn = vi.fn();
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: { JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot },
      dependencies: {
        randomBytes: () => Buffer.alloc(32, 0xaa),
        spawn,
      },
    });

    expect(manager.prepare()).toMatchObject({
      status: "prepared",
      host: "127.0.0.1",
      port: 8642,
    });
    expect(manager.config.keyPath).toBe(join(fixture.runtimeDir, "api.key"));
    expect(readFileSync(join(fixture.runtimeDir, "api.key"), "utf8").trim()).toBe("aa".repeat(32));
    expect(statSync(join(fixture.runtimeDir, "api.key")).mode & 0o777).toBe(0o600);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("configures and restarts the installed Hermes gateway without spawning a second gateway", async () => {
    const fixture = await createFixture();
    const restartGateway = vi.fn();
    let healthy = false;
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: {
        HERMES_HOME: fixture.hermesHome,
        JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot,
      },
      dependencies: {
        randomBytes: () => Buffer.alloc(32, 0xbc),
        spawn: vi.fn(),
        restartGateway: (input) => {
          restartGateway(input);
          healthy = true;
        },
        fetch: async () => healthy
          ? modelsResponse()
          : new Response("", { status: 503 }),
        sleep: async () => {},
      },
    });

    await expect(manager.ensureService()).resolves.toMatchObject({
      status: "running",
      lifecycle: "installed_gateway_service",
      configurationUpdated: true,
    });
    const configured = readFileSync(join(fixture.hermesHome, ".env"), "utf8");
    expect(configured).toContain("API_SERVER_ENABLED=true");
    expect(configured).toContain("API_SERVER_HOST=127.0.0.1");
    expect(configured).toContain("API_SERVER_PORT=8642");
    expect(configured).toContain(`API_SERVER_KEY=${"bc".repeat(32)}`);
    expect(statSync(join(fixture.hermesHome, ".env")).mode & 0o777).toBe(0o600);
    const hermesConfig = readFileSync(join(fixture.hermesHome, "config.yaml"), "utf8");
    expect(hermesConfig).toContain("api_server:");
    expect(hermesConfig).toContain("jarvis_pc_workspace");
    expect(hermesConfig).not.toContain("hermes-api-server");
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("disables only the installed API service and removes its credential", async () => {
    const fixture = await createFixture();
    mkdirSync(fixture.hermesHome, { recursive: true });
    writeFileSync(
      join(fixture.hermesHome, ".env"),
      [
        "PRESERVE_ME=yes",
        "API_SERVER_ENABLED=true",
        "API_SERVER_HOST=127.0.0.1",
        "API_SERVER_PORT=8642",
        `API_SERVER_KEY=${"ab".repeat(32)}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const restartGateway = vi.fn();
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: {
        HERMES_HOME: fixture.hermesHome,
        JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot,
      },
      dependencies: { restartGateway },
    });

    await expect(manager.disableService()).resolves.toMatchObject({
      status: "stopped",
      lifecycle: "installed_gateway_service",
      reason: "service_disabled",
    });
    const configured = readFileSync(join(fixture.hermesHome, ".env"), "utf8");
    expect(configured).toContain("PRESERVE_ME=yes");
    expect(configured).toContain("API_SERVER_ENABLED=false");
    expect(configured).not.toContain("API_SERVER_KEY=");
    expect(restartGateway).toHaveBeenCalledTimes(1);

    await expect(manager.disableService()).resolves.toMatchObject({
      status: "stopped",
      reason: "already_disabled",
    });
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("starts the native gateway detached and persists only safe runtime metadata", async () => {
    const fixture = await createFixture();
    const spawn = vi.fn(() => ({ pid: 4312, unref: vi.fn() }));
    const fetch = vi.fn(async (url, request) => {
      expect(url).toBe("http://127.0.0.1:8642/v1/models");
      expect(request.headers.Authorization).toBe(`Bearer ${"cd".repeat(32)}`);
      return modelsResponse();
    });
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: {
        JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot,
        HERMES_TEST_PROVIDER_SETTING: "preserved",
      },
      dependencies: {
        randomBytes: () => Buffer.alloc(32, 0xcd),
        spawn,
        fetch,
        inspectProcess: () => expectedSnapshot(4312, fixture.pythonPath),
      },
    });

    const status = await manager.ensure();
    const keyPath = join(fixture.runtimeDir, "api.key");
    const pidPath = join(fixture.runtimeDir, "process.json");
    const key = readFileSync(keyPath, "utf8").trim();
    const pidRecord = readFileSync(pidPath, "utf8");

    expect(status).toMatchObject({
      status: "running",
      pid: 4312,
      processVerified: true,
      health: { ok: true, endpoint: "models" },
    });
    expect(spawn).toHaveBeenCalledWith(
      fixture.pythonPath,
      ["-m", "hermes_cli.main", "gateway", "run", "--replace"],
      expect.objectContaining({
        cwd: fixture.hermesRoot,
        detached: true,
        env: expect.objectContaining({
          API_SERVER_ENABLED: "true",
          API_SERVER_HOST: "127.0.0.1",
          API_SERVER_PORT: "8642",
          API_SERVER_KEY: key,
          HERMES_TEST_PROVIDER_SETTING: "preserved",
        }),
      }),
    );
    expect(key).toBe("cd".repeat(32));
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(pidPath).mode & 0o777).toBe(0o600);
    expect(pidRecord).not.toContain(key);
    expect(JSON.stringify(status)).not.toContain(key);
  });

  it("is idempotent when its recorded gateway is already healthy", async () => {
    const fixture = await createFixture();
    const snapshot = expectedSnapshot(992, fixture.pythonPath);
    writeRuntimeFiles(fixture, {
      pid: 992,
      processStartedAt: snapshot.startedAt,
      apiKey: "ef".repeat(32),
    });
    const spawn = vi.fn();
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: { JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot },
      dependencies: {
        spawn,
        inspectProcess: () => snapshot,
        fetch: async () => modelsResponse(),
      },
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      status: "running",
      pid: 992,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a healthy installed gateway even when Jarvis does not own its PID", async () => {
    const fixture = await createFixture();
    mkdirSync(fixture.runtimeDir, { recursive: true });
    writeFileSync(join(fixture.runtimeDir, "api.key"), `${"de".repeat(32)}\n`, { mode: 0o600 });
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: { JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot },
      dependencies: {
        fetch: async () => modelsResponse(),
      },
    });

    await expect(manager.status()).resolves.toMatchObject({
      status: "running",
      lifecycle: "installed_gateway_service",
      processVerified: false,
      health: { ok: true },
    });
  });

  it("reports an asynchronous spawn failure without writing a PID record", async () => {
    const fixture = await createFixture();
    const child = new EventEmitter();
    child.pid = 444;
    child.unref = vi.fn();
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: { JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot },
      dependencies: {
        randomBytes: () => Buffer.alloc(32, 0x78),
        spawn: () => {
          queueMicrotask(() => child.emit("error", new Error("permission denied")));
          return child;
        },
      },
    });

    await expect(manager.ensure()).rejects.toThrow("permission denied");
    expect(existsSync(join(fixture.runtimeDir, "process.json"))).toBe(false);
  });

  it("stops only a process whose command and start fingerprint match", async () => {
    const fixture = await createFixture();
    const snapshot = expectedSnapshot(812, fixture.pythonPath);
    writeRuntimeFiles(fixture, {
      pid: 812,
      processStartedAt: snapshot.startedAt,
      apiKey: "12".repeat(32),
    });
    let running = true;
    const signalProcess = vi.fn(() => {
      running = false;
    });
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: { JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot },
      dependencies: {
        inspectProcess: () => (running ? snapshot : null),
        signalProcess,
        sleep: async () => {},
        fetch: async () => new Response("", { status: 503 }),
      },
    });

    await expect(manager.stop()).resolves.toMatchObject({
      status: "stopped",
      reason: "terminated",
      pid: 812,
    });
    expect(signalProcess).toHaveBeenCalledTimes(1);
    expect(signalProcess).toHaveBeenCalledWith(812, "SIGTERM");
    await expect(manager.status()).resolves.toMatchObject({ status: "stopped" });
  });

  it("refuses to signal a reused or unrelated PID", async () => {
    const fixture = await createFixture();
    writeRuntimeFiles(fixture, {
      pid: 713,
      processStartedAt: "Mon Jul 27 10:00:00 2026",
      apiKey: "34".repeat(32),
    });
    const signalProcess = vi.fn();
    const manager = createHermesApiManager({
      repoRoot: fixture.repoRoot,
      runtimeDir: fixture.runtimeDir,
      env: { JARVIS_HERMES_AGENT_ROOT: fixture.hermesRoot },
      dependencies: {
        inspectProcess: () => ({
          pid: 713,
          startedAt: "Mon Jul 27 11:00:00 2026",
          command: "/usr/bin/python unrelated.py",
        }),
        signalProcess,
      },
    });

    await expect(manager.stop()).resolves.toMatchObject({
      status: "refused",
      reason: "process_identity_mismatch",
      pid: 713,
    });
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("never exposes secret-shaped properties in status output", () => {
    const sanitized = sanitizeHermesApiStatus({
      status: "running",
      apiKey: "secret-value",
      nested: {
        authorization: "Bearer secret-value",
        token: "secret-value",
        safe: "visible",
      },
    });

    expect(sanitized).toEqual({
      status: "running",
      nested: { safe: "visible" },
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-value");
  });

  it("sends the Bearer credential while probing health", async () => {
    const fetch = vi.fn(async () => modelsResponse());

    await expect(probeHealth({
      url: "http://127.0.0.1:8642/v1/models",
      apiKey: "56".repeat(32),
      fetchImpl: fetch,
    })).resolves.toEqual({
      ok: true,
      httpStatus: 200,
      endpoint: "models",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${"56".repeat(32)}`,
        }),
      }),
    );
  });

  it("does not report ready when the bearer credential is rejected", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 401 }));

    await expect(probeHealth({
      url: "http://127.0.0.1:8642/v1/models",
      apiKey: "wrong-key",
      fetchImpl: fetch,
    })).resolves.toEqual({
      ok: false,
      httpStatus: 401,
      error: "HTTP 401",
    });
  });

  it("rejects a public health-shaped response from the protected probe", async () => {
    await expect(probeHealth({
      url: "http://127.0.0.1:8642/v1/models",
      apiKey: "56".repeat(32),
      fetchImpl: async () => jsonResponse({ status: "ok", platform: "hermes-agent" }),
    })).resolves.toEqual({
      ok: false,
      httpStatus: 200,
      error: "unexpected models response",
    });
  });

  it("requires both the command and process start fingerprint for ownership", () => {
    const config = {
      pythonPath: "/opt/hermes/venv/bin/python",
    };
    const record = {
      managerId: "jarvis-hermes-api",
      pid: 25,
      processStartedAt: "start-a",
    };

    expect(isExpectedHermesProcess({
      config,
      record,
      snapshot: {
        pid: 25,
        startedAt: "start-a",
        command: "/opt/hermes/venv/bin/python -m hermes_cli.main gateway run --replace",
      },
    })).toBe(true);
    expect(isExpectedHermesProcess({
      config,
      record,
      snapshot: {
        pid: 25,
        startedAt: "start-b",
        command: "/opt/hermes/venv/bin/python -m hermes_cli.main gateway run --replace",
      },
    })).toBe(false);
  });
});

async function createFixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), "jarvis-hermes-api-"));
  temporaryDirectories.push(repoRoot);
  const hermesHome = join(repoRoot, ".hermes");
  const hermesRoot = join(repoRoot, "hermes-agent");
  const pythonPath = join(hermesRoot, "venv/bin/python");
  const runtimeDir = join(repoRoot, "data/jarvis-hermes-api.local");
  mkdirSync(join(hermesRoot, "venv/bin"), { recursive: true });
  mkdirSync(
    join(repoRoot, "node_modules/@modelcontextprotocol/server-filesystem/dist"),
    { recursive: true },
  );
  writeFileSync(pythonPath, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(
    join(repoRoot, "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"),
    "#!/usr/bin/env node\n",
    { mode: 0o700 },
  );
  return { repoRoot, hermesHome, hermesRoot, pythonPath, runtimeDir };
}

function expectedSnapshot(pid, pythonPath) {
  return {
    pid,
    startedAt: "Mon Jul 27 10:00:00 2026",
    command: `${pythonPath} -m hermes_cli.main gateway run --replace`,
  };
}

function writeRuntimeFiles(fixture, { pid, processStartedAt, apiKey }) {
  mkdirSync(fixture.runtimeDir, { recursive: true });
  const processRecord = {
    version: 1,
    managerId: "jarvis-hermes-api",
    pid,
    processStartedAt,
    startedAt: "2026-07-27T02:00:00.000Z",
    hermesRoot: fixture.hermesRoot,
    pythonPath: fixture.pythonPath,
    host: "127.0.0.1",
    port: 8642,
  };
  writeFileSync(join(fixture.runtimeDir, "api.key"), `${apiKey}\n`, { mode: 0o600 });
  chmodSync(join(fixture.runtimeDir, "api.key"), 0o600);
  writeFileSync(
    join(fixture.runtimeDir, "process.json"),
    `${JSON.stringify(processRecord, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function modelsResponse() {
  return jsonResponse({
    object: "list",
    data: [{ id: "hermes-agent", object: "model" }],
  });
}
