import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

const REPO_ROOT = process.cwd();
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const cleanupTasks = [];

afterEach(async () => {
  while (cleanupTasks.length) {
    const cleanup = cleanupTasks.pop();
    await cleanup();
  }
});

describe("Jarvis server voice routes", () => {
  it("handles a StackChan fast-path utterance without OPENAI_API_KEY and dedupes repeated wake sessions", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant();
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const first = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      trigger: "wake_word",
      wakeSessionId: "wake-shared-1",
      text: "打开书房射灯",
      dryRun: true,
    });
    const duplicate = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-living",
      roomId: "living",
      trigger: "wake_word",
      wakeSessionId: "wake-shared-1",
      text: "打开书房射灯。",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const stageNames = auditEntries[0].stages.map((stage) => stage.name);

    expect(first).toMatchObject({
      route: "hcm_fast_path",
      routeReason: "simple_power_command",
      duplicate: false,
      handledByDeviceId: "stackchan-study",
      speak: true,
    });
    expect(["dry_run", "executed", "needs_confirmation", "needs_clarification", "rejected", "no_action"]).toContain(first.status);
    expect(stageNames).toContain("planner_external");
    expect(stageNames).not.toContain("llm_planner");
    expect(duplicate).toMatchObject({
      route: "duplicate_ignored",
      duplicate: true,
      handledByDeviceId: "stackchan-study",
      speak: false,
    });
    expect(readJsonl(harness.paths.commandAuditPath)).toHaveLength(1);
  }, 30000);

  it("answers state questions through the HCM read-only path when Home Assistant is configured", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant();
    const hermes = await startMockHermes("Hermes should not answer this.");
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url, hermesBaseUrl: hermes.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "wake-state-hcm-1",
      text: "书房射灯开着吗",
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      routeReason: "read_only_home_state_query",
      status: "answered",
      speak: true,
    });
    expect(result.replyText).toContain("书房射灯");
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].plan).toMatchObject({
      kind: "hcm_state_query",
      intentType: "state_query",
    });
    expect(auditEntries[0].plan.actions ?? []).toEqual([]);
    expect(auditEntries[0].execution).toMatchObject({ status: "answered" });
    expect(auditEntries[0].execution.accepted ?? []).toEqual([]);
    expect(ha.serviceCalls).toHaveLength(0);
    expect(hermes.calls).toHaveLength(0);
  }, 30000);

  it("falls back to Hermes for state questions when Home Assistant is not configured", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("书房射灯现在是开的。");
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "wake-state-1",
      text: "书房射灯开着吗",
    });

    expect(result).toMatchObject({
      route: "hermes_slow_path",
      routeReason: "home_state_or_inventory_query",
      status: "answered",
      commandId: null,
      replyText: "书房射灯现在是开的。",
      speak: true,
    });
    expect(hermes.calls).toHaveLength(1);
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("returns a speakable timeout fallback when Hermes is too slow", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("迟到的回答", { delayMs: 200 });
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url, hermesTimeoutMs: 50 });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      wakeSessionId: "wake-timeout-1",
      text: "帮我总结今天要做什么",
    });

    expect(result).toMatchObject({
      route: "hermes_slow_path",
      status: "brain_timeout",
      speak: true,
      replyText: expect.stringContaining("响应超时"),
    });
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("applies spoken learning feedback from the voice utterance endpoint", async () => {
    const tempDir = createTempDir();
    const paths = harnessPaths(tempDir);
    seedLearningFeedbackFiles(paths);
    const harness = await startHarness({ tempDir });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      wakeSessionId: "wake-feedback-1",
      text: "可以",
    });
    const memory = JSON.parse(readFileSync(paths.learningMemoryPath, "utf8"));

    expect(result).toMatchObject({
      route: "learning_feedback",
      status: "feedback_applied",
      feedback: {
        appliedTo: "semantic",
        feedback: "accept",
      },
    });
    expect(memory.candidates[0]).toMatchObject({
      id: "candidate_study_light",
      status: "accepted",
      application: {
        mode: "semantic",
        sourceCommandId: "cmd-study-light",
      },
    });
  }, 30000);

  it("binds bare spoken feedback to the pending Jarvis prompt", async () => {
    const tempDir = createTempDir();
    const paths = harnessPaths(tempDir);
    seedPendingPromptLearningFiles(paths);
    const ha = await startMockHomeAssistant();
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const command = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "wake-prompt-1",
      text: "打开书房射灯",
      dryRun: true,
    });
    const feedback = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      wakeSessionId: "wake-prompt-2",
      text: "可以",
    });
    const memory = JSON.parse(readFileSync(paths.learningMemoryPath, "utf8"));
    const promptQueue = JSON.parse(readFileSync(paths.pendingPromptQueuePath, "utf8"));

    expect(command.learnedSuggestion).toMatchObject({
      candidateId: "candidate_打开书房射灯",
      pendingPromptId: expect.stringMatching(/^pending_/),
    });
    expect(feedback).toMatchObject({
      route: "learning_feedback",
      status: "feedback_applied",
      feedback: {
        appliedTo: "semantic",
        pendingPromptId: command.learnedSuggestion.pendingPromptId,
      },
    });
    expect(memory.candidates[0]).toMatchObject({
      id: "candidate_打开书房射灯",
      status: "accepted",
    });
    expect(promptQueue.prompts[0]).toMatchObject({
      id: command.learnedSuggestion.pendingPromptId,
      status: "accepted",
      feedback: "accept",
      deviceId: "stackchan-study",
      roomId: "study",
    });
  }, 30000);

  it("applies room priority for StackChan commands", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      stackchanDeviceRooms: { "stackchan-second": "second" },
    });

    const ambiguous = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-hall",
      wakeSessionId: "wake-bedroom-ambiguous",
      text: "卧室灯关一下",
      dryRun: true,
    });
    const livingBedroom = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-living",
      roomId: "living",
      wakeSessionId: "wake-bedroom-living",
      text: "卧室灯关一下",
      dryRun: true,
    });
    const scoped = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      wakeSessionId: "wake-bedroom-second",
      text: "灯关一下",
      dryRun: true,
    });
    const explicit = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "wake-bedroom-explicit",
      text: "关主卧灯",
      dryRun: true,
    });

    expect(ambiguous).toMatchObject({
      route: "hcm_fast_path",
      status: "needs_clarification",
      speak: true,
    });
    expect(livingBedroom).toMatchObject({
      route: "hcm_fast_path",
      status: "needs_clarification",
      speak: true,
    });
    expect(scoped).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
      speak: true,
    });
    expect(explicit).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
      speak: true,
    });
    expect(explicit.roomId).toBe("second");

    const explicitAudit = readJsonl(harness.paths.commandAuditPath).find((entry) => entry.input === "关主卧灯");
    expect(explicitAudit?.plan?.actionCount).toBe(1);
    expect(JSON.stringify(explicitAudit?.execution?.services ?? [])).toContain("master");
    expect(JSON.stringify(explicitAudit?.execution?.services ?? [])).not.toContain("second");
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("routes low-risk non-light devices through HCM policy", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createFanGraph());
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-living",
      roomId: "living",
      wakeSessionId: "wake-fan-1",
      text: "打开客厅风扇",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
      speak: true,
    });
    expect(auditEntries[0].plan.actionCount).toBe(1);
    expect(JSON.stringify(auditEntries[0].execution.services)).toContain("fan");
    expect(auditEntries[0].stages.map((stage) => stage.name)).toContain("policy_gate");
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);
});

async function startHarness({ tempDir, haBaseUrl = "", hermesBaseUrl = "", hermesTimeoutMs = 3500, stackchanDeviceRooms = null }) {
  const port = await getFreePort();
  const paths = harnessPaths(tempDir);
  const output = [];
  const child = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      OPENAI_API_KEY: "",
      HA_BASE_URL: haBaseUrl,
      HA_TOKEN: haBaseUrl ? "test-token" : "",
      HOME_ASSISTANT_URL: "",
      HOME_ASSISTANT_TOKEN: "",
      HERMES_API_BASE_URL: hermesBaseUrl,
      HERMES_API_URL: "",
      HERMES_API_KEY: "",
      HERMES_API_TIMEOUT_MS: String(hermesTimeoutMs),
      HARNESS_EXECUTION_MODE: "dry_run",
      HARNESS_HCM_OVERLAY_PATH: paths.hcmOverlayPath,
      HARNESS_COMMAND_AUDIT_PATH: paths.commandAuditPath,
      HARNESS_LEARNING_MEMORY_PATH: paths.learningMemoryPath,
      HARNESS_PROVIDER_SNAPSHOT_PATH: paths.providerSnapshotPath,
      HARNESS_AUTOMATION_MEMORY_PATH: paths.automationMemoryPath,
      HARNESS_SPATIAL_EDITOR_PATH: paths.spatialEditorPath,
      JARVIS_PENDING_PROMPT_QUEUE_PATH: paths.pendingPromptQueuePath,
      JARVIS_UTTERANCE_DEDUPE_WINDOW_MS: "3000",
      JARVIS_STACKCHAN_DEVICE_ROOMS: stackchanDeviceRooms ? JSON.stringify(stackchanDeviceRooms) : "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  cleanupTasks.push(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  });
  await waitForHttp(`http://127.0.0.1:${port}/api/runtime/status`, () => output.join(""));
  return { url: `http://127.0.0.1:${port}`, paths, output };
}

async function startMockHomeAssistant(graph = createStudyLightGraph()) {
  const serviceCalls = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/states") {
      sendJson(response, graph.states);
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/api/services/")) {
      const body = await readBody(request);
      serviceCalls.push({ url: request.url, body: body ? JSON.parse(body) : null });
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
  cleanupTasks.push(() => closeServer(server, sockets));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, serviceCalls };
}

async function startMockHermes(replyText, { delayMs = 0, statusCode = 200 } = {}) {
  const calls = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      calls.push(JSON.parse(await readBody(request)));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (statusCode !== 200) {
        response.statusCode = statusCode;
        response.end("hermes failed");
        return;
      }
      sendJson(response, { choices: [{ message: { content: replyText } }] });
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listen(server);
  cleanupTasks.push(() => closeServer(server, sockets));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, calls };
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

function createBedroomGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [
      { area_id: "master", name: "主卧" },
      { area_id: "second", name: "次卧" },
    ],
    devices: [
      { id: "master-light", name: "主卧主灯", area_id: "master", manufacturer: "Fixture", model: "Light" },
      { id: "second-light", name: "次卧吸顶灯", area_id: "second", manufacturer: "Fixture", model: "Light" },
    ],
    entities: [
      { entity_id: "light.master_light", device_id: "master-light", platform: "xiaomi_home", original_name: "主灯" },
      { entity_id: "light.second_light", device_id: "second-light", platform: "xiaomi_home", original_name: "吸顶灯" },
    ],
    states: [
      { entity_id: "light.master_light", state: "on", attributes: { friendly_name: "主卧主灯", supported_features: 0 } },
      { entity_id: "light.second_light", state: "on", attributes: { friendly_name: "次卧吸顶灯", supported_features: 0 } },
    ],
  };
}

function createFanGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [{ area_id: "living", name: "客厅" }],
    devices: [
      { id: "living-fan", name: "客厅风扇", area_id: "living", manufacturer: "Fixture", model: "Fan" },
    ],
    entities: [
      { entity_id: "fan.living_fan", device_id: "living-fan", platform: "xiaomi_home", original_name: "风扇" },
    ],
    states: [
      { entity_id: "fan.living_fan", state: "off", attributes: { friendly_name: "客厅风扇", supported_features: 0 } },
    ],
  };
}

function seedLearningFeedbackFiles(paths) {
  writeFileSync(paths.commandAuditPath, `${JSON.stringify({
    commandId: "cmd-study-light",
    input: "打开书房射灯",
    status: "dry_run",
    execution: {
      services: [{
        thingId: "ha_study-light",
        thingName: "书房射灯",
        capabilityId: "study_spotlight",
        capabilityName: "射灯",
        service: "light.turn_on",
        value: true,
      }],
    },
    safety: { level: "low", confirmationRequired: false },
  })}\n`);
  writeFileSync(paths.learningMemoryPath, `${JSON.stringify({
    version: "0.1",
    updatedAt: "2026-07-01T00:00:00.000Z",
    mode: "shadow",
    observations: [],
    candidates: [{
      id: "candidate_study_light",
      type: "semantic_mapping",
      status: "shadow",
      input: "打开书房射灯",
      commandKey: "打开书房射灯",
      count: 2,
      confidence: 0.8,
      actions: [],
      examples: ["打开书房射灯"],
      safety: {
        level: "low",
        autoApply: false,
        reason: "学习候选默认仅 shadow，不自动执行",
      },
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    tombstones: [],
  }, null, 2)}\n`);
}

function seedPendingPromptLearningFiles(paths) {
  writeFileSync(paths.learningMemoryPath, `${JSON.stringify({
    version: "0.1",
    updatedAt: "2026-07-01T00:00:00.000Z",
    mode: "shadow",
    observations: [
      learningObservation("seed-cmd-1", "2026-07-01T00:00:00.000Z"),
      learningObservation("seed-cmd-2", "2026-07-01T00:01:00.000Z"),
    ],
    candidates: [{
      id: "candidate_打开书房射灯",
      type: "semantic_mapping",
      status: "shadow",
      input: "打开书房射灯",
      commandKey: "打开书房射灯",
      count: 2,
      confidence: 0.8,
      actions: [],
      examples: ["打开书房射灯"],
      safety: {
        level: "low",
        autoApply: false,
        reason: "学习候选默认仅 shadow，不自动执行",
      },
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    tombstones: [],
  }, null, 2)}\n`);
}

function learningObservation(id, observedAt) {
  return {
    id,
    observedAt,
    input: "打开书房射灯",
    path: "hcm-real",
    status: "dry_run",
    success: true,
    actions: [{
      thingId: "ha_study-light",
      thingName: "书房射灯",
      capabilityId: "study_spotlight",
      capabilityName: "射灯",
      service: "light.turn_on",
    }],
    safety: { level: "low", confirmationRequired: false },
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
  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (length === 127) throw new Error("large websocket frames are not supported in tests");
  const masked = Boolean(buffer[1] & 0x80);
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += masked ? 4 : 0;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  if (opcode === 8) return { text: "{}", remaining: buffer.subarray(offset + length) };
  return { text: payload.toString("utf8"), remaining: buffer.subarray(offset + length) };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return json;
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

function harnessPaths(tempDir) {
  return {
    hcmOverlayPath: join(tempDir, "home-model-overlay.local.json"),
    commandAuditPath: join(tempDir, "command-audit.local.jsonl"),
    learningMemoryPath: join(tempDir, "learning-memory.local.json"),
    providerSnapshotPath: join(tempDir, "provider-snapshot.local.json"),
    automationMemoryPath: join(tempDir, "automation-memory.local.json"),
    spatialEditorPath: join(tempDir, "spatial-editor.local.json"),
    pendingPromptQueuePath: join(tempDir, "pending-prompts.local.json"),
  };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  await Promise.race([
    once(server, "close"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

function createTempDir() {
  const tempDir = mkdtempSync(join(tmpdir(), `jarvis-routes-${randomUUID()}-`));
  cleanupTasks.push(() => rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
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
