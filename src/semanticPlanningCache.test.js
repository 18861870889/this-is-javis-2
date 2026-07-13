import { describe, expect, it } from "vitest";
import {
  createSemanticPlanningCache,
  homeSignatureFromHome,
} from "./semanticPlanningCache.js";

describe("semantic planning cache identifiers", () => {
  it("keeps home signatures stable and truncated across equivalent home ordering", () => {
    const firstHome = {
      spaces: [
        { id: "study", name: "书房" },
        { id: "dining", name: "餐厅" },
      ],
      things: [
        { id: "study_panel", name: "书房面板", spaceId: "study" },
        { id: "dining_panel", name: "餐厅面板", spaceId: "dining" },
      ],
      controlGraph: {
        assets: [
          { id: "study_spot", name: "书房射灯", spaceId: "study" },
          { id: "dining_spot", name: "餐厅射灯", spaceId: "dining" },
        ],
      },
    };
    const reorderedHome = {
      spaces: [...firstHome.spaces].reverse(),
      things: [...firstHome.things].reverse(),
      controlGraph: { assets: [...firstHome.controlGraph.assets].reverse() },
    };

    const signature = homeSignatureFromHome(firstHome);

    expect(signature).toMatch(/^[a-f0-9]{16}$/);
    expect(homeSignatureFromHome(reorderedHome)).toBe(signature);
    expect(homeSignatureFromHome({ ...firstHome, things: [] })).not.toBe(signature);
  });

  it("exposes stable, truncated cache IDs through recordSuccess", () => {
    const record = () => {
      let persisted = null;
      const cache = createSemanticPlanningCache({
        read: () => persisted,
        write: (state) => { persisted = state; },
        now: () => new Date("2026-07-13T00:00:00.000Z"),
      });
      const state = cache.recordSuccess("打开书房射灯", {
        homeSignature: "0123456789abcdef",
        plannerDraft: {
          actions: [{ target: "书房射灯", value: true }],
        },
      });
      return state.entries[0].id;
    };

    const firstId = record();

    expect(firstId).toMatch(/^semantic_[a-f0-9]{12}$/);
    expect(record()).toBe(firstId);
  });
});
