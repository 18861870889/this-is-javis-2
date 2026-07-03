import { describe, expect, it } from "vitest";
import { reviewDecisionBeforeExecution } from "./decisionReview.js";

describe("decision review", () => {
  it("passes a fully simulated low-risk plan without executing devices", () => {
    const review = reviewDecisionBeforeExecution({
      input: "打开书房射灯",
      plan: {
        kind: "real_hcm",
        actions: [{ thingId: "study_panel", capabilityId: "study_spot", value: true }],
        grounding: { status: "resolved" },
      },
      executionPlan: { accepted: [{}], rejected: [] },
      policyPlan: { accepted: [{}], rejected: [] },
      simulation: { ok: true, rejected: [] },
    });

    expect(review).toMatchObject({
      version: "0.22",
      status: "ready",
      ok: true,
      blocksExecution: false,
      issues: [],
    });
  });

  it("blocks unresolved control plans before execution", () => {
    const review = reviewDecisionBeforeExecution({
      input: "打开射灯",
      plan: {
        kind: "unresolved_control",
        requiresClarification: true,
        summary: "射灯有多个候选",
        actions: [],
        grounding: { status: "ambiguous", ambiguity: { reason: "多个射灯候选" } },
      },
      executionPlan: { accepted: [], rejected: [] },
      policyPlan: { accepted: [], rejected: [] },
      simulation: { ok: true, rejected: [] },
    });

    expect(review).toMatchObject({
      status: "needs_clarification",
      ok: false,
      blocksExecution: true,
      recovery: { mode: "ask_clarification", message: "射灯有多个候选" },
    });
    expect(review.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["planner_requires_clarification", "unresolved_control", "empty_control_plan"]),
    );
  });

  it("turns provider simulation failures into adapter diagnosis instead of execution", () => {
    const review = reviewDecisionBeforeExecution({
      input: "小爱音箱停止播放音乐",
      plan: {
        kind: "real_hcm",
        actions: [{ thingId: "xiaoai_speaker", capabilityId: "speaker_playback", value: false }],
        grounding: { status: "resolved" },
      },
      executionPlan: { accepted: [{}], rejected: [] },
      policyPlan: { accepted: [{}], rejected: [] },
      simulation: {
        ok: false,
        rejected: [{ code: "unsupported_service", message: "media_player.media_pause is not supported" }],
      },
    });

    expect(review).toMatchObject({
      status: "blocked",
      blocksExecution: true,
      recovery: { mode: "adapter_diagnosis" },
    });
    expect(review.issues[0]).toMatchObject({ code: "simulation_unsupported_service", severity: "high" });
  });

  it("asks before skipping offline devices when part of a multi-device plan is executable", () => {
    const review = reviewDecisionBeforeExecution({
      input: "关闭餐厅灯",
      plan: {
        kind: "real_hcm",
        actions: [
          { thingId: "dining_chandelier", capabilityId: "power", value: false },
          { thingId: "dining_spot", capabilityId: "power", value: false },
        ],
        grounding: { status: "resolved" },
      },
      executionPlan: { accepted: [{}, {}], rejected: [] },
      policyPlan: { accepted: [{}, {}], rejected: [] },
      simulation: {
        ok: false,
        checks: [
          { ok: false, code: "thing_offline", thingName: "餐厅吊灯", message: "Aqara 妙控开关 S1E is offline" },
          { ok: true, code: "supported", thingName: "餐厅射灯", message: "supported" },
        ],
        rejected: [{ code: "thing_offline", thingName: "餐厅吊灯", message: "Aqara 妙控开关 S1E is offline" }],
      },
    });

    expect(review).toMatchObject({
      status: "partial_available",
      blocksExecution: true,
      recovery: { mode: "ask_partial_execution_confirmation" },
    });
    expect(review.recovery.message).toContain("是否跳过不可用设备");
    expect(review.issues[0]).toMatchObject({ code: "simulation_thing_offline", severity: "medium" });
  });

  it("answers read-only plans without requiring executable actions", () => {
    const review = reviewDecisionBeforeExecution({
      input: "玄关人体目前是什么状态",
      plan: { kind: "hcm_state_query", actions: [], stateQuery: { thingId: "entry_motion" } },
      executionPlan: { accepted: [], rejected: [] },
      policyPlan: { accepted: [], rejected: [] },
      simulation: { ok: true, rejected: [] },
    });

    expect(review).toMatchObject({ status: "answer_only", ok: true, blocksExecution: false });
  });
});
