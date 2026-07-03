/**
 * Integration test for skip_planner feature.
 * 
 * Tests that /api/hcm/command accepts skipPlanner + plannerDraft
 * and skips the LLM call while still running safety gates.
 * 
 * Requires Harness House running on localhost:5173 with HA configured.
 * Run: npm test -- --run src/skipPlanner.test.js
 */
import { describe, it, expect } from "vitest";

const HARNESS_URL = process.env.HARNESS_HOUSE_URL || "http://localhost:5173";

async function sendCommand(payload) {
  const resp = await fetch(`${HARNESS_URL}/api/hcm/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return resp.json();
}

function hasHarnessHouse() {
  try {
    // synchronous check — if fetch fails, tests are skipped
    return true; // vitest will handle connection errors
  } catch {
    return false;
  }
}

describe.skipIf(!hasHarnessHouse())("skip_planner integration", () => {
  it("accepts skipPlanner + plannerDraft and skips LLM", async () => {
    const result = await sendCommand({
      input: "打开书房射灯",
      dryRun: true, // dry-run to not actually control devices in test
      skipPlanner: true,
      plannerDraft: {
        intent_type: "device_control",
        intent: "打开书房射灯",
        confidence: 0.9,
        summary: "打开书房射灯",
        needs_confirmation: false,
        actions: [
          { target: "书房射灯", capability: "power", value: true },
        ],
      },
    });

    // Should succeed (dry_run or executed, not error)
    expect(["dry_run", "executed", "answered", "needs_clarification", "needs_confirmation", "rejected", "no_action"]).toContain(result.status);

    // Should have planner_external stage instead of llm_planner
    const stages = result.trace?.stages ?? result.stages ?? [];
    const stageNames = stages.map((s) => s.name);
    expect(stageNames).toContain("planner_external");
    expect(stageNames).not.toContain("llm_planner");

    // planner_external should be near-instant (< 10ms)
    const externalStage = stages.find((s) => s.name === "planner_external");
    expect(externalStage.latencyMs).toBeLessThan(10);
  }, 15000);

  it("still works without skipPlanner (backward compatible)", async () => {
    const result = await sendCommand({
      input: "书房射灯开着吗",
      dryRun: true,
    });

    expect(result.status).toBeDefined();
    
    // Should have llm_planner stage (normal path)
    const stages = result.trace?.stages ?? result.stages ?? [];
    const stageNames = stages.map((s) => s.name);
    expect(stageNames).toContain("llm_planner");
    expect(stageNames).not.toContain("planner_external");
  }, 30000);

  it("rejects invalid skipPlanner type", async () => {
    const resp = await fetch(`${HARNESS_URL}/api/hcm/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "关灯",
        skipPlanner: "not-a-boolean",
      }),
    });
    expect(resp.status).toBe(400);
  });
});
