const DEFAULT_TIMEOUT_MS = 3000;

export async function inspectRuntimeReadiness({
  env = process.env,
  fetchImpl = fetch,
  storageWritable = true,
  now = () => Date.now(),
} = {}) {
  const timeoutMs = positiveNumber(env.JARVIS_READINESS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const hermesBaseUrl = env.HERMES_API_BASE_URL || env.HERMES_API_URL;
  const hermesApiKey = env.HERMES_API_KEY || env.API_SERVER_KEY;
  const [hermes, homeAssistant] = await Promise.all([
    probeDependency({
      id: "hermes",
      configured: Boolean(hermesBaseUrl && hermesApiKey),
      url: appendPath(hermesBaseUrl, "/v1/models"),
      token: hermesApiKey,
      timeoutMs,
      fetchImpl,
      now,
    }),
    probeDependency({
      id: "home_assistant",
      configured: Boolean(
        (env.HA_BASE_URL && env.HA_TOKEN) ||
        (env.HOME_ASSISTANT_URL && env.HOME_ASSISTANT_TOKEN),
      ),
      url: appendPath(env.HA_BASE_URL || env.HOME_ASSISTANT_URL, "/api/"),
      token: env.HA_TOKEN || env.HOME_ASSISTANT_TOKEN,
      timeoutMs,
      fetchImpl,
      now,
    }),
  ]);
  const ready = storageWritable && hermes.reachable && homeAssistant.reachable;
  return {
    version: "0.1",
    ready,
    storage: {
      writable: Boolean(storageWritable),
    },
    dependencies: {
      hermes,
      homeAssistant,
    },
  };
}

export async function probeDependency({
  id,
  configured,
  url,
  token = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  if (!configured || !url) {
    return {
      id,
      configured: false,
      reachable: false,
      latencyMs: 0,
      errorCode: "not_configured",
    };
  }

  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      id,
      configured: true,
      reachable: response.ok,
      latencyMs: Math.max(0, now() - startedAt),
      errorCode: response.ok ? null : `http_${response.status}`,
    };
  } catch (error) {
    return {
      id,
      configured: true,
      reachable: false,
      latencyMs: Math.max(0, now() - startedAt),
      errorCode: error?.name === "AbortError" ? "timeout" : "connection_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

function appendPath(baseUrl, path) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
