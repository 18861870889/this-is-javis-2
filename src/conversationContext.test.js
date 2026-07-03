import { describe, expect, it } from "vitest";
import {
  createConversationContextStore,
  isComfortFollowUpInput,
  isReferentialControlInput,
  isRoomScopedFollowUpInput,
} from "./conversationContext.js";

describe("conversation context", () => {
  it("keeps the last resolved logical target for short follow-up commands", () => {
    const store = createConversationContextStore();
    store.record("session-1", {
      input: "餐厅射灯开着吗",
      plan: {
        intent: "查询餐厅射灯",
        intentType: "state_query",
        stateQuery: { thingId: "asset_dining_spot", thingName: "餐厅射灯", roomId: "dining" },
        actions: [],
      },
      execution: { status: "answered" },
    });

    expect(store.get("session-1").focusedTargets).toEqual([
      { id: "asset_dining_spot", name: "餐厅射灯", roomId: "dining" },
    ]);
    expect(isReferentialControlInput("关一下")).toBe(true);
  });

  it("keeps conversation focus after a dry-run command", () => {
    const store = createConversationContextStore();
    store.record("session-1", {
      input: "打开书房射灯",
      plan: {
        intent: "turn_on_study_spotlight",
        intentType: "device_control",
        actions: [{
          thingId: "study_panel",
          thingName: "书房射灯",
          logicalAssetId: "asset_study_spot",
          logicalAssetName: "书房射灯",
          logicalRoomId: "study",
        }],
      },
      execution: { status: "dry_run" },
    });

    expect(store.get("session-1").focusedTargets).toEqual([
      { id: "asset_study_spot", name: "书房射灯", roomId: "study" },
    ]);
  });

  it("does not replace focus after a failed command", () => {
    const store = createConversationContextStore();
    store.record("session-1", {
      input: "餐厅射灯开着吗",
      plan: { intent: "query", intentType: "state_query", stateQuery: { thingId: "dining", thingName: "餐厅射灯" } },
      execution: { status: "answered" },
    });
    store.record("session-1", {
      input: "关一下",
      plan: { intent: "wrong", intentType: "device_control", actions: [{ thingId: "study", thingName: "书房吊灯" }] },
      execution: { status: "needs_clarification" },
    });

    expect(store.get("session-1").focusedTargets[0].id).toBe("dining");
  });

  it("keeps room focus after a clarification prompt with an explicit room", () => {
    const store = createConversationContextStore();
    store.record("session-1", {
      input: "书房灯关一个",
      plan: {
        intent: "关闭书房的一个灯",
        intentType: "device_control",
        contextFocus: { rooms: [{ id: "study", name: "书房" }] },
        actions: [],
      },
      execution: { status: "needs_clarification" },
    });

    expect(store.get("session-1").focusedTargets).toEqual([]);
    expect(store.get("session-1").focusedRooms).toEqual([{ id: "study", name: "书房" }]);
    expect(isRoomScopedFollowUpInput("吊灯")).toBe(true);
  });

  it("keeps only executable targets after a partial-availability confirmation prompt", () => {
    const store = createConversationContextStore();
    store.record("session-1", {
      input: "关闭餐厅灯",
      plan: {
        intent: "关闭餐厅灯",
        intentType: "scene",
        actions: [
          {
            thingId: "dining_panel",
            thingName: "餐厅吊灯",
            logicalAssetId: "asset_dining_chandelier",
            logicalAssetName: "餐厅吊灯",
            logicalRoomId: "dining",
            capabilityId: "chandelier",
            value: false,
          },
          {
            thingId: "dining_panel",
            thingName: "餐厅射灯",
            logicalAssetId: "asset_dining_spot",
            logicalAssetName: "餐厅射灯",
            logicalRoomId: "dining",
            capabilityId: "spot",
            value: false,
          },
        ],
      },
      execution: {
        status: "needs_confirmation",
        accepted: [
          {
            thingId: "dining_panel",
            thingName: "餐厅吊灯",
            logicalAssetId: "asset_dining_chandelier",
            logicalRoomId: "dining",
            capabilityId: "chandelier",
            value: false,
            simulation: { ok: false },
          },
          {
            thingId: "dining_panel",
            thingName: "餐厅射灯",
            logicalAssetId: "asset_dining_spot",
            logicalRoomId: "dining",
            capabilityId: "spot",
            value: false,
            simulation: { ok: true },
          },
        ],
        decisionReview: { recovery: { mode: "ask_partial_execution_confirmation" } },
      },
    });

    const context = store.get("session-1");
    expect(context.focusedTargets).toEqual([{ id: "asset_dining_spot", name: "餐厅射灯", roomId: "dining" }]);
    expect(context.pendingPartialExecution.actions).toEqual([
      expect.objectContaining({ logicalAssetId: "asset_dining_spot", capabilityId: "spot", value: false }),
    ]);
    expect(isReferentialControlInput("执行其他可执行设备")).toBe(true);
  });

  it("keeps room focus for room-level state queries without pinning one lamp", () => {
    const store = createConversationContextStore();
    store.record("session-1", {
      input: "书房灯开着吗",
      plan: {
        intent: "query_study_lights",
        intentType: "state_query",
        stateQuery: { thingId: null, thingName: "书房灯光", roomId: "study", roomName: "书房" },
        actions: [],
      },
      execution: { status: "answered" },
    });

    expect(store.get("session-1").focusedTargets).toEqual([]);
    expect(store.get("session-1").focusedRooms).toEqual([{ id: "study", name: "书房" }]);
  });

  it("treats brightness discomfort as a context-dependent follow-up", () => {
    expect(isComfortFollowUpInput("不够亮啊")).toBe(true);
    expect(isComfortFollowUpInput("还是有点暗")).toBe(true);
    expect(isReferentialControlInput("不够亮啊")).toBe(true);
    expect(isRoomScopedFollowUpInput("关灯吧")).toBe(true);
  });
});
