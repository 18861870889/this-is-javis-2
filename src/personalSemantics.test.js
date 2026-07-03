import { describe, expect, it } from "vitest";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import { applyPersonalSemanticsToThingAliases, compilePersonalSemanticsForPlanner } from "./personalSemantics.js";

describe("personal semantics", () => {
  it("turns household phrases into planner hints without creating executable actions", () => {
    const hints = compilePersonalSemanticsForPlanner("我要晾衣服", createHarnessScenarioHome());

    expect(hints).toEqual([
      expect.objectContaining({
        phrase: "晾衣服",
        intent: "prepare_laundry_drying",
        candidates: [
          expect.objectContaining({
            thingId: "balcony_drying_rack",
            thingName: "阳台晾衣杆",
            suggestedCapabilities: [
              expect.objectContaining({
                capabilityId: "drying_rack_position",
                defaultValue: 100,
              }),
            ],
          }),
        ],
      }),
    ]);
  });

  it("adds high-confidence household aliases to matching HCM things", () => {
    const home = applyPersonalSemanticsToThingAliases(createHarnessScenarioHome());
    const rack = home.things.find((thing) => thing.id === "balcony_drying_rack");
    const speaker = home.things.find((thing) => thing.id === "xiaoai_speaker");

    expect(rack.aliases).toEqual(expect.arrayContaining(["晾衣服", "晒衣服"]));
    expect(speaker.aliases).toEqual(expect.arrayContaining(["小爱音箱"]));
  });

  it("returns no hints when the command does not match known household semantics", () => {
    expect(compilePersonalSemanticsForPlanner("打开一个不存在的地下室灯", createHarnessScenarioHome())).toEqual([]);
  });
});
