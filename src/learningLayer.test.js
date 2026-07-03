import { describe, expect, it } from "vitest";
import {
  compileHouseholdLearningContext,
  createLearningMemory,
  deleteLearningCandidate,
  deriveCorrectionCandidates,
  deriveLearningCandidates,
  recordLearningObservation,
  summarizeLearningMemory,
  updateLearningCandidate,
} from "./learningLayer.js";

function auditEntry(input = "打开客厅灯") {
  return {
    commandId: crypto.randomUUID(),
    input,
    path: "hcm-real",
    status: "executed",
    execution: {
      services: [
        {
          thingId: "ha_light",
          thingName: "客厅灯",
          capabilityId: "living_light",
          capabilityName: "开关",
          service: "switch.turn_on",
        },
      ],
    },
    safety: { level: "low", confirmationRequired: false },
  };
}

function failedAuditEntry(input = "我要晾衣服", status = "no_action") {
  return {
    commandId: crypto.randomUUID(),
    input,
    path: "hcm-real",
    status,
    execution: {
      services: [],
      rejectedCount: status === "rejected" ? 1 : 0,
    },
    safety: { level: "low", confirmationRequired: false, rejectedCount: status === "rejected" ? 1 : 0 },
    explanation: { summary: "没有找到可执行设备或能力" },
  };
}

describe("learning layer", () => {
  it("records observations and creates shadow candidates", () => {
    const memory = recordLearningObservation(createLearningMemory(), auditEntry("打开客厅灯"), {
      updatedAt: "2026-06-14T00:00:00.000Z",
    });

    expect(memory.observations).toHaveLength(1);
    expect(memory.candidates).toEqual([
      expect.objectContaining({
        status: "shadow",
        input: "打开客厅灯",
        count: 1,
        safety: expect.objectContaining({ autoApply: false }),
      }),
    ]);
  });

  it("groups repeated commands by normalized key", () => {
    const candidates = deriveLearningCandidates([
      {
        input: "帮我打开客厅灯",
        success: true,
        actions: [{ thingId: "ha_light", capabilityId: "living_light", service: "switch.turn_on" }],
      },
      {
        input: "打开客厅灯",
        success: true,
        actions: [{ thingId: "ha_light", capabilityId: "living_light", service: "switch.turn_on" }],
      },
    ]);

    expect(candidates[0]).toMatchObject({
      count: 2,
      confidence: 0.75,
    });
  });

  it("summarizes memory without exposing raw logs", () => {
    const memory = recordLearningObservation(createLearningMemory(), auditEntry("准备看电影"));

    expect(summarizeLearningMemory(memory)).toMatchObject({
      mode: "shadow",
      observationCount: 1,
      candidateCount: 1,
    });
  });

  it("keeps ignored candidates out of top candidates", () => {
    const observed = recordLearningObservation(createLearningMemory(), auditEntry("准备看电影"), {
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
    const ignored = updateLearningCandidate(
      observed,
      observed.candidates[0].id,
      { status: "ignored", note: "too noisy" },
      { updatedAt: "2026-06-14T00:01:00.000Z" },
    );
    const next = recordLearningObservation(ignored, auditEntry("准备看电影"), {
      updatedAt: "2026-06-14T00:02:00.000Z",
    });
    const summary = summarizeLearningMemory(next);

    expect(next.candidates[0]).toMatchObject({
      status: "ignored",
      note: "too noisy",
      count: 2,
    });
    expect(summary.ignoredCount).toBe(1);
    expect(summary.topCandidates).toHaveLength(0);
  });

  it("tombstones deleted candidates so history does not immediately recreate them", () => {
    const observed = recordLearningObservation(createLearningMemory(), auditEntry("准备看电影"));
    const deleted = deleteLearningCandidate(observed, observed.candidates[0].id, {
      updatedAt: "2026-06-14T00:01:00.000Z",
    });
    const next = recordLearningObservation(deleted, auditEntry("准备看电影"), {
      updatedAt: "2026-06-14T00:02:00.000Z",
    });

    expect(next.candidates).toHaveLength(0);
    expect(next.tombstones).toEqual([
      expect.objectContaining({
        id: observed.candidates[0].id,
        commandKey: observed.candidates[0].commandKey,
      }),
    ]);
  });

  it("creates shadow correction candidates from no-action or rejected commands", () => {
    const memory = recordLearningObservation(createLearningMemory(), failedAuditEntry("我要晾衣服"), {
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
    const summary = summarizeLearningMemory(memory);

    expect(memory.candidates).toHaveLength(0);
    expect(summary.correctionCandidates).toEqual([
      expect.objectContaining({
        type: "correction_needed",
        input: "我要晾衣服",
        reason: "没有找到可执行设备或能力，可能需要补充家庭语义/设备映射",
        safety: expect.objectContaining({ autoApply: false }),
      }),
    ]);
  });

  it("groups repeated correction candidates by normalized command", () => {
    const candidates = deriveCorrectionCandidates([
      { input: "请帮我晾衣服", status: "no_action" },
      { input: "晾衣服", status: "no_action" },
      { input: "打开客厅灯", status: "executed" },
    ]);

    expect(candidates[0]).toMatchObject({
      count: 2,
      confidence: 0.75,
      commandKey: "晾衣服",
    });
  });

  it("turns clarification failures into shadow correction candidates", () => {
    const candidates = deriveCorrectionCandidates([
      { input: "过道射灯还有一个没关", status: "needs_clarification" },
    ]);

    expect(candidates[0]).toMatchObject({
      input: "过道射灯还有一个没关",
      reason: "目标、集合成员或主执行器不完整，需要补充会话语义或控制图映射",
      safety: { autoApply: false, reason: expect.any(String) },
    });
  });

  it("compiles shadow learning into planner guidance without auto-apply", () => {
    const memory = recordLearningObservation(createLearningMemory(), auditEntry("书房灯开一下"), {
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
    const context = compileHouseholdLearningContext(memory, { input: "书房灯开一下" });

    expect(context).toMatchObject({
      version: "0.23",
      mode: "shadow",
      safety: {
        autoApply: false,
        reason: expect.stringContaining("must not create executable actions"),
      },
    });
    expect(context.hints).toEqual([
      expect.objectContaining({
        input: "书房灯开一下",
        instruction: expect.stringContaining("Planner hint only"),
      }),
    ]);
  });

  it("marks accepted candidates as user-confirmed planner guidance", () => {
    const observed = recordLearningObservation(createLearningMemory(), auditEntry("书房灯开一下"), {
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
    const accepted = updateLearningCandidate(
      observed,
      observed.candidates[0].id,
      { status: "accepted", sourceCommandId: "cmd-study-light" },
      { updatedAt: "2026-06-14T00:01:00.000Z" },
    );
    const context = compileHouseholdLearningContext(accepted, { input: "书房灯开一下" });

    expect(summarizeLearningMemory(accepted)).toMatchObject({
      acceptedCount: 1,
      acceptedCandidates: [expect.objectContaining({ status: "accepted" })],
    });
    expect(context.hints[0]).toMatchObject({
      status: "accepted",
      application: { mode: "semantic", sourceCommandId: "cmd-study-light" },
      instruction: expect.stringContaining("User-confirmed"),
    });
  });

  it("exposes correction hints for similar failed commands", () => {
    const memory = recordLearningObservation(createLearningMemory(), failedAuditEntry("打开射灯"), {
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
    const context = compileHouseholdLearningContext(memory, { input: "打开射灯" });

    expect(context.correctionHints).toEqual([
      expect.objectContaining({
        input: "打开射灯",
        instruction: expect.stringContaining("previous failure pattern"),
      }),
    ]);
    expect(context.hints).toEqual([]);
  });

  it("does not add unrelated learned command hints to short comfort follow-ups", () => {
    const memory = recordLearningObservation(createLearningMemory(), auditEntry("书房灯开一下"), {
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
    const context = compileHouseholdLearningContext(memory, { input: "不够亮啊" });

    expect(context.hints).toEqual([]);
  });
});
