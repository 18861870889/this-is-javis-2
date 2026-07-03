import { describe, expect, it } from "vitest";
import { createCommandTrace, finishCommandTrace, runCommandStage, summarizeSafety } from "./commandRuntime.js";

describe("command runtime", () => {
  it("records structured command stages", async () => {
    let now = 1000;
    const clock = () => now;
    const trace = createCommandTrace({ input: "打开客厅灯", now: clock });

    const result = await runCommandStage(
      trace,
      "context_snapshot",
      async () => {
        now += 12;
        return { things: 45 };
      },
      { now: clock, summarize: (value) => ({ things: value.things }) },
    );

    expect(result).toEqual({ things: 45 });
    expect(trace.stages).toEqual([
      expect.objectContaining({
        name: "context_snapshot",
        latencyMs: 12,
        status: "ok",
        summary: { things: 45 },
      }),
    ]);
  });

  it("finishes traces with safety summaries", () => {
    const trace = createCommandTrace({ input: "打开客厅灯", now: () => 1000 });
    const audit = finishCommandTrace(
      trace,
      {
        status: "executed",
        plan: { id: "plan", kind: "real_hcm", intent: "lighting", actions: [{ id: 1 }] },
        execution: {
          status: "executed",
          accepted: [{ thingId: "light", service: "switch.turn_on", risk: "low" }],
          rejected: [],
          results: [{ ok: true }],
        },
      },
      () => 1120,
    );

    expect(audit).toMatchObject({
      input: "打开客厅灯",
      status: "executed",
      latencyMs: 120,
      safety: {
        level: "low",
        confirmationRequired: false,
        executableCount: 1,
      },
    });
  });

  it("summarizes rejected safety gates", () => {
    expect(summarizeSafety({ needsConfirmation: true }, { accepted: [], rejected: [{ code: "blocked" }] })).toMatchObject({
      confirmationRequired: true,
      rejectedCount: 1,
    });
  });

  it("preserves replay source in audit traces", () => {
    const trace = createCommandTrace({
      input: "停止播放音乐",
      dryRun: true,
      replayOf: "cmd_original",
      now: () => 1000,
    });
    const audit = finishCommandTrace(trace, { status: "dry_run" }, () => 1010);

    expect(audit).toMatchObject({
      input: "停止播放音乐",
      dryRun: true,
      replayOf: "cmd_original",
      status: "dry_run",
    });
  });

  it("preserves voice source in audit traces", () => {
    const trace = createCommandTrace({ input: "打开客厅灯", source: "voice", now: () => 1000 });
    const audit = finishCommandTrace(trace, { status: "no_action" }, () => 1010);

    expect(audit.source).toBe("voice");
  });

  it("preserves intent explanations in audit traces", () => {
    const trace = createCommandTrace({ input: "我要晾衣服", now: () => 1000 });
    const audit = finishCommandTrace(
      trace,
      {
        status: "dry_run",
        plan: { id: "plan", kind: "real_hcm", intent: "prepare_laundry_drying", intentType: "scene", actions: [] },
        execution: { status: "dry_run", dryRun: true, accepted: [], rejected: [], results: [] },
        explanation: {
          title: "执行计划解释",
          summary: "我理解为：准备晾衣服\n目标设备：阳台晾衣杆",
          intent: { type: "scene", name: "prepare_laundry_drying", confidence: 0.88 },
          targets: ["阳台晾衣杆"],
          services: ["cover.set_cover_position"],
          safety: { status: "dry_run", dryRun: true, rejectedCount: 0, needsConfirmation: false },
          hints: [{ phrase: "晾衣服", target: "阳台晾衣杆", confidence: 0.95 }],
        },
      },
      () => 1015,
    );

    expect(audit.explanation).toMatchObject({
      title: "执行计划解释",
      targets: ["阳台晾衣杆"],
      services: ["cover.set_cover_position"],
      hints: [{ phrase: "晾衣服", target: "阳台晾衣杆" }],
    });
  });

  it("summarizes shadow agent snapshots in audit traces", () => {
    const trace = createCommandTrace({ input: "打开客厅灯", now: () => 1000 });
    const audit = finishCommandTrace(
      trace,
      {
        status: "dry_run",
        agents: {
          version: "0.1",
          mode: "shadow",
          generatedAt: "2026-06-17T12:00:00.000Z",
          summary: { agentCount: 3, mappingCandidates: 2, diagnosticsFindings: 1 },
          agents: {
            context: {
              likelySpace: { id: "study", name: "书房", occupied: true, confidence: 0.92 },
              spaces: [{ id: "study", occupied: true }],
            },
            learning: { candidates: [{ id: "candidate_movie" }], summary: { autoAppliedCount: 0 } },
            mapping: { candidates: [{ thingId: "camera" }], summary: { protectedCandidates: 1 } },
            diagnostics: { findings: [{ id: "latency_budget", severity: "high" }] },
            test: { testCases: [{ id: "dry_run_light" }], summary: { safetyCount: 1 } },
          },
        },
      },
      () => 1010,
    );

    expect(audit.agents).toMatchObject({
      mode: "shadow",
      summary: { agentCount: 3 },
      context: { likelySpace: { id: "study", confidence: 0.92 }, occupiedSpaces: 1 },
      learning: { candidateCount: 1, autoAppliedCount: 0 },
      mapping: { candidateCount: 1, protectedCandidates: 1 },
      diagnostics: { findingCount: 1, highFindings: 1 },
      test: { generatedCount: 1, safetyCount: 1 },
    });
  });
});
