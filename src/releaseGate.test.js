import { describe, expect, it } from "vitest";
import { buildRuntimeStatus, getExecutionMode } from "./releaseGate.js";

describe("release gate", () => {
  it("defaults to dry-run execution", () => {
    expect(getExecutionMode({})).toMatchObject({
      mode: "dry_run",
      realExecutionEnabled: false,
      source: "default",
    });
  });

  it("requires an explicit runtime env var before real execution is enabled", () => {
    expect(getExecutionMode({ HARNESS_EXECUTION_MODE: "real" })).toMatchObject({
      mode: "real",
      realExecutionEnabled: true,
      source: "HARNESS_EXECUTION_MODE",
    });
  });

  it("keeps the legacy real-execution flag compatible", () => {
    expect(getExecutionMode({ HARNESS_REAL_EXECUTION: "true" })).toMatchObject({
      mode: "real",
      realExecutionEnabled: true,
      source: "HARNESS_REAL_EXECUTION",
    });
  });

  it("blocks release readiness when required integrations are missing", () => {
    const status = buildRuntimeStatus({
      env: {},
      haConfigured: false,
      llmConfigured: false,
      hasOnboardingBaseline: true,
      commandAuditEnabled: true,
    });

    expect(status.release).toMatchObject({
      status: "blocked",
      blockerCount: 2,
    });
    expect(status.checks.map((check) => [check.id, check.status])).toContainEqual(["llm_configured", "blocker"]);
    expect(status.checks.map((check) => [check.id, check.status])).toContainEqual(["ha_configured", "blocker"]);
  });

  it("is ready for local alpha when configured, audited, baseline-backed, and dry-run by default", () => {
    const status = buildRuntimeStatus({
      env: {},
      haConfigured: true,
      llmConfigured: true,
      hasOnboardingBaseline: true,
      commandAuditEnabled: true,
    });

    expect(status.release).toMatchObject({
      status: "ready",
      blockerCount: 0,
      warningCount: 0,
    });
    expect(status.execution.mode).toBe("dry_run");
  });

  it("surfaces warnings for real-execution mode or a missing provider baseline", () => {
    const status = buildRuntimeStatus({
      env: { HARNESS_EXECUTION_MODE: "real" },
      haConfigured: true,
      llmConfigured: true,
      hasOnboardingBaseline: false,
      commandAuditEnabled: true,
    });

    expect(status.release).toMatchObject({
      status: "ready_with_warnings",
      blockerCount: 0,
      warningCount: 2,
    });
    expect(status.checks.map((check) => [check.id, check.status])).toContainEqual(["real_execution_default", "warning"]);
    expect(status.checks.map((check) => [check.id, check.status])).toContainEqual(["onboarding_baseline", "warning"]);
  });
});
