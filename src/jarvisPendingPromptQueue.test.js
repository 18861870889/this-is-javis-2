import { describe, expect, it } from "vitest";
import {
  createPendingPromptQueue,
  enqueuePendingPrompt,
  resolvePendingPromptForFeedback,
  summarizePendingPromptQueue,
  updatePendingPromptDecision,
} from "./jarvisPendingPromptQueue.js";

describe("Jarvis pending prompt queue", () => {
  it("binds bare feedback to the latest pending learning prompt", () => {
    const enqueued = enqueuePendingPrompt(
      createPendingPromptQueue(),
      {
        type: "semantic",
        candidateId: "candidate_1",
        sourceCommandId: "cmd-1",
        prompt: "要不要以后我优先按这个意思理解？",
        confidence: 0.8,
      },
      { now: () => "2026-07-01T00:00:00.000Z", context: { deviceId: "stackchan-study", roomId: "study" } },
    );
    const resolved = resolvePendingPromptForFeedback(enqueued.queue, { text: "可以" }, {
      now: () => "2026-07-01T00:01:00.000Z",
      context: { deviceId: "stackchan-study", roomId: "study" },
    });

    expect(resolved.prompt).toMatchObject({ id: enqueued.prompt.id, candidateId: "candidate_1" });
    expect(resolved.payload).toMatchObject({
      text: "可以",
      candidateId: "candidate_1",
      sourceCommandId: "cmd-1",
      pendingPromptId: enqueued.prompt.id,
    });
  });

  it("does not bind bare feedback to a pending prompt from another room", () => {
    const enqueued = enqueuePendingPrompt(
      createPendingPromptQueue(),
      {
        type: "semantic",
        candidateId: "candidate_1",
        sourceCommandId: "cmd-1",
        prompt: "要不要以后我优先按这个意思理解？",
      },
      { now: () => "2026-07-01T00:00:00.000Z", context: { deviceId: "stackchan-study", roomId: "study" } },
    );
    const resolved = resolvePendingPromptForFeedback(enqueued.queue, { text: "可以" }, {
      now: () => "2026-07-01T00:01:00.000Z",
      context: { deviceId: "stackchan-living", roomId: "living" },
    });

    expect(resolved.prompt).toBeNull();
    expect(resolved.payload).toEqual({ text: "可以" });
  });

  it("marks resolved prompts and ignores expired prompts", () => {
    const enqueued = enqueuePendingPrompt(
      createPendingPromptQueue(),
      {
        type: "automation",
        suggestionId: "automation_1",
        sourceCommandId: "cmd-1",
        prompt: "要不要以后我主动提醒你？",
      },
      { now: () => "2026-07-01T00:00:00.000Z", ttlMs: 1000 },
    );
    const accepted = updatePendingPromptDecision(enqueued.queue, enqueued.prompt.id, "accept", {
      updatedAt: "2026-07-01T00:00:30.000Z",
    });
    const summary = summarizePendingPromptQueue(accepted, { now: () => "2026-07-01T00:01:00.000Z" });
    const expiredResolution = resolvePendingPromptForFeedback(enqueued.queue, { text: "可以" }, {
      now: () => "2026-07-01T00:01:00.000Z",
    });

    expect(summary.pendingCount).toBe(0);
    expect(summary.resolvedCount).toBe(1);
    expect(summary.prompts[0]).toMatchObject({ status: "accepted", feedback: "accept" });
    expect(expiredResolution.prompt).toBeNull();
    expect(expiredResolution.queue.prompts[0].status).toBe("expired");
  });
});
