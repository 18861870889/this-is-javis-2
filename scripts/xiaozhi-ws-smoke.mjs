import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xiaozhiWsUrl = process.env.XIAOZHI_WS_SMOKE_URL || "ws://127.0.0.1:8000/xiaozhi/v1/";
const deviceId = process.env.XIAOZHI_WS_SMOKE_DEVICE_ID || "02:00:00:00:00:01";
const clientId = process.env.XIAOZHI_WS_SMOKE_CLIENT_ID || "jarvis-ws-smoke";
const timeoutMs = positiveInteger(process.env.XIAOZHI_WS_SMOKE_TIMEOUT_MS, 60_000);
const pcWorkspaceRoot = resolve(repoRoot, process.env.JARVIS_PC_WORKSPACE_ROOT || "data/pc-workspace.local");
const mode = process.argv[2] || "default";

const prompts = mode === "pc"
  ? [pcPrompt()]
  : mode === "home"
    ? [homePrompt()]
    : [homePrompt(), pcPrompt()];

const results = [];
for (const prompt of prompts) {
  results.push(await runPrompt(prompt));
}

console.log(JSON.stringify({
  ok: true,
  url: redactUrl(withDeviceQuery(xiaozhiWsUrl)),
  deviceId,
  prompts: results,
}, null, 2));

function homePrompt() {
  return {
    name: "home_state",
    text: process.env.XIAOZHI_WS_SMOKE_HOME_TEXT || "次卧吸顶灯开着吗",
    expectReply: /次卧|吸顶灯|开着|关着/,
    expectStt: /次卧吸顶灯/,
  };
}

function pcPrompt() {
  const filename = process.env.XIAOZHI_WS_SMOKE_PC_FILENAME || `xiaozhi-ws-smoke-${Date.now()}.md`;
  return {
    name: "pc_markdown",
    text: process.env.XIAOZHI_WS_SMOKE_PC_TEXT || `在电脑工作区新建 ${filename} 并写入 helloworld`,
    filename,
    expectReply: new RegExp(`${escapeRegExp(filename)}|已创建|helloworld`),
    expectStt: /电脑工作区|新建|写入|helloworld/,
  };
}

async function runPrompt(prompt) {
  const ws = new WebSocket(withDeviceQuery(xiaozhiWsUrl));
  const state = {
    welcome: null,
    sttTexts: [],
    ttsTexts: [],
    ttsStates: [],
    binaryFrames: 0,
    binaryBytes: 0,
  };
  const done = deferred();
  const timeout = setTimeout(() => done.reject(new Error(`Timed out waiting for Xiaozhi response to ${prompt.name}`)), timeoutMs);

  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({
      type: "hello",
      version: 1,
      transport: "websocket",
      audio_params: {
        format: "opus",
        sample_rate: 16000,
        channels: 1,
        frame_duration: 60,
      },
      features: {
        mcp: false,
        emoji: false,
      },
    }));
  });

  ws.addEventListener("message", (event) => {
    try {
      if (typeof event.data === "string") {
        handleTextMessage(state, event.data, prompt, ws, done);
        return;
      }
      const bytes = byteLength(event.data);
      state.binaryFrames += 1;
      state.binaryBytes += bytes;
    } catch (error) {
      done.reject(error);
    }
  });

  ws.addEventListener("error", () => {
    done.reject(new Error(`WebSocket error while running ${prompt.name}`));
  });
  ws.addEventListener("close", () => {
    if (!state.ttsStates.includes("stop")) {
      done.reject(new Error(`WebSocket closed before TTS stop for ${prompt.name}`));
    }
  });

  try {
    await done.promise;
  } finally {
    clearTimeout(timeout);
    try {
      ws.close();
    } catch {
      // Closing an already-closed smoke socket is fine.
    }
  }

  validatePromptResult(prompt, state);
  return {
    name: prompt.name,
    text: prompt.text,
    sttTexts: state.sttTexts,
    ttsTexts: state.ttsTexts,
    ttsStates: state.ttsStates,
    binaryFrames: state.binaryFrames,
    binaryBytes: state.binaryBytes,
    fileCreated: prompt.filename ? fileMatches(prompt.filename, "helloworld") : undefined,
  };
}

function handleTextMessage(state, raw, prompt, ws, done) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new Error(`Unexpected non-JSON text message from Xiaozhi: ${raw}`);
  }

  if (message.type === "hello") {
    state.welcome = message;
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: "listen",
        state: "detect",
        text: prompt.text,
      }));
    }, 1500);
    return;
  }

  if (message.type === "stt") {
    state.sttTexts.push(message.text || "");
    return;
  }

  if (message.type === "tts") {
    state.ttsStates.push(message.state);
    if (message.text) state.ttsTexts.push(message.text);
    if (message.state === "stop") done.resolve();
  }
}

function validatePromptResult(prompt, state) {
  if (!state.welcome?.session_id) throw new Error(`No Xiaozhi hello/session received for ${prompt.name}.`);
  if (!state.sttTexts.some((text) => prompt.expectStt.test(text))) {
    throw new Error(`No matching STT echo for ${prompt.name}: ${JSON.stringify(state.sttTexts)}`);
  }
  if (!state.ttsTexts.some((text) => prompt.expectReply.test(text))) {
    throw new Error(`No matching TTS text for ${prompt.name}: ${JSON.stringify(state.ttsTexts)}`);
  }
  if (!state.ttsStates.includes("start") || !state.ttsStates.includes("stop")) {
    throw new Error(`Missing TTS start/stop for ${prompt.name}: ${JSON.stringify(state.ttsStates)}`);
  }
  if (state.binaryBytes <= 0) throw new Error(`No TTS audio bytes received for ${prompt.name}.`);
  if (prompt.filename && !fileMatches(prompt.filename, "helloworld")) {
    throw new Error(`PC markdown file was not created with helloworld: ${prompt.filename}`);
  }
}

function withDeviceQuery(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("device-id", deviceId);
  url.searchParams.set("client-id", clientId);
  return url.toString();
}

function redactUrl(value) {
  const url = new URL(value);
  if (url.searchParams.has("authorization")) url.searchParams.set("authorization", "REDACTED");
  return url.toString();
}

function byteLength(data) {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof Blob) return data.size;
  return Buffer.byteLength(String(data));
}

function fileMatches(filename, expected) {
  const path = resolve(pcWorkspaceRoot, filename);
  return existsSync(path) && readFileSync(path, "utf8").trimEnd() === expected;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}
