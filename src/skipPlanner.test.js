import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

const REPO_ROOT = process.cwd();
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let harness;
let ha;
let planner;

beforeAll(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), `jarvis-skip-planner-${randomUUID()}-`));
  ha = await startMockHomeAssistant();
  planner = await startMockPlanner();
  harness = await startHarness({ tempDir, haBaseUrl: ha.url, plannerBaseUrl: planner.url });
});

afterAll(async () => {
  await harness?.cleanup?.();
  await planner?.cleanup?.();
  await ha?.cleanup?.();
  if (harness?.tempDir) rmSync(harness.tempDir, { recursive: true, force: true });
});

describe("skip_planner integration", () => {
  it("accepts skipPlanner + plannerDraft and skips LLM", async () => {
    const callsBefore = planner.calls.length;
    const result = await sendCommand({
      input: "打开书房射灯",
      dryRun: true,
      skipPlanner: true,
      plannerDraft: {
        intent_type: "device_control",
        intent: "打开书房射灯",
        confidence: 0.9,
        summary: "打开书房射灯",
        needs_confirmation: false,
        actions: [
          { target: "书房射灯", capability: "power", value: true },
        ],
      },
    });

    expect(["dry_run", "executed", "answered", "needs_clarification", "needs_confirmation", "rejected", "no_action"]).toContain(result.status);
    const stages = result.trace?.stages ?? result.stages ?? [];
    const stageNames = stages.map((stage) => stage.name);
    expect(stageNames).toContain("planner_external");
    expect(stageNames).not.toContain("llm_planner");
    expect(planner.calls).toHaveLength(callsBefore);
  }, 15000);

  it("still works without skipPlanner and calls the configured planner", async () => {
    const callsBefore = planner.calls.length;
    const result = await sendCommand({
      input: "打开书房射灯",
      dryRun: true,
    });

    expect(result.status).toBe("dry_run");
    const stages = result.trace?.stages ?? result.stages ?? [];
    const stageNames = stages.map((stage) => stage.name);
    expect(stageNames).toContain("llm_planner");
    expect(stageNames).not.toContain("planner_external");
    expect(planner.calls.length).toBe(callsBefore + 1);
  }, 30000);

  it("rejects invalid skipPlanner type", async () => {
    const response = await fetch(`${harness.url}/api/hcm/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "关灯",
        skipPlanner: "not-a-boolean",
      }),
    });
    expect(response.status).toBe(400);
  });
});

async function sendCommand(payload) {
  const response = await fetch(`${harness.url}/api/hcm/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function startHarness({ tempDir, haBaseUrl, plannerBaseUrl }) {
  const port = await getFreePort();
  const output = [];
  const child = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      JARVIS_BIND_HOST: "127.0.0.1",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: plannerBaseUrl,
      HA_BASE_URL: haBaseUrl,
      HA_TOKEN: "test-token",
      HOME_ASSISTANT_URL: "",
      HOME_ASSISTANT_TOKEN: "",
      HARNESS_EXECUTION_MODE: "dry_run",
      HARNESS_HCM_OVERLAY_PATH: join(tempDir, "home-model-overlay.local.json"),
      HARNESS_COMMAND_AUDIT_PATH: join(tempDir, "command-audit.local.jsonl"),
      HARNESS_LEARNING_MEMORY_PATH: join(tempDir, "learning-memory.local.json"),
      HARNESS_PROVIDER_SNAPSHOT_PATH: join(tempDir, "provider-snapshot.local.json"),
      HARNESS_AUTOMATION_MEMORY_PATH: join(tempDir, "automation-memory.local.json"),
      HARNESS_SPATIAL_EDITOR_PATH: join(tempDir, "spatial-editor.local.json"),
      JARVIS_PENDING_PROMPT_QUEUE_PATH: join(tempDir, "pending-prompts.local.json"),
      JARVIS_DELIVERY_AUDIT_PATH: join(tempDir, "delivery-audit.local.jsonl"),
      JARVIS_PC_WORKSPACE_ROOT: join(tempDir, "pc-workspace"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  await waitForHttp(`http://127.0.0.1:${port}/api/runtime/status`, () => output.join(""));
  return {
    url: `http://127.0.0.1:${port}`,
    tempDir,
    async cleanup() {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (!exited) {
        child.kill("SIGKILL");
        await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
    },
  };
}

async function startMockPlanner() {
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/chat/completions") {
      calls.push(JSON.parse(await readBody(request)));
      sendJson(response, {
        choices: [{
          message: {
            content: JSON.stringify({
              intent_type: "device_control",
              intent: "打开书房射灯",
              confidence: 0.9,
              summary: "打开书房射灯",
              needs_confirmation: false,
              actions: [
                { target: "书房射灯", capability: "power", value: true },
              ],
            }),
          },
        }],
      });
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await listen(server);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    cleanup: () => closeServer(server),
  };
}

async function startMockHomeAssistant() {
  const graph = createStudyLightGraph();
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/states") {
      sendJson(response, graph.states);
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/api/services/")) {
      sendJson(response, [{
        entity_id: "light.study_spotlight",
        state: "on",
        attributes: { friendly_name: "书房射灯", supported_features: 0 },
      }]);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (request.url !== "/api/websocket") {
      socket.destroy();
      return;
    }
    acceptWebSocket(request, socket);
    sendWs(socket, { type: "auth_required" });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frame;
      while ((frame = readWsFrame(buffer))) {
        buffer = frame.remaining;
        const message = JSON.parse(frame.text);
        if (message.type === "auth") {
          sendWs(socket, { type: "auth_ok" });
          continue;
        }
        if (!message.id) continue;
        sendWs(socket, {
          id: message.id,
          type: "result",
          success: true,
          result: registryResult(graph, message.type),
        });
      }
    });
  });
  await listen(server);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    cleanup: () => closeServer(server, sockets),
  };
}

function createStudyLightGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [{ area_id: "study", name: "书房" }],
    devices: [{
      id: "study-light",
      name: "书房射灯",
      area_id: "study",
      manufacturer: "Fixture",
      model: "Light 1",
      identifiers: [["xiaomi_home", "study-light"]],
    }],
    entities: [{
      entity_id: "light.study_spotlight",
      device_id: "study-light",
      platform: "xiaomi_home",
      original_name: "射灯",
    }],
    states: [{
      entity_id: "light.study_spotlight",
      state: "off",
      attributes: { friendly_name: "书房射灯", brightness: 0, supported_features: 0 },
    }],
  };
}

function registryResult(graph, type) {
  if (type === "config/device_registry/list") return graph.devices;
  if (type === "config/entity_registry/list") return graph.entities;
  if (type === "config/area_registry/list") return graph.areas;
  return [];
}

function acceptWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
}

function sendWs(socket, data) {
  const payload = Buffer.from(JSON.stringify(data));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function readWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const lengthByte = buffer[1] & 0x7f;
  const mask = Boolean(buffer[1] & 0x80);
  let offset = 2;
  let length = lengthByte;
  if (lengthByte === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  const maskKey = mask ? buffer.subarray(offset, offset + 4) : null;
  if (mask) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= maskKey[index % 4];
    }
  }
  if (opcode === 8) return { text: "{}", remaining: buffer.subarray(offset + length) };
  return { text: payload.toString("utf8"), remaining: buffer.subarray(offset + length) };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function closeServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  server.close();
  await Promise.race([once(server, "close"), new Promise((resolve) => setTimeout(resolve, 1000))]);
}

async function waitForHttp(url, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}\n${output()}`);
}

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}
