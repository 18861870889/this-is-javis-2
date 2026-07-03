import { describe, expect, it } from "vitest";
import {
  buildServiceCall,
  createHomeAssistantAdapter,
  executeHomeAssistantAction,
  homeAssistantGraphToProviderSnapshot,
  mapHomeAssistantState,
} from "./homeAssistantAdapter.js";
import { runProviderAdapterContract, validateProviderAdapter } from "./providerAdapterSdk.js";
import { mapHomeAssistantGraphToHcm } from "./homeAssistantCatalog.js";

describe("home assistant adapter", () => {
  it("reports unconfigured status without exposing secrets", () => {
    const adapter = createHomeAssistantAdapter();

    expect(adapter.getStatus()).toEqual({
      configured: false,
      baseUrl: null,
    });
    expect(adapter.isConfigured()).toBe(false);
    expect(validateProviderAdapter(adapter).ok).toBe(true);
  });

  it("normalizes the HA registry graph into a provider-neutral snapshot", () => {
    const snapshot = homeAssistantGraphToProviderSnapshot(createHaGraph());

    expect(snapshot).toMatchObject({
      version: "1.0",
      provider: { id: "home_assistant" },
      spaces: [{ externalId: "living", name: "客厅" }],
      devices: [expect.objectContaining({ externalId: "device-1", spaceId: "living" })],
      entities: [expect.objectContaining({ externalId: "light.living_room", deviceId: "device-1" })],
      states: [expect.objectContaining({ targetId: "light.living_room", value: "on" })],
    });
  });

  it("attaches provider evidence to HCM capabilities", () => {
    const home = mapHomeAssistantGraphToHcm(createHaGraph());
    const capability = home.things[0].capabilities[0];

    expect(capability.evidence).toMatchObject({
      providerId: "home_assistant",
      targetId: "light.living_room",
      source: "registry_and_state",
      confidence: 0.95,
    });
    expect(capability.evidence.commands).toContain("light.turn_on");
  });

  it("passes the common adapter contract with fixture discovery and never posts a service", async () => {
    const calls = [];
    const graph = createHaGraph();
    const adapter = createHomeAssistantAdapter({
      baseUrl: "http://ha.local:8123",
      token: "secret",
      graphLoader: async () => structuredClone(graph),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return {
          ok: true,
          async json() {
            return graph.states[0];
          },
        };
      },
    });

    const result = await runProviderAdapterContract(adapter, {
      sampleTargetId: "light.living_room",
      sampleAction: { entityId: "light.living_room", capability: "turn_off", value: false },
    });

    expect(result.ok).toBe(true);
    expect(calls.every((call) => call.options.method !== "POST")).toBe(true);
  });

  it("discovers entities from /api/states and maps capabilities", async () => {
    const adapter = createHomeAssistantAdapter({
      baseUrl: "http://ha.local:8123/",
      token: "secret",
      fetchImpl: async (url, options) => {
        expect(url).toBe("http://ha.local:8123/api/states");
        expect(options.headers.Authorization).toBe("Bearer secret");
        return {
          ok: true,
          async json() {
            return [
              {
                entity_id: "light.living_room",
                state: "on",
                attributes: {
                  friendly_name: "客厅灯",
                  brightness: 128,
                },
              },
              {
                entity_id: "cover.balcony_drying_rack",
                state: "open",
                attributes: {
                  friendly_name: "阳台晾衣杆",
                  current_position: 70,
                },
              },
            ];
          },
        };
      },
    });

    const entities = await adapter.discoverEntities();

    expect(entities).toHaveLength(2);
    expect(entities[0]).toMatchObject({
      entityId: "light.living_room",
      suggestedDevice: {
        type: "light",
        roomId: "living",
        on: true,
      },
    });
    expect(entities[0].manifest.capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "set_brightness", max: 100 })]),
    );
    expect(entities[1]).toMatchObject({
      suggestedDevice: {
        type: "drying_rack",
        roomId: "balcony",
        position: 70,
      },
    });
  });

  it("maps binary sensors to sensitive read-only device manifests", () => {
    const mapped = mapHomeAssistantState({
      entity_id: "binary_sensor.front_door",
      state: "on",
      attributes: {
        friendly_name: "入户门",
        device_class: "door",
      },
    });

    expect(mapped.suggestedDevice).toMatchObject({
      type: "door_sensor",
      risk: "sensitive",
      open: true,
    });
    expect(mapped.manifest.capabilities).toEqual([]);
  });

  it("maps unsupported Home Assistant domains as read-only entities", () => {
    const sensor = mapHomeAssistantState({
      entity_id: "sensor.sun_next_dawn",
      state: "2026-06-13T20:28:37+00:00",
      attributes: {
        friendly_name: "Sun Next dawn",
        device_class: "timestamp",
      },
    });
    const update = mapHomeAssistantState({
      entity_id: "update.home_assistant_core_update",
      state: "off",
      attributes: {
        friendly_name: "Home Assistant Core Update",
      },
    });

    expect(sensor.suggestedDevice).toMatchObject({
      type: "generic_sensor",
      value: "2026-06-13T20:28:37+00:00",
    });
    expect(sensor.manifest.capabilities).toEqual([]);
    expect(update.suggestedDevice).toMatchObject({
      type: "generic_entity",
      value: "off",
    });
    expect(update.manifest.capabilities).toEqual([]);
  });

  it("throws when discovery is requested without configuration", async () => {
    const adapter = createHomeAssistantAdapter();

    await expect(adapter.discoverEntities()).rejects.toThrow("not configured");
  });

  it("builds low-risk service calls for supported domains", () => {
    const light = mapHomeAssistantState({
      entity_id: "light.living_room",
      state: "on",
      attributes: { friendly_name: "客厅灯" },
    });
    const curtain = mapHomeAssistantState({
      entity_id: "cover.living_room_curtain",
      state: "open",
      attributes: { friendly_name: "客厅窗帘", current_position: 80 },
    });

    expect(buildServiceCall(light, { capability: "set_brightness", value: 45 })).toEqual({
      domain: "light",
      service: "turn_on",
      serviceData: {
        entity_id: "light.living_room",
        brightness_pct: 45,
      },
    });
    expect(buildServiceCall(curtain, { capability: "set_position", value: 20 })).toEqual({
      domain: "cover",
      service: "set_cover_position",
      serviceData: {
        entity_id: "cover.living_room_curtain",
        position: 20,
      },
    });
  });

  it("blocks ambiguous switch and medium-risk cover controls", () => {
    const switchEntity = mapHomeAssistantState({
      entity_id: "switch.wall_plug",
      state: "off",
      attributes: { friendly_name: "墙壁插座" },
    });
    const dryingRack = mapHomeAssistantState({
      entity_id: "cover.balcony_drying_rack",
      state: "open",
      attributes: { friendly_name: "阳台晾衣杆", current_position: 80 },
    });

    expect(() => buildServiceCall(switchEntity, { capability: "turn_on", value: true })).toThrow(
      "not eligible",
    );
    expect(() => buildServiceCall(dryingRack, { capability: "set_position", value: 20 })).toThrow(
      "not eligible",
    );
  });

  it("executes a Home Assistant service call through the REST API", async () => {
    const calls = [];
    const result = await executeHomeAssistantAction({
      baseUrl: "http://ha.local:8123",
      token: "secret",
      action: {
        entityId: "light.living_room",
        capability: "turn_off",
        value: false,
      },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url === "http://ha.local:8123/api/states/light.living_room") {
          return {
            ok: true,
            async json() {
              return {
                entity_id: "light.living_room",
                state: "on",
                attributes: { friendly_name: "客厅灯" },
              };
            },
          };
        }
        if (url === "http://ha.local:8123/api/services/light/turn_off") {
          return {
            ok: true,
            async json() {
              return [
                {
                  entity_id: "light.living_room",
                  state: "off",
                  attributes: { friendly_name: "客厅灯" },
                },
              ];
            },
          };
        }
        throw new Error(`unexpected url ${url}`);
      },
    });

    expect(calls[1]).toMatchObject({
      url: "http://ha.local:8123/api/services/light/turn_off",
      options: {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entity_id: "light.living_room" }),
      },
    });
    expect(result).toMatchObject({
      status: "executed",
      domain: "light",
      service: "turn_off",
      changedStates: [expect.objectContaining({ entityId: "light.living_room", state: "off" })],
    });
  });
});

function createHaGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-06-18T00:00:00.000Z",
    areas: [{ area_id: "living", name: "客厅" }],
    devices: [{
      id: "device-1",
      name: "客厅灯",
      area_id: "living",
      manufacturer: "Fixture",
      model: "Light 1",
      identifiers: [["xiaomi_home", "fixture-light"]],
    }],
    entities: [{
      entity_id: "light.living_room",
      device_id: "device-1",
      platform: "xiaomi_home",
      original_name: "主灯",
    }],
    states: [{
      entity_id: "light.living_room",
      state: "on",
      attributes: { friendly_name: "客厅主灯", brightness: 128, supported_features: 0 },
    }],
  };
}
