import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { attachHcmControlGraph } from "./hcmControlGraph.js";
import { answerHcmCapabilityQuery, answerHcmInventoryQuery } from "./hcmKnowledgeQuery.js";

function light(id, name, entityId) {
  return {
    id,
    name: `${name}开关`,
    kind: "control",
    valueType: "boolean",
    state: false,
    policy: { risk: "low", confirmation: "never", autoExecutable: true },
    binding: { provider: "home_assistant", domain: "switch", entityId },
  };
}

describe("HCM knowledge query", () => {
  it("answers room inventory counts instead of returning one device state", () => {
    const home = attachHcmControlGraph(createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "living", name: "客厅" }],
      things: [{
        id: "panel",
        name: "客厅开关",
        type: "switch_panel",
        spaceId: "living",
        capabilities: [
          light("spot_1", "客厅射灯1", "switch.spot_1"),
          light("spot_2", "客厅射灯2", "switch.spot_2"),
          light("ceiling", "客厅吊灯", "switch.ceiling"),
        ],
      }],
    }));

    const answer = answerHcmInventoryQuery("客厅有几个射灯", home);

    expect(answer).toMatchObject({ mode: "count", count: 2, roomId: "living" });
    expect(answer.summary).toContain("客厅射灯1、客厅射灯2");
  });

  it("answers device capability questions from HCM boundaries", () => {
    const home = createHcmHome({
      provider: { id: "home_assistant", name: "Home Assistant" },
      spaces: [{ id: "cat_room", name: "猫猫房" }],
      things: [
        {
          id: "cat_feeder",
          name: "猫粮机",
          type: "pet_feeder",
          spaceId: "cat_room",
          capabilities: [
            {
              id: "food_out",
              name: "宠物喂食器 喂食机出粮",
              kind: "sensor",
              valueType: "unknown",
              state: "unknown",
              policy: { risk: "low", confirmation: "never", autoExecutable: false },
              binding: { provider: "home_assistant", domain: "notify", entityId: "notify.food_out" },
            },
            {
              id: "food_left",
              name: "宠物喂食器 宠物粮剩余量",
              kind: "sensor",
              valueType: "unknown",
              state: "Normal",
              policy: { risk: "low", confirmation: "never", autoExecutable: false },
              binding: { provider: "home_assistant", domain: "sensor", entityId: "sensor.food_left" },
            },
            {
              id: "feed_amount",
              name: "宠物喂食器 设定出粮量",
              kind: "config",
              valueType: "number",
              state: 1,
              policy: { risk: "high", confirmation: "always", autoExecutable: false },
              binding: { provider: "home_assistant", domain: "number", entityId: "number.feed_amount" },
            },
          ],
        },
      ],
    });

    const answer = answerHcmCapabilityQuery("猫粮机如何控制", home);

    expect(answer).toMatchObject({
      path: "hcm-capability-query",
      mode: "capability_list",
      thingId: "cat_feeder",
    });
    expect(answer.summary).toContain("当前不能直接执行：喂食机出粮");
    expect(answer.summary).toContain("需要确认/受保护：设定出粮量");
    expect(answer.summary).toContain("可读取：宠物粮剩余量=Normal");
  });
});
