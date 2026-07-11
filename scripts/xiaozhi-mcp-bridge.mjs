const endpoint = requiredEnv("XIAOZHI_MCP_ENDPOINT");
const jarvisMcpUrl = process.env.JARVIS_MCP_URL || "http://127.0.0.1:5183/mcp";
const reconnectMs = positiveInteger(process.env.XIAOZHI_BRIDGE_RECONNECT_MS, 5000);

let attempt = 0;

process.on("SIGINT", () => {
  console.log("Xiaozhi MCP bridge stopping.");
  process.exit(130);
});
process.on("SIGTERM", () => {
  console.log("Xiaozhi MCP bridge stopping.");
  process.exit(143);
});

while (true) {
  attempt += 1;
  try {
    await connectOnce();
    attempt = 0;
  } catch (error) {
    console.error(`Xiaozhi MCP bridge error: ${error.message}`);
  }
  console.log(`Reconnecting to Xiaozhi MCP in ${reconnectMs}ms.`);
  await sleep(reconnectMs);
}

async function connectOnce() {
  console.log(`Connecting Xiaozhi MCP bridge to ${redactEndpoint(endpoint)} -> ${jarvisMcpUrl}`);
  const socket = new WebSocket(endpoint);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket connect timeout")), 30000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      console.log("Xiaozhi MCP websocket connected.");
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("websocket connection failed"));
    }, { once: true });
  });

  await new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      handleMessage(socket, event.data).catch((error) => {
        console.error(`Xiaozhi MCP message handling failed: ${error.message}`);
      });
    });
    socket.addEventListener("close", (event) => {
      console.log(`Xiaozhi MCP websocket closed code=${event.code} reason=${event.reason || ""}`);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      console.error("Xiaozhi MCP websocket error.");
    });
  });
}

async function handleMessage(socket, data) {
  const text = typeof data === "string" ? data : await data.text?.();
  if (!text) return;

  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    console.error(`Ignoring non-JSON Xiaozhi MCP message: ${error.message}`);
    return;
  }

  console.log(`Xiaozhi -> Jarvis ${summarizeJsonRpc(message)}`);
  const response = await fetch(jarvisMcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  const responseText = await response.text();
  if (response.status === 204 || !responseText.trim()) {
    console.log(`Jarvis -> Xiaozhi ${response.status} no-content`);
    return;
  }
  if (!response.ok) {
    console.error(`Jarvis MCP returned ${response.status}: ${responseText.slice(0, 300)}`);
  }
  socket.send(responseText);
  console.log(`Jarvis -> Xiaozhi ${summarizeJsonRpc(JSON.parse(responseText))}`);
}

function summarizeJsonRpc(payload) {
  if (Array.isArray(payload)) return `batch(${payload.length})`;
  if (!payload || typeof payload !== "object") return typeof payload;
  const method = payload.method ? `method=${payload.method}` : "";
  const id = payload.id !== undefined ? `id=${payload.id}` : "";
  const error = payload.error ? `error=${payload.error.code || "unknown"}` : "";
  const result = payload.result ? "result" : "";
  const tool = payload.params?.name ? `tool=${payload.params.name}` : "";
  return [id, method, tool, result, error].filter(Boolean).join(" ") || "json-rpc";
}

function redactEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has("token")) url.searchParams.set("token", "REDACTED");
    return url.toString();
  } catch {
    return "REDACTED_ENDPOINT";
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
