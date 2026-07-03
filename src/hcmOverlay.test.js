import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import {
  BINDING_REVIEW_DECISIONS,
  applyDefaultRunPolicy,
  applyHcmOverlay,
  createHcmOverlay,
  setBindingReviewDecision,
  setControlEndpointMapping,
  setThingOverride,
  summarizeOverlay,
} from "./hcmOverlay.js";

function createReviewHome() {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [{ id: "living", name: "客厅" }],
    things: [
      {
        id: "ha_switch",
        name: "客厅开关",
        type: "switch_panel",
        spaceId: "living",
        capabilities: [
          {
            id: "left_switch",
            name: "左键",
            kind: "control",
            valueType: "boolean",
            state: false,
            policy: {
              risk: "medium",
              confirmation: "sometimes",
              autoExecutable: false,
              reason: "开关通道语义不清，需要用户确认命名",
            },
            binding: {
              provider: "home_assistant",
              entityId: "switch.living_left",
              domain: "switch",
            },
          },
        ],
      },
    ],
    unresolvedBindings: [
      {
        id: "ha_switch:left_switch",
        thingId: "ha_switch",
        thingName: "客厅开关",
        thingType: "switch_panel",
        spaceId: "living",
        entityId: "switch.living_left",
        entityName: "左键",
        kind: "control",
        valueType: "boolean",
        reason: "开关通道语义不清，需要用户确认命名",
        suggestedRisk: "medium",
        confirmation: "sometimes",
        autoExecutable: false,
      },
    ],
  });
}

describe("hcm overlay", () => {
  it("allows reviewed bindings to become auto executable", () => {
    const overlay = setBindingReviewDecision(createHcmOverlay(), {
      providerId: "home_assistant",
      entityId: "switch.living_left",
      action: BINDING_REVIEW_DECISIONS.ALLOW_AUTO,
      updatedAt: "2026-06-14T00:00:00.000Z",
    });

    const home = applyHcmOverlay(createReviewHome(), overlay);
    const capability = home.things[0].capabilities[0];

    expect(capability.policy).toMatchObject({
      risk: "low",
      confirmation: "never",
      autoExecutable: true,
      overlayDecision: "allow_auto",
    });
    expect(home.stats.autoExecutableCapabilities).toBe(1);
    expect(home.unresolvedBindings).toHaveLength(0);
    expect(home.overlay.bindingOverrideCount).toBe(1);
  });

  it("keeps blocked bindings in the review queue with the user decision", () => {
    const overlay = setBindingReviewDecision(createHcmOverlay(), {
      providerId: "home_assistant",
      entityId: "switch.living_left",
      action: BINDING_REVIEW_DECISIONS.BLOCK,
    });

    const home = applyHcmOverlay(createReviewHome(), overlay);

    expect(home.unresolvedBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: "switch.living_left",
          suggestedRisk: "high",
          confirmation: "always",
          overlayDecision: "block",
        }),
      ]),
    );
    expect(home.review.byRisk.high).toBe(1);
  });

  it("summarizes overlay decisions", () => {
    const overlay = setBindingReviewDecision(createHcmOverlay(), {
      providerId: "home_assistant",
      entityId: "switch.living_left",
      action: BINDING_REVIEW_DECISIONS.REQUIRE_CONFIRMATION,
    });

    expect(summarizeOverlay(overlay)).toMatchObject({
      providerCount: 1,
      bindingOverrideCount: 1,
      decisions: { require_confirmation: 1 },
    });
  });

  it("bulk applies default run policy while protecting risky bindings", () => {
    const home = createReviewHome();
    home.unresolvedBindings.push({
      id: "ha_camera:snapshot",
      thingId: "ha_camera",
      thingName: "猫猫监控",
      thingType: "camera",
      spaceId: "cat_room",
      entityId: "button.camera_snapshot",
      entityName: "截图",
      kind: "action",
      valueType: "event",
      reason: "摄像头动作默认阻断",
      suggestedRisk: "sensitive",
      confirmation: "always",
      autoExecutable: false,
    });

    const { overlay, summary } = applyDefaultRunPolicy(createHcmOverlay(), home, {
      providerId: "home_assistant",
    });

    expect(summary).toMatchObject({
      total: 2,
      allowed: 1,
      protected: 1,
    });
    expect(overlay.providers.home_assistant.bindings["switch.living_left"].decision).toBe("allow_auto");
    expect(overlay.providers.home_assistant.bindings["button.camera_snapshot"].decision).toBe("block");
  });

  it("keeps pet feeder actions protected under default run policy", () => {
    const home = createReviewHome();
    home.things.push({
      id: "cat_feeder",
      name: "猫粮机",
      type: "pet_feeder",
      spaceId: "cat_room",
      capabilities: [
        {
          id: "calibrate",
          name: "宠物喂食器 称重手动校准",
          kind: "action",
          valueType: "event",
          policy: {
            risk: "medium",
            confirmation: "always",
            autoExecutable: false,
            reason: "投喂类动作需要确认",
          },
          binding: {
            provider: "home_assistant",
            entityId: "button.cat_feeder_calibrate",
            domain: "button",
          },
        },
      ],
    });
    home.unresolvedBindings.push({
      id: "cat_feeder:calibrate",
      thingId: "cat_feeder",
      thingName: "猫粮机",
      thingType: "pet_feeder",
      spaceId: "cat_room",
      entityId: "button.cat_feeder_calibrate",
      entityName: "宠物喂食器 称重手动校准",
      kind: "action",
      valueType: "event",
      reason: "投喂类动作需要确认",
      suggestedRisk: "medium",
      confirmation: "always",
      autoExecutable: false,
    });

    const next = applyHcmOverlay(home, createHcmOverlay());
    const capability = next.things.find((thing) => thing.id === "cat_feeder").capabilities[0];

    expect(capability.policy).toMatchObject({
      risk: "high",
      confirmation: "always",
      autoExecutable: false,
      overlayDecision: "default_block",
      overlaySource: "hard_protection",
    });
    expect(next.defaultPolicy).toMatchObject({ allowed: 1, protected: 1 });
  });

  it("does not let stale allow overlays bypass hard protection", () => {
    const home = createReviewHome();
    home.things.push({
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
          policy: {
            risk: "sensitive",
            confirmation: "always",
            autoExecutable: false,
            reason: "摄像头动作默认阻断",
          },
          binding: {
            provider: "home_assistant",
            entityId: "button.camera_snapshot",
            domain: "button",
          },
        },
      ],
    });
    home.unresolvedBindings.push({
      id: "ha_camera:snapshot",
      thingId: "ha_camera",
      thingName: "猫猫监控",
      thingType: "camera",
      entityId: "button.camera_snapshot",
      entityName: "截图",
      kind: "action",
      valueType: "event",
      reason: "摄像头动作默认阻断",
      suggestedRisk: "sensitive",
      confirmation: "always",
      autoExecutable: false,
    });
    const overlay = setBindingReviewDecision(createHcmOverlay(), {
      providerId: "home_assistant",
      entityId: "button.camera_snapshot",
      action: BINDING_REVIEW_DECISIONS.ALLOW_AUTO,
    });

    const next = applyHcmOverlay(home, overlay);
    const cameraCapability = next.things.find((thing) => thing.id === "ha_camera").capabilities[0];

    expect(cameraCapability.policy).toMatchObject({
      risk: "high",
      autoExecutable: false,
      overlayDecision: "default_block",
      overlaySource: "hard_protection",
    });
  });

  it("does not let stale allow overlays expose config domains as executable", () => {
    const home = createReviewHome();
    home.things[0].capabilities.push({
      id: "countdown",
      name: "倒计时",
      kind: "config",
      valueType: "number",
      state: 0,
      policy: {
        risk: "high",
        confirmation: "always",
        autoExecutable: false,
        reason: "配置项禁止由 AI 自动修改",
      },
      binding: {
        provider: "home_assistant",
        entityId: "number.living_countdown",
        domain: "number",
      },
    });
    home.unresolvedBindings.push({
      id: "ha_switch:countdown",
      thingId: "ha_switch",
      thingName: "客厅开关",
      thingType: "switch_panel",
      spaceId: "living",
      entityId: "number.living_countdown",
      entityName: "倒计时",
      kind: "config",
      valueType: "number",
      reason: "配置项禁止由 AI 自动修改",
      suggestedRisk: "high",
      confirmation: "always",
      autoExecutable: false,
    });
    const overlay = setBindingReviewDecision(createHcmOverlay(), {
      providerId: "home_assistant",
      entityId: "number.living_countdown",
      action: BINDING_REVIEW_DECISIONS.ALLOW_AUTO,
    });

    const next = applyHcmOverlay(home, overlay);
    const countdown = next.things[0].capabilities.find((capability) => capability.id === "countdown");

    expect(countdown.policy).toMatchObject({
      risk: "high",
      confirmation: "always",
      autoExecutable: false,
      overlayDecision: "default_block",
      overlaySource: "hard_protection",
    });
    expect(next.stats.autoExecutableCapabilities).toBe(1);
    expect(next.unresolvedBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: "number.living_countdown",
          suggestedRisk: "high",
        }),
      ]),
    );
  });

  it("keeps rebuilt review bindings deduplicated", () => {
    const home = createReviewHome();
    home.things[0].capabilities.push({
      ...home.things[0].capabilities[0],
      binding: {
        ...home.things[0].capabilities[0].binding,
        entityId: "switch.living_left_duplicate",
      },
    });

    const next = applyHcmOverlay(
      home,
      createHcmOverlay({ providers: { home_assistant: { bindings: {}, things: {} } } }),
      { defaultRunPolicy: false },
    );

    expect(next.unresolvedBindings).toHaveLength(1);
  });

  it("applies default run policy without persisting overlay decisions", () => {
    const home = applyHcmOverlay(createReviewHome(), createHcmOverlay());

    expect(home.stats.autoExecutableCapabilities).toBe(1);
    expect(home.unresolvedBindings).toHaveLength(0);
    expect(home.defaultPolicy).toMatchObject({
      enabled: true,
      total: 1,
      allowed: 1,
      protected: 0,
    });
    expect(home.overlay.bindingOverrideCount).toBe(0);
  });

  it("can hide a thing from the HCM overlay", () => {
    const overlay = setThingOverride(createHcmOverlay(), {
      providerId: "home_assistant",
      thingId: "ha_switch",
      patch: { disabled: true },
    });

    const home = applyHcmOverlay(createReviewHome(), overlay);

    expect(home.things).toHaveLength(0);
    expect(home.overlay.disabledThingCount).toBe(1);
  });

  it("can hide a thing from review suggestions without removing it from HCM", () => {
    const overlay = setThingOverride(createHcmOverlay(), {
      providerId: "home_assistant",
      thingId: "ha_switch",
      patch: { reviewHidden: true },
    });

    const home = applyHcmOverlay(createReviewHome(), overlay);

    expect(home.things).toHaveLength(1);
    expect(home.overlay.reviewHiddenThingCount).toBe(1);
    expect(home.overlay.reviewHiddenThingIds).toEqual(["ha_switch"]);
    expect(home.overlay.disabledThingCount).toBe(0);
  });

  it("persists a confirmed logical asset mapping separately from HA entity policy", () => {
    const overlay = setControlEndpointMapping(createHcmOverlay(), {
      providerId: "home_assistant",
      entityId: "switch.living_left",
      patch: {
        status: "bound",
        assetName: "书房射灯",
        spaceId: "study",
        relationType: "relay_control",
      },
    });
    const source = createReviewHome();
    source.spaces.push({ id: "study", name: "书房", aliases: [], provider: null });
    const home = applyHcmOverlay(source, overlay);

    expect(home.overlay.controlMappingCount).toBe(1);
    expect(home.controlGraph.assets).toContainEqual(
      expect.objectContaining({
        id: "asset_study_书房射灯",
        name: "书房射灯",
        spaceId: "study",
        mappingStatus: "confirmed",
      }),
    );
    expect(home.controlGraph.endpoints).toContainEqual(
      expect.objectContaining({
        entityId: "switch.living_left",
        status: "bound",
        mappingSource: "user_override",
      }),
    );
  });
});
