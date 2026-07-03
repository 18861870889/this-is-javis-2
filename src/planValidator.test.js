import { describe, expect, it } from "vitest";
import { initialDevices } from "./simulator.js";
import { validatePlanDraft } from "./planValidator.js";

describe("plan validator", () => {
  it("blocks a plan when every step violates capability boundaries", () => {
    const report = validatePlanDraft({
      devices: initialDevices,
      summary: "准备调整窗帘。",
      steps: [
        {
          id: "bad",
          deviceId: "living_curtain",
          deviceName: "客厅窗帘",
          capability: "set_position",
          value: 180,
          risk: "low",
        },
      ],
    });

    expect(report.status).toBe("blocked");
    expect(report.steps).toHaveLength(0);
    expect(report.rejectedSteps).toHaveLength(1);
    expect(report.summary).toContain("能力边界拦截");
  });

  it("requires confirmation for high-risk capabilities", () => {
    const report = validatePlanDraft({
      devices: initialDevices,
      summary: "准备打开燃气热水器。",
      steps: [
        {
          id: "heater",
          deviceId: "gas_heater",
          deviceName: "燃气热水器",
          capability: "turn_on",
          value: true,
          risk: "high",
        },
      ],
    });

    expect(report.status).toBe("valid");
    expect(report.confirmationRequired).toBe(true);
    expect(report.risk.highRisk).toBe(true);
  });

  it("keeps valid low-risk plans confirmation-free", () => {
    const report = validatePlanDraft({
      devices: initialDevices,
      summary: "准备关闭客厅灯。",
      steps: [
        {
          id: "light",
          deviceId: "living_light",
          deviceName: "客厅主灯",
          capability: "turn_off",
          value: false,
          risk: "low",
        },
      ],
    });

    expect(report.status).toBe("valid");
    expect(report.confirmationRequired).toBe(false);
    expect(report.steps).toHaveLength(1);
  });
});
