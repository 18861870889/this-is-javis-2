import { describe, expect, it } from "vitest";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import {
  detectProactiveOpportunities,
  evaluateInterruptionPolicy,
} from "./proactiveOpportunityDetector.js";

describe("proactive opportunity detector", () => {
  it("suggests confirmation when a room is empty and a light is still on", () => {
    const home = createHarnessScenarioHome();
    home.things.find((thing) => thing.id === "study_presence").capabilities[0].state = false;
    home.things.push({
      id: "study_lamp",
      name: "书房台灯",
      type: "light",
      spaceId: "study",
      capabilities: [{
        id: "power",
        name: "台灯开关",
        kind: "control",
        valueType: "boolean",
        state: true,
        policy: { risk: "low", confirmation: "never", autoExecutable: true },
        binding: { provider: "home_assistant", domain: "light", entityId: "light.study_lamp" },
      }],
    });

    const result = detectProactiveOpportunities({ home, now: () => "2026-07-01T00:00:00.000Z" });

    expect(result).toMatchObject({
      mode: "shadow",
      level: "L1_L2",
      autoExecute: false,
      opportunityCount: 1,
    });
    expect(result.opportunities[0]).toMatchObject({
      type: "unattended_light",
      level: "L2",
      prompt: "书房现在没人，书房台灯还开着，要关吗？",
      safety: {
        autoExecute: false,
        requiresConfirmation: true,
      },
      interruption: { allowed: true },
    });
  });

  it("surfaces routine suggestions as L1 shadow observations", () => {
    const result = detectProactiveOpportunities({
      automationSummary: {
        suggestions: [{
          id: "automation_evening_light",
          title: "晚间的重复操作",
          summary: "检测到 3 次相似成功操作：客厅灯开关",
          status: "shadow",
          confidence: 0.82,
        }],
      },
    });

    expect(result.opportunities[0]).toMatchObject({
      type: "routine_suggestion",
      level: "L1",
      suggestionId: "automation_evening_light",
      safety: {
        autoExecute: false,
        requiresConfirmation: false,
      },
    });
  });

  it("suppresses proactive interruptions during meetings or focus mode", () => {
    expect(evaluateInterruptionPolicy({ level: "L2", risk: "low" }, {
      pcContext: { inMeeting: true, until: "2026-07-01T01:00:00.000Z" },
      now: "2026-07-01T00:00:00.000Z",
    })).toMatchObject({
      allowed: false,
      reason: "pc_meeting_active",
      nextEligibleAt: "2026-07-01T01:00:00.000Z",
    });

    expect(evaluateInterruptionPolicy({ level: "L1", risk: "low" }, {
      pcContext: { focusMode: true },
      now: "2026-07-01T00:00:00.000Z",
    })).toMatchObject({
      allowed: false,
      reason: "pc_focus_mode_active",
    });
  });
});
