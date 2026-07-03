import { describe, expect, it } from "vitest";
import {
  captureHomeEventSnapshot,
  createAutomationMemory,
  deriveAutomationSuggestions,
  simulateAutomationSuggestion,
  summarizeAutomationSuggestions,
  updateAutomationSuggestionDecision,
} from "./automationSuggestionEngine.js";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";

describe("automation suggestion engine", () => {
  it("captures provider state changes without controlling devices", () => {
    const first = createHarnessScenarioHome();
    const baseline = captureHomeEventSnapshot(createAutomationMemory(), first, { capturedAt: "2026-06-18T12:00:00.000Z" });
    const second = structuredClone(first);
    second.things.find((thing) => thing.id === "study_presence").capabilities[0].state = false;
    const captured = captureHomeEventSnapshot(baseline.memory, second, { capturedAt: "2026-06-18T12:01:00.000Z" });

    expect(captured.events).toEqual([
      expect.objectContaining({
        type: "occupancy.changed",
        thingId: "study_presence",
        previousValue: true,
        value: false,
        active: false,
      }),
    ]);
  });

  it("requires two successful matching actions before creating a suggestion", () => {
    const home = createHarnessScenarioHome();
    const entry = auditEntry("cmd-1", "2026-06-18T20:10:00.000Z");
    expect(deriveAutomationSuggestions({ memory: createAutomationMemory(), auditEntries: [entry], home })).toEqual([]);

    const suggestions = deriveAutomationSuggestions({
      memory: createAutomationMemory(),
      auditEntries: [entry, auditEntry("cmd-2", "2026-06-17T20:05:00.000Z")],
      home,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      status: "shadow",
      occurrences: 2,
      safety: { autoApply: false, realDeviceControl: false },
      actions: [{ thingId: "living_light", capabilityId: "living_light_switch", value: true }],
    });
  });

  it("does not create suggestions from failed commands or missing action values", () => {
    const home = createHarnessScenarioHome();
    const failed = { ...auditEntry("cmd-1", "2026-06-18T20:10:00.000Z"), status: "rejected" };
    const missingValue = auditEntry("cmd-2", "2026-06-17T20:05:00.000Z");
    delete missingValue.execution.services[0].value;

    expect(deriveAutomationSuggestions({ memory: createAutomationMemory(), auditEntries: [failed, failed, missingValue, missingValue], home })).toEqual([]);
  });

  it("simulates a suggestion without real device control", () => {
    const home = createHarnessScenarioHome();
    const suggestion = deriveAutomationSuggestions({
      memory: createAutomationMemory(),
      auditEntries: [auditEntry("cmd-1", "2026-06-18T20:10:00.000Z"), auditEntry("cmd-2", "2026-06-17T20:05:00.000Z")],
      home,
    })[0];
    const preview = simulateAutomationSuggestion(suggestion, home);

    expect(preview).toMatchObject({ mode: "preview", realDeviceControl: false, ok: true });
    expect(preview.accepted[0].serviceCall).toMatchObject({ domain: "switch", service: "turn_on" });
  });

  it("persists review decisions without activating a rule", () => {
    const memory = updateAutomationSuggestionDecision(createAutomationMemory(), "automation_1", "reviewed", {
      updatedAt: "2026-06-18T12:00:00.000Z",
    });
    expect(memory.decisions.automation_1).toEqual({ status: "reviewed", updatedAt: "2026-06-18T12:00:00.000Z" });
    expect(memory.mode).toBe("shadow");
  });

  it("surfaces accepted suggestions as active shadow-mode guidance", () => {
    const home = createHarnessScenarioHome();
    const baseMemory = createAutomationMemory();
    const initialSuggestion = deriveAutomationSuggestions({
      memory: baseMemory,
      auditEntries: [auditEntry("cmd-1", "2026-06-18T20:10:00.000Z"), auditEntry("cmd-2", "2026-06-17T20:05:00.000Z")],
      home,
    })[0];
    const memory = updateAutomationSuggestionDecision(baseMemory, initialSuggestion.id, "accepted", {
      updatedAt: "2026-06-18T12:00:00.000Z",
    });
    const suggestions = deriveAutomationSuggestions({
      memory,
      auditEntries: [auditEntry("cmd-1", "2026-06-18T20:10:00.000Z"), auditEntry("cmd-2", "2026-06-17T20:05:00.000Z")],
      home,
    });
    const summary = summarizeAutomationSuggestions(memory, suggestions);

    expect(suggestions[0]).toMatchObject({
      id: initialSuggestion.id,
      status: "accepted",
      safety: {
        autoApply: false,
        realDeviceControl: false,
        reason: "用户已确认该建议，但执行时仍必须经过 HCM safety/policy/audit",
      },
    });
    expect(summary.acceptedCount).toBe(1);
    expect(summary.activeSuggestions).toEqual([suggestions[0]]);
    expect(summary.mode).toBe("shadow");
  });
});

function auditEntry(commandId, startedAt) {
  return {
    commandId,
    input: "打开客厅灯",
    status: "executed",
    startedAt,
    execution: {
      services: [
        {
          thingId: "living_light",
          thingName: "客厅灯",
          capabilityId: "living_light_switch",
          capabilityName: "客厅灯开关",
          service: "switch.turn_on",
          value: true,
        },
      ],
    },
  };
}
