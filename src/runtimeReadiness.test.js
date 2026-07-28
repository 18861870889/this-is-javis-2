import { describe, expect, it, vi } from "vitest";
import { inspectRuntimeReadiness, probeDependency } from "./runtimeReadiness.js";

describe("runtime readiness", () => {
  it("requires writable storage plus reachable Hermes and Home Assistant", async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe("Bearer secret");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await inspectRuntimeReadiness({
      env: {
        HERMES_API_BASE_URL: "http://host.container.internal:8642",
        HERMES_API_KEY: "secret",
        HA_BASE_URL: "http://10.23.45.67:8123",
        HA_TOKEN: "secret",
      },
      fetchImpl,
      storageWritable: true,
    });

    expect(result.ready).toBe(true);
    expect(result.dependencies.hermes.reachable).toBe(true);
    expect(result.dependencies.homeAssistant.reachable).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://host.container.internal:8642/v1/models",
      "http://10.23.45.67:8123/api/",
    ]);
  });

  it("does not report Hermes ready when the bearer key is rejected", async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      expect(url).toBe("http://host.container.internal:8642/v1/models");
      expect(options.headers.Authorization).toBe("Bearer wrong-key");
      return new Response("", { status: 401 });
    });

    const result = await inspectRuntimeReadiness({
      env: {
        HERMES_API_BASE_URL: "http://host.container.internal:8642",
        HERMES_API_KEY: "wrong-key",
      },
      fetchImpl,
    });

    expect(result.ready).toBe(false);
    expect(result.dependencies.hermes).toMatchObject({
      configured: true,
      reachable: false,
      errorCode: "http_401",
    });
    expect(JSON.stringify(result)).not.toContain("wrong-key");
  });

  it("does not probe Hermes when its bearer key is missing", async () => {
    const fetchImpl = vi.fn();

    const result = await inspectRuntimeReadiness({
      env: {
        HERMES_API_BASE_URL: "http://host.container.internal:8642",
      },
      fetchImpl,
    });

    expect(result.dependencies.hermes).toMatchObject({
      configured: false,
      reachable: false,
      errorCode: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns sanitized dependency failures without URLs or response bodies", async () => {
    const result = await inspectRuntimeReadiness({
      env: {
        HERMES_API_BASE_URL: "http://private-host:8642",
        HERMES_API_KEY: "do-not-return",
      },
      fetchImpl: vi.fn(async () => new Response("sensitive upstream body", { status: 503 })),
      storageWritable: false,
    });

    expect(result.ready).toBe(false);
    expect(result.dependencies.hermes).toMatchObject({
      configured: true,
      reachable: false,
      errorCode: "http_503",
    });
    expect(result.dependencies.homeAssistant.errorCode).toBe("not_configured");
    expect(JSON.stringify(result)).not.toContain("private-host");
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("classifies aborts as timeouts", async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));

    const result = await probeDependency({
      id: "hermes",
      configured: true,
      url: "http://host:8642/v1/models",
      timeoutMs: 5,
      fetchImpl,
    });

    expect(result).toMatchObject({
      configured: true,
      reachable: false,
      errorCode: "timeout",
    });
  });
});
