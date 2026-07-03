import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { simulateHcmServiceCall, simulateHcmServiceCalls } from "./homeAssistantServiceSimulator.js";

function createSimulatorHome({ supportedFeatures = 1, online = true } = {}) {
  return createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    things: [
      {
        id: "speaker",
        name: "小爱音箱Pro",
        type: "tv",
        spaceId: "living",
        online,
        capabilities: [
          {
            id: "speaker_playback",
            name: "音箱",
            kind: "control",
            valueType: "boolean",
            policy: { risk: "low", confirmation: "never", autoExecutable: true },
            binding: {
              provider: "home_assistant",
              domain: "media_player",
              entityId: "media_player.xiaoai",
              supportedFeatures,
            },
          },
        ],
      },
    ],
  });
}

describe("Home Assistant service simulator", () => {
  it("accepts a media pause service when supported_features includes pause", () => {
    const result = simulateHcmServiceCall(
      {
        thing: { id: "speaker", name: "小爱音箱Pro" },
        capability: { id: "speaker_playback", name: "音箱" },
        action: { thingId: "speaker", capabilityId: "speaker_playback", value: false },
        serviceCall: {
          domain: "media_player",
          service: "media_pause",
          serviceData: { entity_id: "media_player.xiaoai" },
        },
      },
      createSimulatorHome({ supportedFeatures: 1 }),
    );

    expect(result).toMatchObject({
      ok: true,
      code: "supported",
      service: "media_player.media_pause",
    });
  });

  it("rejects a media pause service when the entity only supports stop", () => {
    const result = simulateHcmServiceCall(
      {
        thing: { id: "speaker", name: "小爱音箱Pro" },
        capability: { id: "speaker_playback", name: "音箱" },
        action: { thingId: "speaker", capabilityId: "speaker_playback", value: false },
        serviceCall: {
          domain: "media_player",
          service: "media_pause",
          serviceData: { entity_id: "media_player.xiaoai" },
        },
      },
      createSimulatorHome({ supportedFeatures: 4096 }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "unsupported_media_feature",
      thingId: "speaker",
      service: "media_player.media_pause",
    });
  });

  it("rejects service calls for offline things before real execution", () => {
    const result = simulateHcmServiceCalls(
      [
        {
          thing: { id: "speaker", name: "小爱音箱Pro" },
          capability: { id: "speaker_playback", name: "音箱" },
          action: { thingId: "speaker", capabilityId: "speaker_playback", value: false },
          serviceCall: {
            domain: "media_player",
            service: "media_pause",
            serviceData: { entity_id: "media_player.xiaoai" },
          },
        },
      ],
      createSimulatorHome({ online: false }),
    );

    expect(result).toMatchObject({
      ok: false,
      rejected: [expect.objectContaining({ code: "thing_offline" })],
    });
  });
});
