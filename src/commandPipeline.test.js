import { describe, expect, it } from "vitest";
import { planCommand } from "./commandPipeline.js";
import { createPlan, initialDevices } from "./simulator.js";

const noWait = () => Promise.resolve();
const clock = (() => {
  let time = 0;
  return () => {
    time += 10;
    return time;
  };
})();

describe("command pipeline", () => {
  it("returns structured timing for fast path commands", async () => {
    const result = await planCommand({
      input: "关客厅灯",
      devices: initialDevices,
      currentRoomId: "living",
      selectedRoomId: "living",
      llmStatus: { configured: true },
      requestRealPlan: async () => {
        throw new Error("should not call llm");
      },
      wait: noWait,
      clock,
    });

    expect(result.plan.intent).toBe("control_device");
    expect(result.commandResult).toMatchObject({
      status: "planned",
      path: "fast",
    });
    expect(result.commandResult.stages.map((stage) => stage.name)).toEqual([
      "router",
      "fast_path_delay",
      "safety_gate",
    ]);
  });

  it("answers specific sensor state questions instead of whole-home summaries", async () => {
    const result = await planCommand({
      input: "玄关人体目前是什么状态",
      devices: initialDevices,
      currentRoomId: "study",
      selectedRoomId: "study",
      llmStatus: { configured: true },
      requestRealPlan: async () => {
        throw new Error("should not call llm");
      },
      wait: noWait,
      clock,
    });

    expect(result.plan).toMatchObject({
      path: "fast",
      intent: "query_device_state",
      summary: "玄关人体传感器：检测到有人。",
    });
  });

  it("uses real LLM when local route is llm-sim and model is configured", async () => {
    const result = await planCommand({
      input: "准备看电影",
      devices: initialDevices,
      currentRoomId: "study",
      selectedRoomId: "study",
      llmStatus: { configured: true },
      requestRealPlan: async () =>
        createPlan({
          input: "准备看电影",
          path: "llm-real",
          intent: "movie_scene",
          confidence: 0.9,
          devices: initialDevices,
          steps: [],
          summary: "真实 LLM 计划。",
        }),
      wait: noWait,
      clock,
    });

    expect(result.plan.path).toBe("llm-real");
    expect(result.commandResult.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "llm_planner", mode: "real" })]),
    );
  });

  it("keeps the local llm-sim plan when real LLM fails", async () => {
    const result = await planCommand({
      input: "准备看电影",
      devices: initialDevices,
      currentRoomId: "study",
      selectedRoomId: "study",
      llmStatus: { configured: true },
      requestRealPlan: async () => {
        throw new Error("timeout");
      },
      wait: noWait,
      clock,
    });

    expect(result.plan.path).toBe("llm-sim");
    expect(result.commandResult.fallbackError).toBe("timeout");
    expect(result.commandResult.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fallback_delay" })]),
    );
  });
});
