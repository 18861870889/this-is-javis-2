import { describe, expect, it } from "vitest";
import { mapHomeAssistantGraphToHcm } from "./homeAssistantCatalog.js";

describe("home assistant catalog mapper", () => {
  it("maps Home Assistant registries into a device-first HCM catalog", () => {
    const hcm = mapHomeAssistantGraphToHcm({
      provider: { id: "home_assistant", name: "Home Assistant" },
      fetchedAt: "2026-06-13T00:00:00.000Z",
      areas: [
        {
          area_id: "home_living",
          name: "栗子、小白、团团、久久的窝 客厅",
        },
      ],
      devices: [
        {
          id: "device_switch",
          area_id: "home_living",
          identifiers: [["xiaomi_home", "cn_1"]],
          name: "沙发右侧一号开关",
          manufacturer: "UWIZE",
          model: "topwit.switch.rzw33",
        },
        {
          id: "device_sensor",
          area_id: "home_living",
          identifiers: [["xiaomi_home", "cn_2"]],
          name: "小米人在传感器",
          manufacturer: "小米",
          model: "xiaomi.sensor_occupy.03",
        },
      ],
      entities: [
        {
          device_id: "device_switch",
          entity_id: "switch.topwit_living_on_p_2_1",
          platform: "xiaomi_home",
          original_name: " 客厅八筒灯 开关左键",
        },
        {
          device_id: "device_switch",
          entity_id: "switch.topwit_living_mutual_control_p_23_1",
          platform: "xiaomi_home",
          original_name: "* 互控允许，解控允许 一键互控允许，解控允许",
        },
        {
          device_id: "device_sensor",
          entity_id: "binary_sensor.study_presence",
          platform: "xiaomi_home",
          original_name: " 人在状态",
        },
      ],
      states: [
        {
          entity_id: "switch.topwit_living_on_p_2_1",
          state: "on",
          attributes: { friendly_name: "客厅八筒灯", supported_features: 0 },
        },
        {
          entity_id: "switch.topwit_living_mutual_control_p_23_1",
          state: "off",
          attributes: {},
        },
        {
          entity_id: "binary_sensor.study_presence",
          state: "on",
          attributes: {},
        },
      ],
    });

    expect(hcm.version).toBe("0.1");
    expect(hcm.stats.thingCount).toBe(2);
    expect(hcm.spaces).toEqual(expect.arrayContaining([expect.objectContaining({ id: "living", name: "客厅" })]));
    expect(hcm.things[0]).toMatchObject({
      name: "沙发右侧一号开关",
      type: "switch_panel",
      spaceId: "living",
    });
    expect(hcm.things[0].capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ entityId: "switch.topwit_living_on_p_2_1" }),
          policy: expect.objectContaining({ risk: "low", autoExecutable: true }),
        }),
        expect.objectContaining({
          binding: expect.objectContaining({ entityId: "switch.topwit_living_mutual_control_p_23_1" }),
          policy: expect.objectContaining({ risk: "high", autoExecutable: false }),
        }),
      ]),
    );
    expect(
      hcm.things[0].capabilities.find((capability) => capability.binding.entityId === "switch.topwit_living_on_p_2_1")
        .binding,
    ).toMatchObject({
      supportedFeatures: 0,
      currentState: "on",
    });
    expect(hcm.unresolvedBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: "switch.topwit_living_mutual_control_p_23_1",
          thingType: "switch_panel",
          kind: "control",
          confirmation: "always",
        }),
        expect.objectContaining({
          entityId: "binary_sensor.study_presence",
          suggestedRisk: "sensitive",
          kind: "sensor",
        }),
      ]),
    );
    expect(hcm.review.byRisk).toMatchObject({ high: 1, sensitive: 1 });
  });

  it("keeps non-xiaomi devices out of the Xiaomi-derived catalog", () => {
    const hcm = mapHomeAssistantGraphToHcm({
      areas: [],
      devices: [{ id: "sun", identifiers: [["sun", "core"]], name: "Sun" }],
      entities: [{ device_id: "sun", entity_id: "sun.sun", platform: "sun" }],
      states: [{ entity_id: "sun.sun", state: "above_horizon", attributes: {} }],
    });

    expect(hcm.stats.thingCount).toBe(0);
  });

  it("keeps master bedroom separate from master bathroom", () => {
    const hcm = mapHomeAssistantGraphToHcm({
      areas: [
        { area_id: "master", name: "栗子、小白、团团、久久的窝 主卧" },
        { area_id: "master_bath", name: "栗子、小白、团团、久久的窝 主卧卫生间" },
      ],
      devices: [
        { id: "fan", area_id: "master", identifiers: [["xiaomi_home", "cn_fan"]], name: "风扇" },
        { id: "switch", area_id: "master_bath", identifiers: [["xiaomi_home", "cn_switch"]], name: "主卫开关" },
      ],
      entities: [
        { device_id: "fan", entity_id: "fan.master", platform: "xiaomi_home", original_name: "风扇" },
        { device_id: "switch", entity_id: "switch.master_bath_light", platform: "xiaomi_home", original_name: "主卫灯" },
      ],
      states: [
        { entity_id: "fan.master", state: "off", attributes: {} },
        { entity_id: "switch.master_bath_light", state: "off", attributes: {} },
      ],
    });

    expect(hcm.things.find((thing) => thing.name === "风扇").spaceId).toBe("master");
    expect(hcm.things.find((thing) => thing.name === "主卫开关").spaceId).toBe("master_bath");
  });

  it("does not let a generic bedroom area overwrite master bedroom semantics", () => {
    const hcm = mapHomeAssistantGraphToHcm({
      areas: [
        { area_id: "generic_bedroom", name: "卧室" },
        { area_id: "xiaomi_master", name: "栗子、小白、团团、久久的窝 主卧" },
      ],
      devices: [
        { id: "fan", area_id: "xiaomi_master", identifiers: [["xiaomi_home", "cn_fan"]], name: "风扇" },
      ],
      entities: [{ device_id: "fan", entity_id: "fan.master", platform: "xiaomi_home", original_name: "风扇" }],
      states: [{ entity_id: "fan.master", state: "off", attributes: {} }],
    });

    const spaces = new Map(hcm.spaces.map((space) => [space.id, space.name]));
    expect(hcm.things[0].spaceId).toBe("master");
    expect(spaces.get("master")).toBe("主卧");
  });
});
