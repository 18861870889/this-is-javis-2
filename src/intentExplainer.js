export function explainIntentResult({ input, plan, execution, plannerHints = [] } = {}) {
  const lines = [];
  const targetNames = targetNamesFromPlan(plan);
  const services = execution?.accepted?.map((item) => item.service).filter(Boolean) ?? [];
  const rejected = execution?.rejected ?? [];

  lines.push(`我理解为：${plan?.summary || plan?.intent || input || "未识别指令"}`);
  if (targetNames.length > 0) lines.push(`目标设备：${targetNames.join("、")}`);
  if (plan?.stateQuery) lines.push(`读取结果：${plan.stateQuery.summary}`);
  if ((plan?.actions ?? []).length > 0) {
    lines.push(`执行能力：${plan.actions.map((action) => `${action.thingName} ${action.capabilityName}`).join("；")}`);
  }
  if (services.length > 0) lines.push(`将调用：${services.join("；")}`);
  const simulation = simulationText(execution);
  if (simulation) lines.push(`模拟校验：${simulation}`);
  if (execution?.decisionReview?.summary) lines.push(`决策复核：${execution.decisionReview.summary}`);
  if (plannerHints.length > 0) {
    lines.push(`家庭语义：${plannerHints.map((hint) => `${hint.phrase} -> ${hint.candidates[0]?.thingName}`).join("；")}`);
  }
  if (rejected.length > 0) lines.push(`拒绝原因：${rejected.map((item) => item.message || item.code).join("；")}`);
  const verification = verificationText(execution);
  if (verification) lines.push(`状态回读：${verification}`);
  lines.push(`安全判断：${safetyText(plan, execution)}`);

  return {
    title: plan?.intentType === "inventory_query"
      ? "家庭知识查询"
      : plan?.intentType === "preference"
        ? "偏好反馈"
      : plan?.intentType === "correction"
        ? "纠错反馈"
      : plan?.intentType === "state_query"
        ? "状态读取解释"
        : "执行计划解释",
    summary: lines.join("\n"),
    userMessage: userMessage({ input, plan, execution, targetNames }),
    intent: {
      type: plan?.intentType ?? "unknown",
      name: plan?.intent ?? "unknown",
      confidence: plan?.confidence ?? 0,
    },
    targets: targetNames,
    services,
    safety: {
      status: execution?.status ?? "unknown",
      dryRun: Boolean(execution?.dryRun),
      rejectedCount: rejected.length,
      needsConfirmation: Boolean(plan?.needsConfirmation),
    },
    hints: plannerHints.map((hint) => ({
      phrase: hint.phrase,
      intent: hint.intent,
      target: hint.candidates[0]?.thingName,
      confidence: hint.candidates[0]?.confidence,
    })),
  };
}

function userMessage({ input, plan, execution, targetNames }) {
  if (plan?.kind === "hcm_preference_feedback") return plan.summary;
  if (plan?.kind === "hcm_correction_feedback") return plan.summary;
  if (plan?.kind === "hcm_inventory_query" || plan?.kind === "hcm_capability_query" || plan?.kind === "hcm_state_query") {
    return conciseStateMessage(plan) || plan?.stateQuery?.summary || plan.summary;
  }
  if (execution?.status === "executed") {
    const action = execution.accepted?.[0];
    if (execution.accepted?.length === 1 && action?.thingName) {
      const verb = action.value === false ? "关掉" : action.value === true ? "打开" : "调整";
      return `已${verb}${action.thingName}。`;
    }
    if (targetNames.length > 0) return `已执行：${targetNames.join("、")}。`;
  }
  if (execution?.status === "dry_run") {
    return `这是预览：会操作 ${targetNames.join("、") || plan?.intent || input}，不会控制真实设备。`;
  }
  if (execution?.status === "needs_confirmation") {
    if (execution.decisionReview?.recovery?.mode === "ask_partial_execution_confirmation") {
      return execution.decisionReview.recovery.message;
    }
    if (execution.decisionReview?.recovery?.message) return `需要你确认：${execution.decisionReview.recovery.message}。`;
    return plan?.summary || "这一步需要你确认后再执行。";
  }
  if (execution?.status === "rejected") {
    if (execution.decisionReview?.recovery?.message) return `这次没有执行：${execution.decisionReview.recovery.message}。`;
    const reason = execution.rejected?.map((item) => item.message || item.code).filter(Boolean).join("；");
    return reason ? `这次没有执行：${reason}。` : "这次没有执行，安全门拒绝了计划。";
  }
  if (execution?.status === "needs_clarification") return plan?.summary || "目标还不够明确，我没有操作设备。";
  if (execution?.status === "no_action") return plan?.summary || "没有找到可执行动作，我没有操作设备。";
  return plan?.summary || input || "已处理。";
}

function conciseStateMessage(plan) {
  const query = plan?.stateQuery;
  if (!query) return "";
  if (query.mode === "room_light_state" && Array.isArray(query.items)) {
    const on = query.items.filter((item) => item.state === true).map((item) => item.thingName);
    const off = query.items.filter((item) => item.state === false).map((item) => item.thingName);
    const unknown = query.items.filter((item) => item.state !== true && item.state !== false).map((item) => item.thingName);
    const parts = [];
    if (on.length > 0) parts.push(`${on.join("、")}开着`);
    if (off.length > 0) parts.push(`${off.join("、")}关着`);
    if (unknown.length > 0) parts.push(`${unknown.join("、")}状态未知`);
    return `${query.roomName || query.thingName}：${parts.join("；") || "暂无可读状态"}。`;
  }
  const summary = String(query.summary ?? "");
  if (!summary) return "";
  const roomPrefix = query.roomName || roomNameFromSummary(summary);
  if (/(有人|无人|人在状态未知)/.test(summary) && roomPrefix) {
    const occupancy = summary.match(/：(有人|无人|人在状态未知)/)?.[1] ?? summary.match(/(有人|无人|人在状态未知)/)?.[1];
    const details = [summary.match(/光照\s*[^，。]+/)?.[0], summary.match(/电量\s*[^，。]+/)?.[0]].filter(Boolean);
    return occupancy ? `${roomPrefix}${occupancy}${details.length > 0 ? `，${details.join("，")}` : ""}。` : summary;
  }
  if (query.state === true) return `${query.thingName}开着。`;
  if (query.state === false) return `${query.thingName}关着。`;
  return summary.replace(/。该状态来自.*$/, "。").replace(/。状态来自.*$/, "。");
}

function roomNameFromSummary(summary) {
  const match = String(summary).match(/^([^的：:]{1,8})(?:的|：|:)/);
  return match?.[1] ?? "";
}

function targetNamesFromPlan(plan) {
  if (!plan) return [];
  const names = new Set();
  if (plan.stateQuery?.thingName) names.add(plan.stateQuery.thingName);
  for (const action of plan.actions ?? []) {
    if (action.thingName) names.add(action.thingName);
  }
  return Array.from(names);
}

function safetyText(plan, execution) {
  if (plan?.kind === "hcm_state_query") return "只读状态查询，不执行设备动作。";
  if (plan?.kind === "hcm_inventory_query" || plan?.kind === "hcm_capability_query") return "只读家庭知识查询，不执行设备动作。";
  if (plan?.kind === "hcm_correction_feedback") return "纠错反馈只记录，不执行设备动作，也不自动修改映射。";
  if (execution?.status === "needs_clarification") return "目标或控制通道不完整，未执行任何设备动作。";
  if (execution?.status === "needs_confirmation" && execution.decisionReview?.recovery?.mode === "ask_partial_execution_confirmation") {
    return "部分设备当前不可用，等待你确认是否只执行可用设备。";
  }
  if (plan?.needsConfirmation) return "需要用户确认后才能执行。";
  if (execution?.status === "dry_run") return "dry-run 预览，不会控制真实设备。";
  if (execution?.status === "rejected") return "安全门已拒绝执行。";
  if (execution?.status === "executed") return "低风险能力已通过 HCM 安全门。";
  if (execution?.status === "no_action") return "没有生成可执行动作。";
  return "已经过 HCM 能力边界和安全策略检查。";
}

function verificationText(execution) {
  const results = execution?.results ?? [];
  if (results.length === 0) return "";
  const passed = results.filter((result) => result.verification?.ok).length;
  const failed = results.filter((result) => result.verification && !result.verification.ok);
  if (failed.length > 0) return `${passed} 项收敛，${failed.length} 项状态不一致`;
  return `${passed} 项 HA 状态已收敛`;
}

function simulationText(execution) {
  const checks = execution?.simulation?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return "";
  const rejected = checks.filter((check) => !check.ok);
  if (rejected.length > 0) {
    const executableCount = checks.filter((check) => check.ok).length;
    const rejectedText = rejected.map((check) => check.message || check.code).join("；");
    return executableCount > 0 ? `${rejectedText}；另有 ${executableCount} 项可执行，等待确认` : rejectedText;
  }
  const assumed = checks.filter((check) => check.code === "assumed_supported");
  if (assumed.length > 0) return `通过，${assumed.length} 项因 HA 未暴露 supported_features 采用保守假设`;
  return "通过，未触碰真实设备";
}
