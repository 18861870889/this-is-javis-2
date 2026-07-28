import { describe, expect, it, vi } from "vitest";
import {
  buildDeliveryForPcResult,
  createDeliveryMessage,
  createDeliveryRouter,
  createHermesWechatSender,
  shouldUseDeliveryRouter,
  summarizeForVoiceWithWechat,
} from "./deliveryRouter.js";

describe("deliveryRouter", () => {
  it("routes only StackChan/Xiaozhi/MCP-originated work", () => {
    expect(shouldUseDeliveryRouter({ ingress: "stackchan" })).toBe(true);
    expect(shouldUseDeliveryRouter({ ingress: "xiaozhi_llm" })).toBe(true);
    expect(shouldUseDeliveryRouter({ ingress: "mcp" })).toBe(true);
    expect(shouldUseDeliveryRouter({ ingress: "wechat" })).toBe(false);
    expect(shouldUseDeliveryRouter({ ingress: "hermes_wechat" })).toBe(false);
  });

  it("returns synchronous voice results inline without claiming playback acknowledgement", async () => {
    const audits = [];
    let wechatCalls = 0;
    const router = createDeliveryRouter({
      now: fixedNow,
      writeAudit: (entry) => audits.push(entry),
      wechatSender: async () => {
        wechatCalls += 1;
        return { status: "delivered" };
      },
    });

    const delivery = await router.route(createDeliveryMessage({
      origin: { ingress: "xiaozhi_llm", sourceDeviceId: "stackchan-second", roomId: "second" },
      voiceSummary: "次卧吸顶灯开着。",
      channels: ["voice"],
      source: "voice_bridge",
      voiceMode: "inline",
    }, fixedNow));

    expect(delivery.status).toBe("dispatched");
    expect(delivery.channelResults).toEqual([
      expect.objectContaining({
        channel: "voice",
        status: "dispatched",
        reason: "returned_to_ingress",
      }),
    ]);
    expect(router.getVoiceQueue()).toEqual([]);
    expect(audits).toEqual([
      expect.objectContaining({
        source: "voice_bridge",
        status: "dispatched",
        hasWechatBody: false,
      }),
    ]);
    expect(wechatCalls).toBe(0);
  });

  it("keeps asynchronous voice results pending until dispatch and playback acknowledgement", async () => {
    const router = createDeliveryRouter({ now: fixedNow });
    const delivery = await router.route(createDeliveryMessage({
      origin: { ingress: "xiaozhi_llm", sourceDeviceId: "stackchan-second", roomId: "second" },
      voiceSummary: "后台任务已经完成。",
      channels: ["voice"],
      source: "task_runtime",
    }, fixedNow));

    expect(delivery.status).toBe("pending");
    expect(router.getVoiceQueue()).toEqual([
      expect.objectContaining({ status: "pending", text: "后台任务已经完成。" }),
    ]);

    const [dispatched] = router.drainVoiceQueue({ targetDeviceId: "stackchan-second" });
    expect(dispatched).toMatchObject({ status: "dispatched" });
    expect(router.acknowledgeVoiceDelivery(dispatched.id)).toMatchObject({ status: "delivered" });
    expect(router.getVoiceQueue()).toEqual([
      expect.objectContaining({ status: "delivered" }),
    ]);
  });

  it("pushes asynchronous results to Xiaozhi and records inferred playback completion", async () => {
    const audits = [];
    let finishDelivery;
    const completion = new Promise((resolve) => {
      finishDelivery = resolve;
    });
    const sent = [];
    const router = createDeliveryRouter({
      now: fixedNow,
      writeAudit: (entry) => audits.push(entry),
      voiceSender: async (message) => {
        sent.push(message);
        return {
          status: "accepted",
          completion,
        };
      },
    });

    const delivery = await router.route(createDeliveryMessage({
      taskId: "task-async-1",
      origin: { ingress: "xiaozhi_llm", sourceDeviceId: "stackchan-second", roomId: "second" },
      voiceSummary: "后台任务已经完成。",
      channels: ["voice"],
      source: "task_runtime",
    }, fixedNow));

    expect(delivery.status).toBe("accepted");
    expect(sent).toEqual([
      expect.objectContaining({
        deliveryId: expect.stringMatching(/^voice-delivery-/),
        targetDeviceId: "stackchan-second",
        text: "后台任务已经完成。",
      }),
    ]);
    expect(router.getVoiceQueue()[0]).toMatchObject({ status: "accepted" });

    finishDelivery({
      status: "delivered_inferred",
      updatedAt: "2026-07-07T10:00:02.000Z",
    });
    await completion;
    await Promise.resolve();

    expect(router.getVoiceQueue()[0]).toMatchObject({
      status: "delivered_inferred",
      updatedAt: "2026-07-07T10:00:02.000Z",
    });
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "delivered_inferred",
        channelResults: [
          expect.objectContaining({ status: "delivered_inferred" }),
        ],
      }),
    ]));
  });

  it("surfaces Xiaozhi offline state without claiming successful speech", async () => {
    const router = createDeliveryRouter({
      now: fixedNow,
      voiceSender: async () => ({ status: "offline", reason: "device_offline" }),
    });
    const delivery = await router.route(createDeliveryMessage({
      origin: { ingress: "xiaozhi_llm", sourceDeviceId: "stackchan-second" },
      voiceSummary: "任务完成了。",
      channels: ["voice"],
      source: "task_runtime",
    }, fixedNow));

    expect(delivery.status).toBe("offline");
    expect(delivery.channelResults[0]).toMatchObject({
      channel: "voice",
      status: "offline",
      reason: "device_offline",
    });
    expect(router.getVoiceQueue()[0]).toMatchObject({ status: "offline" });
  });

  it("retries a transient offline delivery without changing the delivery id", async () => {
    const scheduled = [];
    const sent = [];
    const router = createDeliveryRouter({
      now: fixedNow,
      voiceRetryDelaysMs: [1000],
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return { unref() {} };
      },
      voiceSender: async (message) => {
        sent.push(message);
        return sent.length === 1
          ? { status: "offline", reason: "device_offline" }
          : { status: "accepted" };
      },
    });
    const delivery = await router.route(createDeliveryMessage({
      origin: { ingress: "xiaozhi_llm", sourceDeviceId: "stackchan-second" },
      voiceSummary: "任务完成了。",
      channels: ["voice"],
      source: "task_runtime",
    }, fixedNow));

    expect(delivery.status).toBe("offline");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(1000);
    scheduled[0].callback();
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1].deliveryId).toBe(sent[0].deliveryId);
    expect(router.getVoiceQueue()[0]).toMatchObject({
      status: "accepted",
      attemptCount: 2,
      retryIndex: 1,
    });
  });

  it("does not let successful WeChat delivery hide failed voice delivery", async () => {
    const router = createDeliveryRouter({
      now: fixedNow,
      voiceSender: async () => ({ status: "offline", reason: "device_offline" }),
      wechatSender: async () => ({ status: "delivered" }),
    });
    const delivery = await router.route(createDeliveryMessage({
      origin: { ingress: "xiaozhi_llm", sourceDeviceId: "stackchan-second" },
      voiceSummary: "语音摘要。",
      wechatBody: "完整结果。",
      channels: ["voice", "wechat"],
      source: "task_runtime",
    }, fixedNow));

    expect(delivery.status).toBe("partial_failed");
    expect(delivery.channelResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "voice", status: "offline" }),
      expect.objectContaining({ channel: "wechat", status: "delivered" }),
    ]));
  });

  it("skips direct Hermes WeChat chat origins", async () => {
    const audits = [];
    const router = createDeliveryRouter({
      now: fixedNow,
      writeAudit: (entry) => audits.push(entry),
      wechatSender: async () => {
        throw new Error("should not send");
      },
    });

    const delivery = await router.route(createDeliveryMessage({
      origin: { ingress: "wechat" },
      voiceSummary: "不应该从 Jarvis Router 播报。",
      wechatBody: "不应该从 Jarvis Router 发送。",
      channels: ["voice", "wechat"],
    }, fixedNow));

    expect(delivery.status).toBe("skipped");
    expect(delivery.channelResults).toEqual([
      expect.objectContaining({
        channel: "router",
        status: "skipped",
        reason: "origin_not_routed",
      }),
    ]);
    expect(audits[0]).toMatchObject({ status: "skipped" });
  });

  it("sends PC action details to WeChat when a routed origin requests both channels", async () => {
    const sent = [];
    const router = createDeliveryRouter({
      now: fixedNow,
      wechatSender: async (message) => {
        sent.push(message);
        return { status: "delivered" };
      },
    });
    const message = buildDeliveryForPcResult({
      replyText: "已创建电脑工作区里的 hello.md，写入内容：helloworld。",
      filename: "hello.md",
      path: "/tmp/jarvis/hello.md",
    }, {
      origin: { ingress: "mcp", sourceDeviceId: "stackchan-mcp" },
      now: fixedNow,
    });

    const delivery = await router.route(message);

    expect(delivery.status).toBe("dispatched");
    expect(delivery.channelResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "voice", status: "dispatched" }),
      expect.objectContaining({ channel: "wechat", status: "delivered" }),
    ]));
    expect(sent).toEqual([
      expect.objectContaining({
        title: "Jarvis 电脑操作完成",
        body: expect.stringContaining("/tmp/jarvis/hello.md"),
      }),
    ]);
  });

  it("keeps WeChat delivery behind an explicit Hermes switch", async () => {
    const disabled = createHermesWechatSender({ enabled: false });
    await expect(disabled({ title: "x", body: "y" })).resolves.toMatchObject({
      status: "skipped",
      reason: "wechat_delivery_disabled",
    });

    const sentCommands = [];
    const enabled = createHermesWechatSender({
      enabled: true,
      command: "fake-hermes-send",
      runCommand: async (command) => {
        sentCommands.push(command);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    await expect(enabled({ title: "标题", body: "正文" })).resolves.toMatchObject({ status: "delivered" });
    expect(sentCommands[0]).toMatchObject({
      command: "fake-hermes-send",
      args: ["标题\n\n正文"],
    });
  });

  it("can produce a short voice summary for long async content", () => {
    expect(summarizeForVoiceWithWechat("一".repeat(120), { maxChars: 40 })).toMatch(/完整内容我发到微信了。$/);
  });
});

function fixedNow() {
  return new Date("2026-07-07T10:00:00.000Z");
}
