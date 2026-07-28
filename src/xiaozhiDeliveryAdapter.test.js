import { describe, expect, it, vi } from "vitest";
import {
  buildPrivateDeliveryEndpoint,
  createXiaozhiDeliverySender,
  isPrivateDeliveryHostname,
} from "./xiaozhiDeliveryAdapter.js";

describe("xiaozhiDeliveryAdapter", () => {
  it("accepts only private plain-HTTP endpoints and strips paths", () => {
    expect(buildPrivateDeliveryEndpoint("http://127.0.0.1:8004/old?token=no"))
      .toBe("http://127.0.0.1:8004/internal/v1/delivery/tts");
    expect(buildPrivateDeliveryEndpoint("http://host.container.internal:8004"))
      .toBe("http://host.container.internal:8004/internal/v1/delivery/tts");
    expect(buildPrivateDeliveryEndpoint("http://203.0.113.113:8004"))
      .toBe("http://203.0.113.113:8004/internal/v1/delivery/tts");
    expect(() => buildPrivateDeliveryEndpoint("http://example.com:8004"))
      .toThrow(/limited to loopback or private/);
    expect(() => buildPrivateDeliveryEndpoint("http://user:secret@127.0.0.1:8004"))
      .toThrow(/must not be embedded/);
    expect(isPrivateDeliveryHostname("10.23.45.67")).toBe(true);
    expect(isPrivateDeliveryHostname("172.31.0.1")).toBe(true);
    expect(isPrivateDeliveryHostname("172.32.0.1")).toBe(false);
  });

  it("posts a strict authenticated request and polls to delivered_inferred", async () => {
    const requests = [];
    const statuses = ["accepted", "dispatched", "delivered_inferred"];
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url, options });
      const status = statuses.shift();
      return new Response(JSON.stringify({
        deliveryId: "voice-task-1",
        status,
      }), {
        status: status === "accepted" ? 202 : 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sender = createXiaozhiDeliverySender({
      baseUrl: "http://127.0.0.1:8004",
      apiKey: "delivery-secret-that-is-never-logged",
      fetchImpl,
      delay: async () => {},
      now: advancingNow([
        "2026-07-28T10:00:00.000Z",
        "2026-07-28T10:00:00.010Z",
        "2026-07-28T10:00:00.020Z",
        "2026-07-28T10:00:00.030Z",
      ]),
    });

    const result = await sender({
      deliveryId: "voice-task-1",
      targetDeviceId: "stackchan-second",
      text: "任务完成了。",
      expiresAt: "2026-07-28T10:01:00.000Z",
      priority: "high",
    });
    const completion = await result.completion;

    expect(result.status).toBe("accepted");
    expect(completion.status).toBe("delivered_inferred");
    expect(requests).toHaveLength(3);
    expect(requests[0].url).toBe("http://127.0.0.1:8004/internal/v1/delivery/tts");
    expect(requests[0].options.headers.Authorization)
      .toBe("Bearer delivery-secret-that-is-never-logged");
    expect(JSON.parse(requests[0].options.body)).toEqual({
      deliveryId: "voice-task-1",
      targetDeviceId: "stackchan-second",
      text: "任务完成了。",
      expiresAt: "2026-07-28T10:01:00.000Z",
      priority: "high",
    });
    expect(requests[1].url).toMatch(/\/voice-task-1$/);
  });

  it("returns offline without polling and never includes the API key in results", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      deliveryId: "voice-task-2",
      status: "offline",
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));
    const secret = "a-private-delivery-key-that-must-stay-local";
    const sender = createXiaozhiDeliverySender({
      baseUrl: "http://127.0.0.1:8004",
      apiKey: secret,
      fetchImpl,
      now: () => new Date("2026-07-28T10:00:00.000Z"),
    });

    const result = await sender({
      deliveryId: "voice-task-2",
      targetDeviceId: "stackchan-second",
      text: "任务失败了。",
      expiresAt: "2026-07-28T10:01:00.000Z",
    });

    expect(result).toMatchObject({ status: "offline", deliveryId: "voice-task-2" });
    expect(result.completion).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails before network access when the message has already expired", async () => {
    const fetchImpl = vi.fn();
    const sender = createXiaozhiDeliverySender({
      baseUrl: "http://127.0.0.1:8004",
      apiKey: "delivery-secret-that-is-never-logged",
      fetchImpl,
      now: () => new Date("2026-07-28T10:02:00.000Z"),
    });

    await expect(sender({
      deliveryId: "voice-task-3",
      targetDeviceId: "stackchan-second",
      text: "过期消息。",
      expiresAt: "2026-07-28T10:01:00.000Z",
    })).resolves.toMatchObject({
      status: "expired",
      reason: "expired_before_dispatch",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is disabled unless both endpoint and key are configured", () => {
    expect(createXiaozhiDeliverySender({ baseUrl: "", apiKey: "key" })).toBeNull();
    expect(createXiaozhiDeliverySender({ baseUrl: "http://127.0.0.1:8004", apiKey: "" })).toBeNull();
  });
});

function advancingNow(values) {
  const dates = values.map((value) => new Date(value));
  let index = 0;
  return () => dates[Math.min(index++, dates.length - 1)];
}
