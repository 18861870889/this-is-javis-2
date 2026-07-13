#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const imageName = process.env.JARVIS_CONTAINER_IMAGE || "harness-house-jarvis:local";
const containerName = process.env.JARVIS_CONTAINER_NAME || "harness-house-jarvis";
const bindHost = process.env.JARVIS_CONTAINER_BIND_HOST || "127.0.0.1";
const hostPort = parsePort(process.env.JARVIS_CONTAINER_PORT || "5173");
const requestedMode = process.env.JARVIS_CONTAINER_EXECUTION_MODE === "real" ? "real" : "dry_run";
const command = process.argv[2] || "check";

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid container port: ${value}`);
  }
  return port;
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
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${executable} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
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

function commonEnvironment(mode = requestedMode) {
  return [
    "NODE_ENV=production",
    "JARVIS_BIND_HOST=0.0.0.0",
    "PORT=5173",
    `HARNESS_EXECUTION_MODE=${mode}`,
    "HERMES_API_TRANSPORT=api",
    "JARVIS_SUBAGENT_COMMAND=",
    "JARVIS_DELIVERY_WECHAT_ENABLED=false",
  ];
}

function removeAppleContainer(name) {
  const inspected = run("container", ["inspect", name], { capture: true, allowFailure: true });
  if (inspected.status !== 0) return;
  run("container", ["stop", name], { allowFailure: true });
  run("container", ["rm", name], { allowFailure: true });
}

function startApple({ name, port, mode, dataDir, includeEnvFile }) {
  ensureAppleSystem();
  removeAppleContainer(name);
  mkdirSync(dataDir, { recursive: true });

  const hostUid = process.getuid?.() ?? 1000;
  const hostGid = process.getgid?.() ?? 1000;
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
  if (includeEnvFile && existsSync(join(rootDir, ".env"))) {
    args.push("--env-file", join(rootDir, ".env"));
  }
  for (const entry of commonEnvironment(mode)) args.push("--env", entry);
  args.push(
    "--publish", `${bindHost}:${port}:5173`,
    "--volume", `${dataDir}:/app/data`,
    "--tmpfs", "/tmp",
    imageName,
  );
  run("container", args);
}

function startDocker() {
  const env = {
    ...process.env,
    JARVIS_CONTAINER_IMAGE: imageName,
    JARVIS_CONTAINER_NAME: containerName,
    JARVIS_CONTAINER_BIND_HOST: bindHost,
    JARVIS_CONTAINER_PORT: String(hostPort),
    JARVIS_CONTAINER_EXECUTION_MODE: requestedMode,
  };
  run("docker", ["compose", "up", "--detach", "--build"], { env });
}

function start(engine) {
  build(engine);
  if (engine === "apple") {
    startApple({
      name: containerName,
      port: hostPort,
      mode: requestedMode,
      dataDir: join(rootDir, "data"),
      includeEnvFile: true,
    });
  } else {
    startDocker();
  }
  console.log(`Jarvis is starting at http://${displayHost(bindHost)}:${hostPort}`);
  console.log(`Execution mode: ${requestedMode}`);
}

function stop(engine) {
  if (engine === "apple") {
    removeAppleContainer(containerName);
  } else {
    run("docker", ["compose", "down"]);
  }
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

async function waitForHealthy(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/runtime/status`);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.execution?.mode !== "dry_run") {
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
        includeEnvFile: false,
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

    await waitForHealthy(url);
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
      start(engine);
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
    default:
      throw new Error("Usage: node scripts/jarvis-container.mjs check|build|start|stop|status|smoke");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
