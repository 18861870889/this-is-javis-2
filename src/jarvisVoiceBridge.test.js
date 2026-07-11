import { describe, expect, it } from "vitest";
import {
  buildHcmPayloadFromUtterance,
  buildDuplicateUtteranceResponse,
  buildUtteranceDedupeKey,
  classifyUtterance,
  formatVoiceBridgeResponse,
  normalizeUtterancePayload,
  normalizeVoiceAsrText,
} from "./jarvisVoiceBridge.js";

describe("Jarvis voice bridge", () => {
  it("normalizes narrow second-bedroom ASR confusions before routing", () => {
    expect(normalizeVoiceAsrText("是我吸顶灯开着吗？")).toBe("次卧吸顶灯开着吗？");
    expect(normalizeVoiceAsrText("打开是我入户射灯")).toBe("打开次卧入户射灯");
    expect(normalizeVoiceAsrText("放吊灯。")).toBe("关吊灯。");
    expect(normalizeVoiceAsrText("帮我放射灯")).toBe("帮我关射灯");
    expect(normalizeVoiceAsrText("关闭过道设灯。")).toBe("关闭过道射灯。");
    expect(normalizeVoiceAsrText("关闭过道射灯啊。")).toBe("关闭过道射灯。");
    expect(normalizeVoiceAsrText("不是我想打开灯")).toBe("不是我想打开灯");
  });

  it("routes simple home control to the HCM fast path with an external planner draft", () => {
    const utterance = normalizeUtterancePayload({
      deviceId: "stackchan-study",
      roomId: "study",
      trigger: "wake_word",
      wakeSessionId: "wake-1",
      text: "打开书房射灯",
    });
    const classification = classifyUtterance(utterance.text);
    const hcmPayload = buildHcmPayloadFromUtterance(utterance, classification);

    expect(classification).toMatchObject({
      route: "hcm_fast_path",
      reason: "simple_power_command",
    });
    expect(hcmPayload).toMatchObject({
      input: "打开书房射灯",
      currentRoomId: "study",
      selectedRoomId: "study",
      sessionId: "wake-1",
      source: "voice",
      skipPlanner: true,
      plannerDraft: {
        intent_type: "device_control",
        actions: [{ target: "书房射灯", capability: "power", value: true }],
      },
    });
    expect(hcmPayload.plannerDraft.actions[0].room_id).toBeUndefined();
  });

  it("routes polite home controls to the fast path without planner dependency", () => {
    const utterance = normalizeUtterancePayload({
      deviceId: "stackchan-second",
      roomId: "living",
      text: "帮我打开次卧入户射灯。",
    });
    const classification = classifyUtterance(utterance.text);
    const hcmPayload = buildHcmPayloadFromUtterance(utterance, classification);

    expect(classification).toMatchObject({
      route: "hcm_fast_path",
      reason: "simple_power_command",
      plannerDraft: {
        actions: [{ target: "次卧入户射灯", capability: "power", value: true }],
      },
    });
    expect(hcmPayload).toMatchObject({
      skipPlanner: true,
      plannerDraft: {
        actions: [{ target: "次卧入户射灯", capability: "power", value: true }],
      },
    });
    expect(hcmPayload.plannerDraft.actions[0].room_id).toBeUndefined();
  });

  it("routes home state queries to a read-only HCM fast path", () => {
    const utterance = normalizeUtterancePayload({
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "wake-state-1",
      text: "书房射灯开着吗",
    });
    const classification = classifyUtterance(utterance.text);
    const hcmPayload = buildHcmPayloadFromUtterance(utterance, classification);

    expect(classification).toMatchObject({
      route: "hcm_fast_path",
      reason: "read_only_home_state_query",
      plannerDraft: {
        intent_type: "state_query",
        actions: [],
      },
    });
    expect(hcmPayload).toMatchObject({
      input: "书房射灯开着吗",
      currentRoomId: "study",
      selectedRoomId: "study",
      skipPlanner: true,
      plannerDraft: {
        intent_type: "state_query",
        query: { mode: "state", target: "书房射灯" },
        actions: [],
      },
    });
  });

  it("routes target-first power commands to the HCM fast path", () => {
    const utterance = normalizeUtterancePayload({
      roomId: "second",
      text: "卧室灯关一下",
    });
    const classification = classifyUtterance(utterance.text);

    const hcmPayload = buildHcmPayloadFromUtterance(utterance, classification);

    expect(hcmPayload).toMatchObject({
      currentRoomId: "second",
      selectedRoomId: "second",
      skipPlanner: true,
      plannerDraft: {
        intent_type: "device_control",
        actions: [{ target: "卧室灯", capability: "power", value: false }],
      },
    });
    expect(hcmPayload.plannerDraft.actions[0].room_id).toBe("second");
  });

  it("does not let StackChan source room override an explicit target room", () => {
    const utterance = normalizeUtterancePayload({
      roomId: "second",
      text: "关主卧灯",
    });
    const classification = classifyUtterance(utterance.text);
    const hcmPayload = buildHcmPayloadFromUtterance(utterance, classification);

    expect(hcmPayload).toMatchObject({
      currentRoomId: "second",
      selectedRoomId: "second",
      skipPlanner: true,
      plannerDraft: {
        intent_type: "device_control",
        actions: [{ target: "主卧灯", capability: "power", value: false }],
      },
    });
    expect(hcmPayload.plannerDraft.actions[0].room_id).toBeUndefined();
  });

  it("does not scope generic bedroom commands to non-bedroom source rooms", () => {
    const utterance = normalizeUtterancePayload({
      roomId: "living",
      text: "卧室灯关一下",
    });
    const classification = classifyUtterance(utterance.text);
    const hcmPayload = buildHcmPayloadFromUtterance(utterance, classification);

    expect(hcmPayload.plannerDraft.actions[0]).toMatchObject({
      target: "卧室灯",
      capability: "power",
      value: false,
    });
    expect(hcmPayload.plannerDraft.actions[0].room_id).toBeUndefined();
  });

  it("keeps complex home commands on the HCM slow path", () => {
    expect(classifyUtterance("把客厅灯调暗一点")).toMatchObject({
      route: "hcm_slow_path",
      reason: "home_domain_command",
    });
  });

  it("detects short feedback utterances", () => {
    expect(classifyUtterance("可以")).toMatchObject({
      route: "learning_feedback",
    });
    expect(classifyUtterance("撤销")).toMatchObject({
      route: "learning_feedback",
    });
  });

  it("builds stable dedupe keys and silent duplicate responses", () => {
    const first = normalizeUtterancePayload({
      deviceId: "stackchan-study",
      wakeSessionId: "wake-1",
      text: "打开书房射灯。",
    });
    const duplicate = normalizeUtterancePayload({
      deviceId: "stackchan-living",
      wakeSessionId: "wake-1",
      text: "打开书房射灯",
    });

    expect(buildUtteranceDedupeKey(first)).toBe(buildUtteranceDedupeKey(duplicate));
    expect(buildDuplicateUtteranceResponse({
      utterance: duplicate,
      handledByDeviceId: first.deviceId,
      dedupeKey: buildUtteranceDedupeKey(duplicate),
    })).toMatchObject({
      route: "duplicate_ignored",
      status: "duplicate_ignored",
      speak: false,
      duplicate: true,
      handledByDeviceId: "stackchan-study",
    });
  });

  it("formats voice responses for StackChan playback", () => {
    const response = formatVoiceBridgeResponse({
      utterance: normalizeUtterancePayload({ text: "打开书房射灯", roomId: "study" }),
      classification: classifyUtterance("打开书房射灯"),
      hcmResult: {
        commandId: "cmd-1",
        status: "executed",
        latencyMs: 456,
        explanation: { userMessage: "书房射灯已打开。" },
        trace: { safety: { level: "low" } },
      },
      learningSuggestion: { type: "semantic", prompt: "要不要以后我优先按这个意思理解？" },
    });

    expect(response).toMatchObject({
      route: "hcm_fast_path",
      commandId: "cmd-1",
      status: "executed",
      speak: true,
      replyText: "书房射灯已打开。",
      learnedSuggestion: { type: "semantic" },
      latencyMs: 456,
    });
  });
});
