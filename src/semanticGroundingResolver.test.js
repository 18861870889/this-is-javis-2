import { describe, expect, it } from "vitest";
import { createHcmHome } from "./hcm.js";
import { attachHcmControlGraph } from "./hcmControlGraph.js";
import {
  normalizeSemanticPlannerActions,
  resolveSemanticGrounding,
  resolveSemanticTarget,
} from "./semanticGroundingResolver.js";

function control(id, name, entityId, state = false) {
  return {
    id,
    name,
    kind: "control",
    valueType: "boolean",
    state,
    policy: { risk: "low", confirmation: "never", autoExecutable: true },
    binding: { provider: "home_assistant", domain: "switch", entityId },
  };
}

function createStudyHome() {
  return attachHcmControlGraph(createHcmHome({
    provider: { id: "home_assistant", name: "Home Assistant" },
    spaces: [
      { id: "study", name: "书房" },
      { id: "living", name: "客厅" },
    ],
    things: [
      {
        id: "study_panel",
        name: "书房三开",
        type: "switch_panel",
        spaceId: "study",
        capabilities: [
          control("study_spot", "书房射灯 开关中键", "switch.study_spot", false),
          control("study_ceiling", "书房吊灯 开关左键", "switch.study_ceiling", false),
        ],
      },
      {
        id: "living_panel",
        name: "客厅开关",
        type: "switch_panel",
        spaceId: "living",
        capabilities: [control("living_spot", "客厅射灯 开关左键", "switch.living_spot", false)],
      },
    ],
  }));
}

describe("semantic grounding resolver", () => {
  it("resolves a Chinese logical light name to an HCM logical asset id", () => {
    const result = resolveSemanticTarget({ target: "书房射灯" }, { input: "打开书房射灯", home: createStudyHome() });

    expect(result).toMatchObject({
      ok: true,
      target: {
        id: "asset_study_书房射灯",
        name: "书房射灯",
        roomId: "study",
        role: "logical_asset",
      },
    });
  });

  it("normalizes semantic actions before HCM action validation", () => {
    const normalized = normalizeSemanticPlannerActions(
      [{ target: "书房射灯", capability: "power", value: true }],
      { input: "打开书房射灯", home: createStudyHome() },
    );

    expect(normalized.rejected).toEqual([]);
    expect(normalized.actions).toEqual([
      expect.objectContaining({
        device_id: "asset_study_书房射灯",
        capability: "power",
        value: true,
      }),
    ]);
  });

  it("keeps ambiguous targets visible instead of silently choosing one", () => {
    const normalized = normalizeSemanticPlannerActions(
      [{ target: "射灯", capability: "power", value: true }],
      { input: "打开射灯", home: createStudyHome() },
    );

    expect(normalized.rejected[0]).toContain("匹配到多个候选");
    expect(normalized.actions[0]).toMatchObject({ target: "射灯" });
  });

  it("summarizes grounding status from normalized actions and intent frame", () => {
    const grounding = resolveSemanticGrounding({
      input: "打开书房射灯",
      home: createStudyHome(),
      intentFrame: {
        confidence: 0.88,
        grounding: { candidateTargets: [{ targetRef: "书房射灯", confidence: 0.8 }] },
        ambiguity: { level: "low" },
      },
      draftActions: [{ target: "书房射灯", capability: "power", value: true }],
      normalizedActions: [{ logicalAssetId: "asset_study_书房射灯", logicalAssetName: "书房射灯", logicalRoomId: "study", reason: "用户点名" }],
      rejected: [],
    });

    expect(grounding).toMatchObject({
      version: "0.21",
      status: "resolved",
      ambiguity: { level: "low" },
    });
    expect(grounding.targetCandidates).toEqual([
      expect.objectContaining({ id: "asset_study_书房射灯", role: "execution_target" }),
      expect.objectContaining({ id: "asset_study_书房射灯", role: "logical_asset" }),
    ]);
  });
});
