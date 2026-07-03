import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { createProviderSnapshot, diffHcmHomes } from "./providerSync.js";

describe("provider sync", () => {
  it("creates stable hashes for equivalent provider graphs", () => {
    const first = createProviderSnapshot({
      states: [{ entity_id: "light.a", state: "on" }],
      provider: "home_assistant",
    });
    const second = createProviderSnapshot({
      provider: "home_assistant",
      states: [{ state: "on", entity_id: "light.a" }],
    });

    expect(first.hash).toBe(second.hash);
  });

  it("detects thing and capability changes across HCM snapshots", () => {
    const previous = createHcmHome({
      things: [
        {
          id: "living_light",
          name: "客厅灯",
          type: "light",
          spaceId: "living",
          capabilities: [
            {
              id: "power",
              name: "开关",
              kind: "control",
              valueType: "boolean",
              state: false,
              binding: { provider: "home_assistant", entityId: "light.living" },
            },
          ],
        },
      ],
    });
    const next = createHcmHome({
      things: [
        {
          id: "living_light",
          name: "客厅主灯",
          type: "light",
          spaceId: "living",
          capabilities: [
            {
              id: "power",
              name: "开关",
              kind: "control",
              valueType: "boolean",
              state: true,
              binding: { provider: "home_assistant", entityId: "light.living" },
            },
            {
              id: "brightness",
              name: "亮度",
              kind: "control",
              valueType: "number",
            },
          ],
        },
      ],
    });

    expect(diffHcmHomes(previous, next)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thing.renamed", thingId: "living_light" }),
        expect.objectContaining({ type: "thing.state.changed", capabilityId: "power" }),
        expect.objectContaining({ type: "capability.added", capabilityId: "brightness" }),
      ]),
    );
  });
});
