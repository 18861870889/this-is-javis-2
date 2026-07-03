import { describe, expect, it } from "vitest";
import { createHcmHome, summarizeBindingRecommendations, summarizeBindingReview } from "./hcm.js";

describe("harness capability model", () => {
  it("summarizes unresolved bindings for review queues", () => {
    const review = summarizeBindingReview([
      {
        thingId: "switch_panel",
        thingName: "沙发右侧一号开关",
        thingType: "switch_panel",
        kind: "control",
        suggestedRisk: "medium",
        reason: "开关通道语义不清，需要用户确认命名",
      },
      {
        thingId: "camera",
        thingName: "猫猫的监控",
        thingType: "camera",
        kind: "action",
        suggestedRisk: "sensitive",
        reason: "摄像头动作默认阻断",
      },
      {
        thingId: "switch_panel_2",
        thingName: "主卫开关",
        thingType: "switch_panel",
        kind: "config",
        suggestedRisk: "high",
        reason: "设备配置项禁止由 AI 自动修改",
      },
    ]);

    expect(review.total).toBe(3);
    expect(review.byRisk).toMatchObject({ medium: 1, sensitive: 1, high: 1 });
    expect(review.byKind).toMatchObject({ control: 1, action: 1, config: 1 });
    expect(review.byThingType.switch_panel).toBe(2);
    expect(review.topReasons[0]).toEqual(
      expect.objectContaining({ reason: "开关通道语义不清，需要用户确认命名" }),
    );
  });

  it("attaches a review summary to HCM homes", () => {
    const home = createHcmHome({
      things: [
        {
          id: "living_light",
          name: "客厅灯",
          type: "light",
          spaceId: "living",
        },
      ],
      unresolvedBindings: [
        {
          thingId: "living_light",
          thingName: "客厅灯",
          thingType: "light",
          kind: "control",
          suggestedRisk: "medium",
          reason: "可控实体需要语义确认",
        },
      ],
    });

    expect(home.review).toMatchObject({
      total: 1,
      byRisk: { medium: 1 },
    });
    expect(home.capabilitySummary).toMatchObject({
      totals: {
        executable: 0,
        confirmable: 0,
        readOnly: 0,
        protected: 0,
        config: 0,
      },
      reviewSurfaceCount: 0,
    });
  });

  it("recommends device-level adjustments instead of per-entity review noise", () => {
    const recommendations = summarizeBindingRecommendations([
      {
        thingId: "camera",
        thingName: "猫猫监控",
        thingType: "camera",
        kind: "action",
        suggestedRisk: "sensitive",
        reason: "摄像头动作默认阻断",
        entityName: "截图",
      },
      {
        thingId: "camera",
        thingName: "猫猫监控",
        thingType: "camera",
        kind: "config",
        suggestedRisk: "high",
        reason: "配置/文本字段禁止自动写入",
        entityName: "录像配置",
      },
      {
        thingId: "switch",
        thingName: "沙发右侧一号开关",
        thingType: "switch_panel",
        kind: "control",
        suggestedRisk: "medium",
        reason: "开关通道语义不清，需要用户确认命名",
        entityName: "左键",
      },
    ]);

    expect(recommendations.totalDevices).toBe(2);
    expect(recommendations.devices[0]).toMatchObject({
      thingName: "猫猫监控",
      severity: "critical",
      count: 2,
    });
    expect(recommendations.devices[1]).toMatchObject({
      thingName: "沙发右侧一号开关",
      severity: "medium",
    });
  });
});
