import { describe, expect, it } from "vitest";
import { buildHcmExecutionPlan } from "./hcmExecutor.js";
import { normalizeHcmPlannerDraft } from "./hcmPlanner.js";
import { createHarnessScenarioHome } from "./harnessScenario.fixture.js";
import { simulateHcmServiceCalls } from "./homeAssistantServiceSimulator.js";
import { explainIntentResult } from "./intentExplainer.js";
import { compilePersonalSemanticsForPlanner } from "./personalSemantics.js";

describe("intent explainer", () => {
  it("explains a dry-run control plan with target, service, semantics, and safety", () => {
    const home = createHarnessScenarioHome();
    const plan = normalizeHcmPlannerDraft(
      "我要晾衣服",
      {
        intent_type: "scene",
        intent: "prepare_laundry_drying",
        summary: "准备晾衣服",
        confidence: 0.88,
        actions: [{ device_id: "balcony_drying_rack", capability: "drying_rack_position", value: 100 }],
      },
      home,
    );
    const executionPlan = buildHcmExecutionPlan(plan.actions, home);
    const simulation = simulateHcmServiceCalls(executionPlan.accepted, home);
    const explanation = explainIntentResult({
      input: "我要晾衣服",
      plan,
      execution: {
        status: "dry_run",
        dryRun: true,
        accepted: executionPlan.accepted.map((item) => ({
          thingName: item.thing.name,
          capabilityName: item.capability.name,
          service: `${item.serviceCall.domain}.${item.serviceCall.service}`,
        })),
        rejected: [],
        simulation,
      },
      plannerHints: compilePersonalSemanticsForPlanner("我要晾衣服", home),
    });

    expect(explanation.summary).toContain("我理解为：准备晾衣服");
    expect(explanation.summary).toContain("目标设备：阳台晾衣杆");
    expect(explanation.summary).toContain("将调用：cover.set_cover_position");
    expect(explanation.summary).toContain("模拟校验：通过，未触碰真实设备");
    expect(explanation.summary).toContain("家庭语义：晾衣服 -> 阳台晾衣杆");
    expect(explanation.summary).toContain("dry-run 预览，不会控制真实设备");
  });

  it("explains read-only state queries as non-executing results", () => {
    const plan = normalizeHcmPlannerDraft(
      "玄关人体目前是什么状态",
      {
        intent_type: "state_query",
        intent: "query_entry_motion",
        confidence: 0.92,
        query: { device_id: "entry_motion", reason: "询问玄关人体状态" },
        actions: [],
      },
      createHarnessScenarioHome(),
    );
    const explanation = explainIntentResult({
      input: "玄关人体目前是什么状态",
      plan,
      execution: { status: "answered", dryRun: true, accepted: [], rejected: [] },
    });

    expect(explanation.title).toBe("状态读取解释");
    expect(explanation.summary).toContain("读取结果：玄关的入户传感器");
    expect(explanation.summary).toContain("只读状态查询，不执行设备动作");
  });

  it("keeps chat answers concise for business state questions", () => {
    const explanation = explainIntentResult({
      input: "厨房有人吗",
      plan: {
        kind: "hcm_state_query",
        intentType: "state_query",
        intent: "查询厨房是否有人",
        confidence: 0.9,
        actions: [],
        stateQuery: {
          thingName: "小米人在传感器-厨房",
          roomName: "厨房",
          summary: "厨房的小米人在传感器-厨房：无人，无人持续时长 10分钟持续无人，光照 6，电量 98%。",
        },
      },
      execution: { status: "answered", accepted: [], rejected: [] },
    });

    expect(explanation.userMessage).toBe("厨房无人，光照 6，电量 98%。");
  });

  it("summarizes room light state without debug caveats in chat", () => {
    const explanation = explainIntentResult({
      input: "餐厅哪些灯开着",
      plan: {
        kind: "hcm_state_query",
        intentType: "state_query",
        intent: "查询餐厅灯光",
        confidence: 0.9,
        actions: [],
        stateQuery: {
          mode: "room_light_state",
          thingName: "餐厅灯光",
          roomName: "餐厅",
          items: [
            { thingName: "餐厅射灯", state: true },
            { thingName: "餐厅吊灯", state: "unknown" },
            { thingName: "餐边柜灯带", state: false },
          ],
          summary: "餐厅灯光：餐厅射灯开；餐厅吊灯未知；餐边柜灯带关。状态来自开关回路，不能独立证明灯具实际发光。",
        },
      },
      execution: { status: "answered", accepted: [], rejected: [] },
    });

    expect(explanation.userMessage).toBe("餐厅：餐厅射灯开着；餐边柜灯带关着；餐厅吊灯状态未知。");
  });

  it("explains correction feedback without implying a mapping change", () => {
    const plan = normalizeHcmPlannerDraft(
      "你说错了吧 我看厨房只有灯带",
      {
        intent_type: "state_query",
        intent: "确认厨房只有灯带",
        confidence: 0.9,
        actions: [],
      },
      createHarnessScenarioHome(),
    );
    const explanation = explainIntentResult({
      input: "你说错了吧 我看厨房只有灯带",
      plan,
      execution: { status: "answered", dryRun: false, accepted: [], rejected: [] },
    });

    expect(explanation.title).toBe("纠错反馈");
    expect(explanation.userMessage).toContain("不会自动改设备映射");
    expect(explanation.summary).toContain("不执行设备动作");
  });
});
