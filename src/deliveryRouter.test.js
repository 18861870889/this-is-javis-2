import { describe, expect, it } from "vitest";
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

  it("delivers short home results by voice and audit without calling WeChat", async () => {
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
    }, fixedNow));

    expect(delivery.status).toBe("delivered");
    expect(delivery.channelResults).toEqual([
      expect.objectContaining({ channel: "voice", status: "delivered" }),
    ]);
    expect(router.getVoiceQueue()).toEqual([
      expect.objectContaining({
        targetDeviceId: "stackchan-second",
        roomId: "second",
        text: "次卧吸顶灯开着。",
        status: "delivered",
      }),
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        source: "voice_bridge",
        status: "delivered",
        hasWechatBody: false,
      }),
    ]);
    expect(wechatCalls).toBe(0);
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

    expect(delivery.status).toBe("delivered");
    expect(delivery.channelResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "voice", status: "delivered" }),
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
