import { describe, expect, it } from "vitest";
import { buildJarvisBrainIntent, createPlannerDraftFromHomeIntent } from "./jarvisBrain.js";

describe("Jarvis brain intent contract", () => {
  it("recognizes home controls before HCM and emits a HomeIntent", () => {
    const brainIntent = buildJarvisBrainIntent({
      text: "打开书房射灯",
      utterance: { roomId: "study" },
    });

    expect(brainIntent).toMatchObject({
      type: "home_intent",
      route: "hcm_fast_path",
      homeIntent: {
        type: "home_intent",
        intentType: "device_control",
        semantic: {
          action: "turn_on",
          target: "书房射灯",
          roomId: "study",
          capability: "power",
          value: true,
        },
      },
    });
  });

  it("turns HomeIntent into an HCM-level draft without provider service calls", () => {
    const brainIntent = buildJarvisBrainIntent({
      text: "次卧吸顶灯开着吗？",
      utterance: { roomId: "second" },
    });
    const draft = createPlannerDraftFromHomeIntent(brainIntent.homeIntent);

    expect(draft).toMatchObject({
      intent_type: "state_query",
      query: {
        mode: "state",
        target: "次卧吸顶灯",
        room_id: "second",
      },
      actions: [],
    });
    expect(JSON.stringify(draft)).not.toContain("entity_id");
    expect(JSON.stringify(draft)).not.toContain("turn_on");
  });

  it("strips polite command words and keeps explicit room over source room", () => {
    const brainIntent = buildJarvisBrainIntent({
      text: "帮我打开主卧射灯。",
      utterance: { roomId: "second" },
    });
    const draft = createPlannerDraftFromHomeIntent(brainIntent.homeIntent);

    expect(brainIntent).toMatchObject({
      type: "home_intent",
      homeIntent: {
        semantic: {
          target: "主卧射灯",
          roomId: "master",
          value: true,
        },
      },
    });
    expect(draft.actions[0]).toMatchObject({
      target: "主卧射灯",
      room_id: "master",
      value: true,
    });
  });

  it("does not treat 入户 as the room when a stronger explicit room appears first", () => {
    const brainIntent = buildJarvisBrainIntent({
      text: "帮我打开次卧入户射灯。",
      utterance: { roomId: "living" },
    });

    expect(brainIntent.homeIntent.semantic).toMatchObject({
      target: "次卧入户射灯",
      roomId: "second",
      value: true,
    });
  });

  it("can still use 入户 as a room when it is the only explicit room", () => {
    const brainIntent = buildJarvisBrainIntent({
      text: "打开入户射灯。",
      utterance: { roomId: "second" },
    });

    expect(brainIntent.homeIntent.semantic).toMatchObject({
      target: "入户射灯",
      roomId: "entry",
      value: true,
    });
  });
});
