const DELIVERY_PATH = "/internal/v1/delivery/tts";
const REMOTE_STATUSES = new Set([
  "accepted",
  "busy",
  "offline",
  "expired",
  "failed",
  "dispatched",
  "delivered_inferred",
]);
const TERMINAL_STATUSES = new Set([
  "busy",
  "offline",
  "expired",
  "failed",
  "delivered_inferred",
]);

export function createXiaozhiDeliverySender({
  baseUrl = process.env.JARVIS_XIAOZHI_DELIVERY_BASE_URL || "",
  apiKey = process.env.JARVIS_XIAOZHI_DELIVERY_API_KEY || "",
  timeoutMs = Number(process.env.JARVIS_XIAOZHI_DELIVERY_TIMEOUT_MS || 3000),
  pollIntervalMs = Number(process.env.JARVIS_XIAOZHI_DELIVERY_POLL_INTERVAL_MS || 250),
  maxPollMs = Number(process.env.JARVIS_XIAOZHI_DELIVERY_MAX_POLL_MS || 30000),
  fetchImpl = globalThis.fetch,
  delay = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  now = () => new Date(),
} = {}) {
  const normalizedBaseUrl = String(baseUrl || "").trim();
  const normalizedApiKey = String(apiKey || "").trim();
  if (!normalizedBaseUrl || !normalizedApiKey) return null;
  if (typeof fetchImpl !== "function") {
    throw new Error("Xiaozhi delivery requires fetch support.");
  }

  const endpoint = buildPrivateDeliveryEndpoint(normalizedBaseUrl);
  const requestTimeoutMs = positiveDuration(timeoutMs, 3000);
  const statusPollIntervalMs = positiveDuration(pollIntervalMs, 250);
  const statusPollLimitMs = positiveDuration(maxPollMs, 30000);

  return async function sendXiaozhiVoiceDelivery(message = {}) {
    const request = normalizeDeliveryRequest(message);
    if (new Date(request.expiresAt).getTime() <= now().getTime()) {
      return {
        status: "expired",
        reason: "expired_before_dispatch",
        deliveryId: request.deliveryId,
      };
    }

    const response = await requestJson(endpoint, {
      method: "POST",
      apiKey: normalizedApiKey,
      body: request,
      timeoutMs: requestTimeoutMs,
      fetchImpl,
    });
    const initial = normalizeRemoteResult(response, request.deliveryId);
    if (!["accepted", "dispatched"].includes(initial.status)) return initial;

    return {
      ...initial,
      completion: pollDeliveryStatus({
        endpoint,
        deliveryId: request.deliveryId,
        expiresAt: request.expiresAt,
        apiKey: normalizedApiKey,
        timeoutMs: requestTimeoutMs,
        pollIntervalMs: statusPollIntervalMs,
        maxPollMs: statusPollLimitMs,
        fetchImpl,
        delay,
        now,
        initialStatus: initial.status,
      }),
    };
  };
}

export function buildPrivateDeliveryEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Xiaozhi delivery URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Xiaozhi delivery credentials must not be embedded in the URL.");
  }
  if (url.protocol === "http:" && !isPrivateDeliveryHostname(url.hostname)) {
    throw new Error("Plain HTTP Xiaozhi delivery is limited to loopback or private hostnames.");
  }
  url.pathname = DELIVERY_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function isPrivateDeliveryHostname(hostname = "") {
  const value = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return false;
  if ([
    "localhost",
    "::1",
    "host.container.internal",
    "host.docker.internal",
    "203.0.113.113",
  ].includes(value)) {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(value)) return true;
  const private172 = value.match(/^172\.(\d{1,3})(?:\.\d{1,3}){2}$/);
  return private172 ? Number(private172[1]) >= 16 && Number(private172[1]) <= 31 : false;
}

async function pollDeliveryStatus({
  endpoint,
  deliveryId,
  expiresAt,
  apiKey,
  timeoutMs,
  pollIntervalMs,
  maxPollMs,
  fetchImpl,
  delay,
  now,
  initialStatus,
}) {
  const startedAt = now().getTime();
  let lastStatus = initialStatus;
  while (now().getTime() - startedAt < maxPollMs) {
    if (new Date(expiresAt).getTime() <= now().getTime()) {
      return { status: "expired", reason: "delivery_status_expired", deliveryId };
    }
    await delay(pollIntervalMs);
    try {
      const response = await requestJson(`${endpoint}/${encodeURIComponent(deliveryId)}`, {
        method: "GET",
        apiKey,
        timeoutMs,
        fetchImpl,
      });
      const result = normalizeRemoteResult(response, deliveryId);
      lastStatus = result.status;
      if (TERMINAL_STATUSES.has(result.status)) return result;
    } catch (error) {
      if (error?.name === "AbortError") continue;
      return {
        status: "failed",
        reason: normalizeReason(error?.message, "delivery_status_failed"),
        deliveryId,
      };
    }
  }
  return {
    status: lastStatus,
    reason: "delivery_status_poll_timeout",
    deliveryId,
  };
}

async function requestJson(url, {
  method,
  apiKey,
  timeoutMs,
  fetchImpl,
  body,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await readJsonBody(response);
    if (!response.ok && !REMOTE_STATUSES.has(payload?.status)) {
      throw new Error(`xiaozhi_delivery_http_${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(response) {
  try {
    return await response.json();
  } catch {
    throw new Error(`xiaozhi_delivery_invalid_json_${response.status}`);
  }
}

function normalizeDeliveryRequest(message) {
  const deliveryId = String(message.deliveryId || message.id || "").trim();
  const targetDeviceId = String(message.targetDeviceId || "").trim();
  const text = String(message.text || "").trim();
  const expiresAt = new Date(message.expiresAt);
  const priority = String(message.priority || "normal").trim().toLowerCase();
  if (!deliveryId || !targetDeviceId || !text || Number.isNaN(expiresAt.getTime())) {
    throw new Error("Xiaozhi delivery requires deliveryId, targetDeviceId, text, and expiresAt.");
  }
  return {
    deliveryId,
    targetDeviceId,
    text,
    expiresAt: expiresAt.toISOString(),
    priority: priority === "high" ? "high" : "normal",
  };
}

function normalizeRemoteResult(payload, deliveryId) {
  const status = REMOTE_STATUSES.has(payload?.status) ? payload.status : "failed";
  return {
    status,
    reason: normalizeReason(
      payload?.reason,
      status === "failed" ? "xiaozhi_delivery_failed" : "",
    ),
    deliveryId: String(payload?.deliveryId || deliveryId || ""),
    updatedAt: String(payload?.updatedAt || ""),
  };
}

function normalizeReason(value, fallback = "") {
  return String(value || fallback || "").trim().slice(0, 160);
}

function positiveDuration(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
