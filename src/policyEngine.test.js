import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { buildHcmExecutionPlan } from "./hcmExecutor.js";
import { evaluateExecutionPolicy } from "./policyEngine.js";

describe("policy engine", () => {
  it("allows low-risk bounded controls", () => {
    const home = createPolicyHome();
    const executionPlan = buildHcmExecutionPlan(
      [{ thingId: "living_light", capabilityId: "brightness", value: 40 }],
      home,
    );

    const policy = evaluateExecutionPolicy({ executionPlan, source: "chat" });

    expect(policy.ok).toBe(true);
    expect(policy.accepted).toHaveLength(1);
    expect(policy.rejected).toEqual([]);
  });

  it("rejects numeric values outside local policy range before provider execution", () => {
    const home = createPolicyHome();
    const executionPlan = buildHcmExecutionPlan(
      [{ thingId: "master_ac", capabilityId: "set_temperature", value: 35 }],
      home,
    );

    const policy = evaluateExecutionPolicy({ executionPlan, source: "chat" });

    expect(policy.ok).toBe(false);
    expect(policy.rejected).toContainEqual(
      expect.objectContaining({ code: "value_out_of_policy_range", thingId: "master_ac" }),
    );
  });

  it("keeps protected device types blocked even if a bad overlay made them executable", () => {
    const home = createPolicyHome();
    const executionPlan = buildHcmExecutionPlan(
      [{ thingId: "camera", capabilityId: "snapshot", value: true }],
      home,
    );

    const policy = evaluateExecutionPolicy({ executionPlan, source: "chat" });

    expect(policy.ok).toBe(false);
    expect(policy.rejected).toContainEqual(expect.objectContaining({ code: "protected_device_type" }));
  });

  it("requires confirmation for long-running appliance starts", () => {
    const home = createPolicyHome();
    const executionPlan = buildHcmExecutionPlan(
      [{ thingId: "washer", capabilityId: "start", value: true }],
      home,
    );

    const policy = evaluateExecutionPolicy({ executionPlan, source: "chat" });

    expect(policy.ok).toBe(false);
    expect(policy.rejected).toContainEqual(
      expect.objectContaining({ code: "long_running_appliance_requires_confirmation" }),
    );
  });

  it("hard-blocks safety-critical devices even if a provider marks them low risk", () => {
    const result = evaluateExecutionPolicy({
      source: "voice",
      executionPlan: {
        accepted: [
          acceptedItem({
            thing: { id: "ha_lock", name: "入户门锁", type: "lock" },
            capability: {
              id: "power",
              name: "门锁开关",
              policy: { risk: "low", confirmation: "never" },
              binding: { domain: "switch", entityId: "switch.door_lock" },
            },
          }),
          acceptedItem({
            thing: { id: "ha_gas_valve", name: "燃气阀", type: "switch_panel" },
            capability: {
              id: "power",
              name: "开关",
              policy: { risk: "low", confirmation: "never" },
              binding: { domain: "switch", entityId: "switch.gas_valve" },
            },
          }),
        ],
        rejected: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((item) => item.code)).toEqual([
      "protected_device_type",
      "protected_device_name",
    ]);
  });

  it("hard-blocks camera and microphone targets by name when provider type is wrong", () => {
    const result = evaluateExecutionPolicy({
      source: "voice",
      executionPlan: {
        accepted: [
          acceptedItem({
            thing: { id: "misclassified_camera", name: "客厅监控", type: "switch_panel" },
            capability: {
              id: "snapshot",
              name: "摄像头截图",
              policy: { risk: "low", confirmation: "never" },
              binding: { domain: "switch", entityId: "switch.living_camera_snapshot" },
            },
          }),
          acceptedItem({
            thing: { id: "misclassified_mic", name: "书房麦克风", type: "switch_panel" },
            capability: {
              id: "record",
              name: "录音",
              policy: { risk: "low", confirmation: "never" },
              binding: { domain: "switch", entityId: "switch.study_microphone_recording" },
            },
          }),
        ],
        rejected: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ code: "protected_device_name", thingId: "misclassified_camera" }),
      expect.objectContaining({ code: "protected_device_name", thingId: "misclassified_mic" }),
    ]);
  });
});

function createPolicyHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [{ id: "living", name: "客厅" }, { id: "master", name: "主卧" }],
    things: [
      thing("living_light", "客厅灯", "light", "living", [
        capability("brightness", "亮度", "control", "number", "light", "light.living"),
      ]),
      thing("master_ac", "主卧空调", "ac", "master", [
        capability("set_temperature", "设置温度", "control", "number", "climate", "climate.master"),
      ]),
      thing("camera", "客厅摄像头", "camera", "living", [
        capability("snapshot", "截图", "action", "boolean", "button", "button.camera_snapshot"),
      ]),
      thing("washer", "洗衣机", "washer", "living", [
        capability("start", "启动", "control", "boolean", "switch", "switch.washer"),
      ]),
    ],
  });
}

function thing(id, name, type, spaceId, capabilities) {
  return {
    id,
    name,
    type,
    spaceId,
    capabilities,
  };
}

function capability(id, name, kind, valueType, domain, entityId) {
  return {
    id,
    name,
    kind,
    valueType,
    policy: { risk: "low", confirmation: "never", autoExecutable: true },
    binding: { provider: "home_assistant", domain, entityId },
  };
}

function acceptedItem({ thing, capability }) {
  return {
    ok: true,
    thing,
    capability,
    action: { thingId: thing.id, capabilityId: capability.id, value: true },
    serviceCall: {
      domain: capability.binding.domain,
      service: "turn_on",
      serviceData: { entity_id: capability.binding.entityId },
    },
  };
}
