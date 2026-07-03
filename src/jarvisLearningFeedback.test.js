import { describe, expect, it } from "vitest";
import { createAutomationMemory } from "./automationSuggestionEngine.js";
import { createLearningMemory, recordLearningObservation } from "./learningLayer.js";
import {
  applyJarvisLearningFeedback,
  normalizeLearningFeedbackPayload,
  selectUserVisibleLearningSuggestion,
} from "./jarvisLearningFeedback.js";

function auditEntry(input = "打开书房射灯") {
  return {
    commandId: "cmd-1",
    input,
    path: "hcm-real",
    status: "executed",
    execution: {
      services: [
        {
          thingId: "ha_study_switch",
          thingName: "书房射灯",
          capabilityId: "study_spotlight",
          capabilityName: "开关",
          service: "switch.turn_on",
        },
      ],
    },
    safety: { level: "low", confirmationRequired: false },
  };
}

describe("Jarvis learning feedback", () => {
  it("normalizes spoken feedback", () => {
    expect(normalizeLearningFeedbackPayload({ text: "可以" })).toMatchObject({ feedback: "accept" });
    expect(normalizeLearningFeedbackPayload({ text: "别这样" })).toMatchObject({ feedback: "reject" });
    expect(normalizeLearningFeedbackPayload({ text: "撤销" })).toMatchObject({ feedback: "undo" });
  });

  it("accepts a learning candidate from a source command", () => {
    const memory = recordLearningObservation(createLearningMemory(), auditEntry(), {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const result = applyJarvisLearningFeedback({
      payload: { feedback: "accept", sourceCommandId: "cmd-1" },
      learningMemory: memory,
      automationMemory: createAutomationMemory(),
      auditEntries: [auditEntry()],
      now: () => "2026-07-01T00:01:00.000Z",
    });

    expect(result).toMatchObject({
      appliedTo: "semantic",
      feedback: "accept",
      replyText: expect.stringContaining("我记住了"),
      learningSummary: {
        acceptedCount: 1,
      },
    });
    expect(result.learningMemory.candidates[0]).toMatchObject({
      status: "accepted",
      application: {
        mode: "semantic",
        sourceCommandId: "cmd-1",
      },
    });
  });

  it("rejects and ignores a candidate", () => {
    const memory = recordLearningObservation(createLearningMemory(), auditEntry(), {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const result = applyJarvisLearningFeedback({
      payload: { feedback: "reject", candidateId: memory.candidates[0].id },
      learningMemory: memory,
      automationMemory: createAutomationMemory(),
      auditEntries: [auditEntry()],
    });

    expect(result).toMatchObject({
      appliedTo: "none",
      feedback: "reject",
      learningSummary: { ignoredCount: 1 },
    });
    expect(result.learningMemory.candidates[0].status).toBe("ignored");
  });

  it("undoes a candidate into a tombstone", () => {
    const memory = recordLearningObservation(createLearningMemory(), auditEntry(), {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const result = applyJarvisLearningFeedback({
      payload: { feedback: "undo", candidateId: memory.candidates[0].id },
      learningMemory: memory,
      automationMemory: createAutomationMemory(),
      auditEntries: [auditEntry()],
    });

    expect(result.learningMemory.candidates).toHaveLength(0);
    expect(result.learningMemory.tombstones[0]).toMatchObject({
      id: memory.candidates[0].id,
    });
  });

  it("selects a user-visible learning prompt only after enough evidence", () => {
    expect(selectUserVisibleLearningSuggestion({
      learningSummary: {
        topCandidates: [{ id: "candidate_1", input: "打开书房射灯", status: "shadow", count: 1, confidence: 0.6 }],
      },
      sourceCommandId: "cmd-1",
    })).toBeNull();

    expect(selectUserVisibleLearningSuggestion({
      learningSummary: {
        topCandidates: [{ id: "candidate_1", input: "打开书房射灯", status: "shadow", count: 2, confidence: 0.76 }],
      },
      sourceCommandId: "cmd-1",
    })).toMatchObject({
      type: "semantic",
      candidateId: "candidate_1",
      sourceCommandId: "cmd-1",
      prompt: expect.stringContaining("要不要以后"),
    });
  });
});
