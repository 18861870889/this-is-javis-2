import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { validateHcmAction } from "./hcmExecutor.js";

function createExecutorHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    things: [
      {
        id: "ha_light",
        name: "客厅灯",
        type: "switch_panel",
        spaceId: "living",
        capabilities: [
          {
            id: "light_switch",
            name: "灯开关",
            kind: "control",
            valueType: "boolean",
            policy: { risk: "low", confirmation: "never", autoExecutable: true },
            binding: { provider: "home_assistant", domain: "switch", entityId: "switch.living_light" },
          },
        ],
      },
      {
        id: "ha_camera",
        name: "猫猫监控",
        type: "camera",
        spaceId: "cat_room",
        capabilities: [
          {
            id: "snapshot",
            name: "截图",
            kind: "action",
            valueType: "event",
            policy: { risk: "sensitive", confirmation: "always", autoExecutable: false },
            binding: { provider: "home_assistant", domain: "button", entityId: "button.camera_snapshot" },
          },
        ],
      },
      {
        id: "ha_speaker",
        name: "小爱音箱Pro",
        type: "tv",
        spaceId: "living",
        capabilities: [
          {
            id: "speaker",
            name: "音箱",
            kind: "control",
            valueType: "unknown",
            policy: { risk: "low", confirmation: "never", autoExecutable: true },
            binding: { provider: "home_assistant", domain: "media_player", entityId: "media_player.xiaoai", supportedFeatures: 1 },
          },
        ],
      },
    ],
  });
}

describe("hcm executor", () => {
  it("maps low-risk HCM actions to Home Assistant services", () => {
    const result = validateHcmAction(
      { thingId: "ha_light", capabilityId: "light_switch", value: true },
      createExecutorHome(),
    );

    expect(result).toMatchObject({
      ok: true,
      serviceCall: {
        domain: "switch",
        service: "turn_on",
        serviceData: { entity_id: "switch.living_light" },
      },
    });
  });

  it("blocks protected capabilities even when an action references them", () => {
    const result = validateHcmAction(
      { thingId: "ha_camera", capabilityId: "snapshot", value: true },
      createExecutorHome(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "policy_blocked",
    });
  });

  it("maps media player stop intent to pause instead of power off", () => {
    const result = validateHcmAction(
      { thingId: "ha_speaker", capabilityId: "speaker", value: false },
      createExecutorHome(),
    );

    expect(result).toMatchObject({
      ok: true,
      serviceCall: {
        domain: "media_player",
        service: "media_pause",
        serviceData: { entity_id: "media_player.xiaoai" },
      },
    });
  });

  it("falls back to media_stop when pause is not supported but stop is", () => {
    const home = createExecutorHome();
    const speaker = home.things.find((thing) => thing.id === "ha_speaker");
    speaker.capabilities[0].binding.supportedFeatures = 4096;

    const result = validateHcmAction(
      { thingId: "ha_speaker", capabilityId: "speaker", value: false },
      home,
    );

    expect(result).toMatchObject({
      ok: true,
      serviceCall: {
        domain: "media_player",
        service: "media_stop",
      },
    });
  });

  it("accepts provider-neutral bindings for compilation by the active adapter", () => {
    const home = createHcmHome({
      provider: { id: "matter", name: "Matter" },
      things: [{
        id: "matter_light",
        name: "Matter 灯",
        type: "light",
        spaceId: "living",
        provider: { id: "matter", deviceId: "device-1" },
        capabilities: [{
          id: "turn_on",
          name: "打开",
          kind: "control",
          valueType: "boolean",
          policy: { risk: "low", confirmation: "never", autoExecutable: true },
          binding: { provider: "matter", targetId: "device-1", operation: "on_off.on" },
        }],
      }],
    });

    expect(validateHcmAction(
      { thingId: "matter_light", capabilityId: "turn_on", value: true },
      home,
    )).toMatchObject({
      ok: true,
      action: { providerId: "matter", targetId: "device-1", value: true },
      serviceCall: null,
    });
  });
});
