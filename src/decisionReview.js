export const DECISION_REVIEW_VERSION = "0.22";

export function reviewDecisionBeforeExecution({
  input = "",
  plan,
  executionPlan,
  policyPlan,
  simulation,
} = {}) {
  const issues = [];
  const actionCount = plan?.actions?.length ?? 0;
  const isReadOnly = ["hcm_state_query", "hcm_inventory_query", "hcm_preference_feedback", "hcm_correction_feedback"].includes(plan?.kind);
  const partialSimulation = hasPartialExecutableSimulation(simulation);

  if (plan?.requiresClarification) {
    issues.push(issue("planner_requires_clarification", "high", "计划仍需要用户澄清，不能执行设备动作"));
  }
  if (!isReadOnly && plan?.kind === "unresolved_control") {
    issues.push(issue("unresolved_control", "high", "控制意图没有解析到可执行 HCM 目标"));
  }
  if (!isReadOnly && actionCount === 0 && looksLikeControl(input)) {
    issues.push(issue("empty_control_plan", "high", "控制类表达没有动作"));
  }
  for (const rejection of executionPlan?.rejected ?? []) {
    issues.push(issue(`safety_${rejection.code}`, "high", rejection.message || rejection.code));
  }
  for (const rejection of policyPlan?.rejected ?? []) {
    issues.push(issue(`policy_${rejection.code}`, "high", rejection.message || rejection.code));
  }
  for (const rejection of simulation?.rejected ?? []) {
    issues.push(issue(`simulation_${rejection.code}`, partialSimulation ? "medium" : "high", rejection.message || rejection.code));
  }
  if (plan?.intentFrame?.ambiguity?.level === "high") {
    issues.push(issue("high_intent_ambiguity", "medium", "意图帧标记高歧义"));
  }
  if (plan?.grounding?.status && !["resolved", "empty"].includes(plan.grounding.status) && actionCount === 0) {
    issues.push(issue(`grounding_${plan.grounding.status}`, "medium", plan.grounding.ambiguity?.reason || "语义落地未完全收敛"));
  }

  const blockingIssues = issues.filter((item) => item.severity === "high" || item.severity === "critical");
  const status = isReadOnly
    ? "answer_only"
    : partialSimulation
      ? "partial_available"
    : blockingIssues.length > 0
      ? plan?.requiresClarification || plan?.kind === "unresolved_control"
        ? "needs_clarification"
        : "blocked"
      : actionCount > 0
        ? "ready"
        : "no_action";

  return {
    version: DECISION_REVIEW_VERSION,
    status,
    ok: status === "ready" || status === "answer_only" || status === "no_action",
    blocksExecution: status === "blocked" || status === "needs_clarification" || status === "partial_available",
    issues,
    recovery: recoveryForIssues(issues, plan, simulation),
    summary: summarizeReview(status, issues),
  };
}

function recoveryForIssues(issues, plan, simulation) {
  if (issues.length === 0) {
    return {
      mode: "none",
      message: "计划可进入后续模拟/执行阶段",
    };
  }
  if (hasPartialExecutableSimulation(simulation)) {
    return {
      mode: "ask_partial_execution_confirmation",
      message: summarizePartialSimulation(simulation),
    };
  }
  if (issues.some((item) => item.code === "planner_requires_clarification" || item.code === "unresolved_control")) {
    return {
      mode: "ask_clarification",
      message: plan?.summary || "目标或能力还不够明确，需要向用户澄清",
    };
  }
  if (issues.some((item) => item.code.startsWith("simulation_"))) {
    return {
      mode: "adapter_diagnosis",
      message: "Provider 模拟拒绝了计划，需要检查 adapter 能力边界或 HCM binding",
    };
  }
  if (issues.some((item) => item.code.startsWith("safety_") || item.code.startsWith("policy_"))) {
    return {
      mode: "safety_review",
      message: "安全或策略门拒绝计划，需要调整能力授权或保持手动确认",
    };
  }
  return {
    mode: "review",
    message: "计划需要人工审核",
  };
}

function summarizeReview(status, issues) {
  if (issues.length === 0) return "决策复核通过；复核阶段未触碰设备。";
  return `${status}：${issues.map((item) => item.message).join("；")}`;
}

function hasPartialExecutableSimulation(simulation) {
  const checks = simulation?.checks ?? [];
  return checks.some((check) => check.ok) && checks.some((check) => !check.ok);
}

function summarizePartialSimulation(simulation) {
  const checks = simulation?.checks ?? [];
  const executable = checks.filter((check) => check.ok).map((check) => check.thingName).filter(Boolean);
  const unavailable = checks.filter((check) => !check.ok).map((check) => `${check.thingName || "某个设备"}：${check.message || check.code}`);
  return `其中 ${unavailable.join("；")}。其它可执行设备：${executable.join("、") || "无"}。是否跳过不可用设备，只执行这些可执行设备？`;
}

function issue(code, severity, message) {
  return { code, severity, message };
}

function looksLikeControl(input) {
  return /打开|开启|启动|关闭|关掉|停止|暂停|调到|设置|播放|看电影|晾衣|清扫|亮|暗|热|冷/.test(String(input ?? ""));
}
