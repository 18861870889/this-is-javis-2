import { describe, expect, it } from "vitest";
import { diffProviderGraphs, planProviderOnboarding } from "./providerOnboarding.js";

describe("provider onboarding", () => {
  it("detects provider-level added devices, entities, and states", () => {
    const diff = diffProviderGraphs(createGraph({ devices: [] }), createGraph({ devices: [lightDevice()] }));

    expect(diff.summary).toMatchObject({
      addedDevices: 1,
      addedEntities: 1,
    });
    expect(diff.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "device.added", id: "device_lamp" }),
        expect.objectContaining({ type: "entity.added", id: "light.study_lamp" }),
        expect.objectContaining({ type: "state.added", id: "light.study_lamp" }),
      ]),
    );
  });

  it("turns a clear new low-risk device into an auto-executable HCM candidate without touching real devices", () => {
    const plan = planProviderOnboarding({
      previousGraph: createGraph({ devices: [] }),
      nextGraph: createGraph({ devices: [lightDevice()] }),
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(plan.summary).toMatchObject({
      candidateCount: 1,
      allowAutoCandidates: 1,
      reviewCount: 0,
    });
    expect(plan.candidates[0]).toMatchObject({
      thingName: "书房台灯",
      proposedAction: "allow_auto_candidate",
      requiresReview: false,
      simulation: {
        ok: true,
      },
      overlayProposals: [expect.objectContaining({ decision: "allow_auto", entityId: "light.study_lamp" })],
    });
  });

  it("protects new high-risk, privacy, and configuration capabilities", () => {
    const plan = planProviderOnboarding({
      previousGraph: createGraph({ devices: [] }),
      nextGraph: createGraph({
        devices: [gasHeaterDevice(), cameraDevice(), passwordTextDevice()],
      }),
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(plan.summary.protectCount).toBe(3);
    expect(plan.reviewItems.map((item) => item.thingName)).toEqual(
      expect.arrayContaining(["燃气热水器", "猫猫监控", "门锁密码配置"]),
    );
    expect(plan.overlayProposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: "switch.gas_water_heater", decision: "block" }),
        expect.objectContaining({ entityId: "camera.cat_camera", decision: "block" }),
        expect.objectContaining({ entityId: "text.door_lock_password", decision: "block" }),
      ]),
    );
  });

  it("detects rename, room move, and media supported_features changes while preserving entity identity", () => {
    const previousGraph = createGraph({
      devices: [speakerDevice({ name: "客厅音箱", areaId: "living", supportedFeatures: 1 })],
    });
    const nextGraph = createGraph({
      devices: [speakerDevice({ name: "卧室音箱", areaId: "master", supportedFeatures: 4096 })],
    });

    const plan = planProviderOnboarding({
      previousGraph,
      nextGraph,
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(plan.diff.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "device.changed", id: "device_speaker" }),
        expect.objectContaining({
          type: "state.changed",
          id: "media_player.xiaoai",
          changes: expect.arrayContaining([expect.objectContaining({ field: "supported_features", from: 1, to: 4096 })]),
        }),
      ]),
    );
    expect(plan.hcmEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thing.renamed" }),
        expect.objectContaining({ type: "thing.moved" }),
        expect.objectContaining({ type: "binding.changed" }),
      ]),
    );
    expect(plan.candidates[0].overlayProposals[0]).toMatchObject({
      entityId: "media_player.xiaoai",
      decision: "allow_auto",
    });
  });

  it("marks removed entities and capabilities so they cannot stay exposed to the planner", () => {
    const previousGraph = createGraph({ devices: [lightDevice()] });
    const nextGraph = createGraph({ devices: [] });
    const plan = planProviderOnboarding({
      previousGraph,
      nextGraph,
      generatedAt: "2026-06-17T12:00:00.000Z",
    });

    expect(plan.diff.summary).toMatchObject({
      removedDevices: 1,
      removedEntities: 1,
    });
    expect(plan.removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thing.removed", action: "remove_from_planner" }),
      ]),
    );
  });
});

function createGraph({ devices = [] } = {}) {
  const areas = [
    { area_id: "living", name: "客厅" },
    { area_id: "study", name: "书房" },
    { area_id: "master", name: "主卧" },
    { area_id: "kitchen", name: "厨房" },
    { area_id: "cat", name: "猫猫房" },
  ];
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-06-17T12:00:00.000Z",
    areas,
    devices: devices.map((device) => device.device),
    entities: devices.flatMap((device) => device.entities),
    states: devices.flatMap((device) => device.states),
  };
}

function lightDevice() {
  return {
    device: {
      id: "device_lamp",
      area_id: "study",
      identifiers: [["xiaomi_home", "lamp_1"]],
      name: "书房台灯",
      manufacturer: "Xiaomi",
      model: "light",
    },
    entities: [
      {
        device_id: "device_lamp",
        entity_id: "light.study_lamp",
        platform: "xiaomi_home",
        original_name: "书房台灯",
      },
    ],
    states: [{ entity_id: "light.study_lamp", state: "off", attributes: { friendly_name: "书房台灯" } }],
  };
}

function gasHeaterDevice() {
  return {
    device: {
      id: "device_gas",
      area_id: "kitchen",
      identifiers: [["xiaomi_home", "gas_1"]],
      name: "燃气热水器",
      manufacturer: "Xiaomi",
      model: "gas.heater",
    },
    entities: [
      {
        device_id: "device_gas",
        entity_id: "switch.gas_water_heater",
        platform: "xiaomi_home",
        original_name: "燃气热水器 电源",
      },
    ],
    states: [{ entity_id: "switch.gas_water_heater", state: "off", attributes: { friendly_name: "燃气热水器" } }],
  };
}

function cameraDevice() {
  return {
    device: {
      id: "device_camera",
      area_id: "cat",
      identifiers: [["xiaomi_home", "camera_1"]],
      name: "猫猫监控",
      manufacturer: "Xiaomi",
      model: "camera",
    },
    entities: [
      {
        device_id: "device_camera",
        entity_id: "camera.cat_camera",
        platform: "xiaomi_home",
        original_name: "猫猫监控",
      },
    ],
    states: [{ entity_id: "camera.cat_camera", state: "idle", attributes: { friendly_name: "猫猫监控" } }],
  };
}

function passwordTextDevice() {
  return {
    device: {
      id: "device_lock_password",
      area_id: "living",
      identifiers: [["xiaomi_home", "lock_1"]],
      name: "门锁密码配置",
      manufacturer: "Xiaomi",
      model: "lock",
    },
    entities: [
      {
        device_id: "device_lock_password",
        entity_id: "text.door_lock_password",
        platform: "xiaomi_home",
        original_name: "密码",
      },
    ],
    states: [{ entity_id: "text.door_lock_password", state: "", attributes: { friendly_name: "密码" } }],
  };
}

function speakerDevice({ name, areaId, supportedFeatures }) {
  return {
    device: {
      id: "device_speaker",
      area_id: areaId,
      identifiers: [["xiaomi_home", "speaker_1"]],
      name,
      manufacturer: "Xiaomi",
      model: "speaker",
    },
    entities: [
      {
        device_id: "device_speaker",
        entity_id: "media_player.xiaoai",
        platform: "xiaomi_home",
        original_name: "播放控制",
      },
    ],
    states: [
      {
        entity_id: "media_player.xiaoai",
        state: "idle",
        attributes: { friendly_name: name, supported_features: supportedFeatures },
      },
    ],
  };
}
