import { describe, expect, it } from "vitest";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import {
  runAgentRuntime,
  runContextAgent,
  runDiagnosticsAgent,
  runLearningAgent,
  runMappingAgent,
  runShadowAgent,
  runTestAgent,
} from "./agentRuntime.js";

describe("agent runtime", () => {
  it("infers room occupancy from HCM presence and motion sensors", () => {
    const context = runContextAgent({
      home: createHarnessScenarioHome(),
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(context.mode).toBe("shadow");
    expect(context.likelySpace).toMatchObject({
      id: "study",
      occupied: true,
      confidence: 0.92,
    });
    expect(context.spaces.find((space) => space.id === "entry")).toMatchObject({
      occupied: false,
      confidence: 0,
    });
  });

  it("creates shadow mapping candidates from unresolved HCM bindings", () => {
    const mapping = runMappingAgent({
      home: createHarnessScenarioHome(),
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(mapping.mode).toBe("shadow");
    expect(mapping.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          thingName: "猫猫监控",
          proposedAction: "protect",
        }),
        expect.objectContaining({
          thingName: "燃气热水器",
          proposedAction: "protect",
        }),
      ]),
    );
  });

  it("diagnoses recent command failures without mutating execution policy", () => {
    const diagnostics = runDiagnosticsAgent({
      home: createHarnessScenarioHome(),
      auditEntries: [
        {
          commandId: "cmd_1",
          input: "打开燃气热水器",
          status: "rejected",
          execution: { simulation: { rejectedCount: 1 } },
          latencyMs: 2300,
        },
      ],
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(diagnostics.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "recent_command_failures" }),
        expect.objectContaining({ id: "service_simulation_rejections" }),
        expect.objectContaining({ id: "latency_budget" }),
      ]),
    );
  });

  it("keeps learning suggestions in shadow mode without auto applying them", () => {
    const learning = runLearningAgent({
      learningMemory: {
        observations: [{ id: "obs_1" }],
        candidates: [
          {
            id: "candidate_movie",
            type: "scene",
            status: "shadow",
            input: "准备看电影",
            confidence: 0.75,
            count: 2,
            actions: [{ thingId: "living_tv" }],
          },
        ],
      },
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(learning).toMatchObject({
      mode: "shadow",
      summary: {
        candidateCount: 1,
        autoAppliedCount: 0,
      },
      candidates: [expect.objectContaining({ input: "准备看电影", autoApply: false })],
    });
  });

  it("generates dry-run regression cases from the current HCM", () => {
    const testAgent = runTestAgent({
      home: createHarnessScenarioHome(),
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(testAgent.mode).toBe("shadow");
    expect(testAgent.testCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "dry_run_control", safety: expect.objectContaining({ realDeviceControl: false }) }),
        expect.objectContaining({ type: "safety_rejection", safety: expect.objectContaining({ realDeviceControl: false }) }),
        expect.objectContaining({ type: "state_query", safety: expect.objectContaining({ realDeviceControl: false }) }),
      ]),
    );
  });

  it("isolates agent failures and marks latency budget overruns", () => {
    expect(
      runShadowAgent("broken", () => {
        throw new Error("boom");
      }),
    ).toMatchObject({
      status: "error",
      mode: "shadow",
      error: "boom",
    });

    let now = 0;
    const slow = runShadowAgent("slow", () => ({ id: "slow_agent", mode: "shadow" }), {
      budgetMs: 5,
      now: () => {
        now += 10;
        return now;
      },
    });

    expect(slow).toMatchObject({
      status: "ok",
      timedOut: true,
      budgetMs: 5,
    });
  });

  it("combines all v0.9 agents into a shadow runtime snapshot", () => {
    const snapshot = runAgentRuntime({
      home: createHarnessScenarioHome(),
      auditEntries: [],
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      version: "0.1",
      mode: "shadow",
      summary: {
        agentCount: 5,
      },
      agents: {
        context: { id: "context_agent" },
        learning: { id: "learning_agent" },
        mapping: { id: "mapping_agent" },
        diagnostics: { id: "diagnostics_agent" },
        test: { id: "test_agent" },
      },
    });
  });
});
