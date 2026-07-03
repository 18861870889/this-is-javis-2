import { describe, expect, it } from "vitest";
import {
  createDeviceManifest,
  createManifestRegistry,
  summarizeManifestsForPlanner,
  validateActionAgainstManifest,
  validatePlanSteps,
} from "./deviceRuntime.js";
import { initialDevices, parseCommand } from "./simulator.js";
import { normalizeLlmDraft } from "./llmClient.js";

describe("device manifest and capability registry", () => {
  it("creates explicit capability boundaries for a curtain", () => {
    const manifest = createDeviceManifest(initialDevices.living_curtain);

    expect(manifest).toMatchObject({
      id: "living_curtain",
      type: "curtain",
      source: "simulator",
    });
    expect(manifest.capabilities).toEqual([
      expect.objectContaining({
        name: "set_position",
        valueType: "number",
        min: 0,
        max: 100,
        risk: "low",
      }),
    ]);
  });

  it("rejects unsupported capabilities for a device", () => {
    const registry = createManifestRegistry(initialDevices);
    const result = validateActionAgainstManifest(
      {
        device_id: "living_curtain",
        capability: "set_temperature",
        value: 24,
      },
      registry.living_curtain,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("unsupported_capability");
  });

  it("rejects out-of-range numeric values", () => {
    const registry = createManifestRegistry(initialDevices);
    const result = validateActionAgainstManifest(
      {
        device_id: "living_curtain",
        capability: "set_position",
        value: 180,
      },
      registry.living_curtain,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("value_above_max");
  });

  it("exposes capabilities in planner summaries", () => {
    const devices = summarizeManifestsForPlanner(initialDevices);
    const gasHeater = devices.find((device) => device.id === "gas_heater");

    expect(gasHeater.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "turn_on",
          risk: "high",
          confirmation: "always",
        }),
      ]),
    );
  });
});

describe("plan validation", () => {
  it("keeps valid steps and rejects invalid steps", () => {
    const result = validatePlanSteps(
      [
        {
          id: "ok",
          deviceId: "living_light",
          capability: "set_brightness",
          value: 45,
          risk: "low",
        },
        {
          id: "bad",
          deviceId: "living_light",
          capability: "set_temperature",
          value: 23,
          risk: "low",
        },
      ],
      initialDevices,
    );

    expect(result.validSteps).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("unsupported_capability");
  });

  it("routes laundry intent to balcony drying rack even when current room is study", () => {
    const plan = parseCommand("我要晾衣服", initialDevices, {
      currentRoomId: "study",
      selectedRoomId: "study",
    });

    expect(plan.intent).toBe("dry_laundry");
    expect(plan.steps).toEqual([
      expect.objectContaining({
        deviceId: "drying_rack",
        capability: "set_position",
        value: 100,
      }),
    ]);
  });
});

describe("llm draft normalization", () => {
  it("filters model actions against device capability boundaries", () => {
    const plan = normalizeLlmDraft(
      "准备看电影",
      {
        intent: "movie_scene",
        confidence: 0.9,
        summary: "准备进入观影模式。",
        needs_confirmation: false,
        actions: [
          {
            device_id: "living_tv",
            capability: "turn_on",
            value: true,
            reason: "打开电视。",
          },
          {
            device_id: "living_curtain",
            capability: "set_position",
            value: 180,
            reason: "错误的窗帘位置。",
          },
        ],
      },
      initialDevices,
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      deviceId: "living_tv",
      capability: "turn_on",
      value: true,
    });
    expect(plan.rejectedSteps).toHaveLength(0);
  });
});
