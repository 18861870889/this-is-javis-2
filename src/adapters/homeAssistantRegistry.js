export async function fetchHomeAssistantGraph({
  baseUrl,
  token,
  fetchImpl = fetch,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!baseUrl || !token) throw new Error("Home Assistant adapter is not configured");
  const normalizedBaseUrl = String(baseUrl).replace(/\/$/, "");

  const [states, registry] = await Promise.all([
    fetchStates({ baseUrl: normalizedBaseUrl, token, fetchImpl }),
    fetchRegistries({ baseUrl: normalizedBaseUrl, token, WebSocketImpl }),
  ]);

  return {
    provider: {
      id: "home_assistant",
      name: "Home Assistant",
      baseUrl: redactUrl(normalizedBaseUrl),
    },
    fetchedAt: new Date().toISOString(),
    states,
    devices: registry.devices,
    entities: registry.entities,
    areas: registry.areas,
  };
}

async function fetchStates({ baseUrl, token, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/api/states`, {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Home Assistant states request failed ${response.status}: ${text.slice(0, 300)}`);
  }
  const states = await response.json();
  if (!Array.isArray(states)) throw new Error("Home Assistant /api/states did not return an array");
  return states;
}

async function fetchRegistries({ baseUrl, token, WebSocketImpl }) {
  if (typeof WebSocketImpl !== "function") {
    throw new Error("WebSocket is required to read Home Assistant registries");
  }

  const wsUrl = `${baseUrl.replace(/^http/, "ws")}/api/websocket`;
  const socket = new WebSocketImpl(wsUrl);
  let nextId = 1;
  const pending = new Map();

  const send = (type, payload = {}) => {
    const id = nextId;
    nextId += 1;
    socket.send(JSON.stringify({ id, type, ...payload }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Home Assistant registry websocket timed out"));
      }, 15000);

      socket.addEventListener("message", async (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "auth_required") {
            socket.send(JSON.stringify({ type: "auth", access_token: token }));
            return;
          }
          if (message.type === "auth_invalid") {
            clearTimeout(timeout);
            reject(new Error("Home Assistant registry websocket authentication failed"));
            return;
          }
          if (message.type === "auth_ok") {
            const [devices, entities, areas] = await Promise.all([
              send("config/device_registry/list"),
              send("config/entity_registry/list"),
              send("config/area_registry/list"),
            ]);
            clearTimeout(timeout);
            resolve({
              devices: resultOrThrow(devices, "device registry"),
              entities: resultOrThrow(entities, "entity registry"),
              areas: resultOrThrow(areas, "area registry"),
            });
            socket.close();
            return;
          }
          if (message.id && pending.has(message.id)) {
            const { resolve: resolvePending, reject: rejectPending } = pending.get(message.id);
            pending.delete(message.id);
            if (message.success === false) rejectPending(new Error(message.error?.message || "Registry command failed"));
            else resolvePending(message);
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
          socket.close();
        }
      });

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Home Assistant registry websocket failed"));
      });
    });
  } finally {
    for (const { reject } of pending.values()) reject(new Error("Registry request was cancelled"));
    pending.clear();
  }
}

function resultOrThrow(message, label) {
  if (!message?.success) throw new Error(`Home Assistant ${label} request failed`);
  if (!Array.isArray(message.result)) throw new Error(`Home Assistant ${label} did not return an array`);
  return message.result;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function redactUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return baseUrl;
  }
}
