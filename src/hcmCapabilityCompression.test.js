import { describe, expect, it } from "vitest";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import {
  compressReviewToDeviceBoundaries,
  summarizeHomeCapabilities,
  summarizeThingCapabilities,
} from "./hcmCapabilityCompression.js";

describe("HCM capability compression", () => {
  it("summarizes thing capabilities into user-facing boundary buckets", () => {
    const home = createHarnessScenarioHome();
    const light = home.things.find((thing) => thing.id === "living_light");

    expect(summarizeThingCapabilities(light)).toMatchObject({
      total: 3,
      executable: { count: 2 },
      config: { count: 1 },
      protected: { count: 0 },
      label: "可自动 2 / 保护 1",
      primaryState: "protected",
    });
  });

  it("summarizes whole-home capabilities without exposing raw entity noise", () => {
    const summary = summarizeHomeCapabilities(createHarnessScenarioHome().things);

    expect(summary.totals).toMatchObject({
      executable: 8,
      readOnly: 4,
      protected: 2,
      config: 1,
    });
    expect(summary.reviewSurfaceCount).toBe(3);
    expect(summary.deviceStates).toMatchObject({
      executable: 6,
      protected: 3,
      read_only: 2,
    });
  });

  it("compresses unresolved review bindings to device-level surfaces", () => {
    const home = createHarnessScenarioHome();
    const compressed = compressReviewToDeviceBoundaries(home.things, [
      {
        thingId: "living_light",
        thingName: "客厅灯",
        thingType: "switch_panel",
        spaceId: "living",
        entityId: "text.living_light_binding",
        entityName: "互控配置",
        kind: "config",
        valueType: "text",
        reason: "配置项保持禁止",
        suggestedRisk: "high",
      },
      {
        thingId: "living_light",
        thingName: "客厅灯",
        thingType: "switch_panel",
        spaceId: "living",
        entityId: "select.living_light_mode",
        entityName: "模式配置",
        kind: "config",
        valueType: "enum",
        reason: "配置项保持禁止",
        suggestedRisk: "high",
      },
    ]);

    expect(compressed).toEqual([
      expect.objectContaining({
        thingId: "living_light",
        count: 2,
        boundary: expect.objectContaining({
          label: "可自动 2 / 保护 1",
        }),
        topReasons: [{ reason: "配置项保持禁止", count: 2 }],
      }),
    ]);
  });
});
