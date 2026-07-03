import { describe, expect, it } from "vitest";
import { buildPromptContextPackV2, normalizeIntentFrame, summarizePromptContextPack } from "./intentFrame.js";

describe("intent frame and prompt context pack", () => {
  it("normalizes new intent_frame drafts into a semantic contract", () => {
    const frame = normalizeIntentFrame("书房太暗了", {
      intent_frame: {
        intent_type: "device_control",
        intent: "brighten_study",
        confidence: 0.88,
        goal: {
          domain: "lighting",
          desired_outcome: "increase_brightness",
          space_refs: ["书房"],
          target_refs: ["书房射灯"],
        },
        grounding: {
          required_facts: ["room_lights_state"],
          candidate_targets: [{ target_ref: "asset_study_书房射灯", confidence: 0.8, reason: "用户提到书房和太暗" }],
        },
        ambiguity: { level: "low", needs_clarification: false },
        decision: {
          mode: "execute",
          actions: [{ target: "书房射灯", capability: "power", value: true, reason: "先打开偏好灯" }],
        },
      },
      summary: "尝试让书房更亮",
    });

    expect(frame).toMatchObject({
      version: "0.20",
      source: "llm_intent_frame",
      intentType: "device_control",
      goal: {
        domain: "lighting",
        outcome: "increase_brightness",
        spaceRefs: ["书房"],
        targetRefs: ["书房射灯"],
      },
      decision: { mode: "execute" },
      ambiguity: { level: "low" },
    });
    expect(frame.actions).toEqual([
      expect.objectContaining({ target: "书房射灯", capability: "power", value: true }),
    ]);
    expect(frame.grounding.requiredFacts).toEqual(["room_lights_state"]);
  });

  it("keeps legacy planner drafts compatible", () => {
    const frame = normalizeIntentFrame("小爱音箱停止播放音乐", {
      intent_type: "device_control",
      intent: "pause_music",
      confidence: 0.94,
      actions: [{ device_id: "xiaoai_speaker", capability: "speaker_playback", value: false }],
    });

    expect(frame).toMatchObject({
      source: "legacy_planner_draft",
      intentType: "device_control",
      goal: { domain: "media" },
      decision: { mode: "execute" },
    });
    expect(frame.actions[0]).toMatchObject({ device_id: "xiaoai_speaker", capability: "speaker_playback", value: false });
  });

  it("builds a room-oriented prompt context pack instead of a flat device dump", () => {
    const pack = buildPromptContextPackV2({
      input: "书房灯开一下",
      home: {
        provider: { id: "fixture" },
        spaces: [{ id: "study", name: "书房" }],
      },
      currentRoomId: "study",
      devices: [
        {
          id: "asset_study_书房射灯",
          name: "书房射灯",
          roomId: "study",
          type: "light",
          logicalAsset: true,
          capabilities: [{ id: "power", name: "书房射灯开关", operation: "on_off", access: "execute", state: false }],
        },
      ],
      context: { likelySpace: { id: "study", name: "书房", confidence: 0.9 }, spaces: [{ id: "study", occupied: true, confidence: 0.9 }] },
      learningContext: { hints: [{ id: "candidate_light", input: "书房灯开一下" }] },
    });

    expect(pack.rooms).toEqual([
      expect.objectContaining({
        id: "study",
        current: true,
        occupied: true,
        affordances: expect.objectContaining({ operations: ["on_off"] }),
      }),
    ]);
    expect(summarizePromptContextPack(pack)).toMatchObject({
      version: "0.20",
      rooms: 1,
      devices: 1,
      occupiedSpaces: 1,
      learningHints: 1,
    });
  });
});
