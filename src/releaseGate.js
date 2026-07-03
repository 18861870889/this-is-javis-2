export const RELEASE_GATE_VERSION = "0.1";

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled", "real"]);

export function getExecutionMode(env = {}) {
  const explicitMode = env.HARNESS_EXECUTION_MODE;
  const legacyFlag = env.HARNESS_REAL_EXECUTION;
  const raw = explicitMode ?? legacyFlag ?? "dry_run";
  const normalized = String(raw).trim().toLowerCase();
  const realExecutionEnabled = TRUE_VALUES.has(normalized);
  return {
    mode: realExecutionEnabled ? "real" : "dry_run",
    realExecutionEnabled,
    source: explicitMode !== undefined ? "HARNESS_EXECUTION_MODE" : legacyFlag !== undefined ? "HARNESS_REAL_EXECUTION" : "default",
    label: realExecutionEnabled ? "真实执行已开启" : "默认 Dry-run",
    description: realExecutionEnabled
      ? "低风险动作允许进入真实 provider 执行；仅适合私有测试或明确授权环境。"
      : "所有 HCM 指令默认只做计划、模拟和审计，不触碰真实设备。",
    enableHint: "设置 HARNESS_EXECUTION_MODE=real 后重启服务，才允许真实执行。",
  };
}

export function buildRuntimeStatus({
  env = {},
  haConfigured = false,
  llmConfigured = false,
  hasOnboardingBaseline = false,
  commandAuditEnabled = true,
} = {}) {
  const execution = getExecutionMode(env);
  const checks = [
    check({
      id: "llm_configured",
      label: "LLM 已配置",
      ok: llmConfigured,
      severity: "critical",
      pass: "真实规划模型已配置。",
      fail: "缺少 OPENAI_API_KEY，无法进入真实 HCM 指令链路。",
    }),
    check({
      id: "ha_configured",
      label: "Home Assistant 已配置",
      ok: haConfigured,
      severity: "critical",
      pass: "HA provider 可用于 HCM 同步。",
      fail: "缺少 HA_BASE_URL 或 HA_TOKEN，无法同步真实家庭模型。",
    }),
    {
      id: "real_execution_default",
      label: "真实执行默认关闭",
      status: execution.realExecutionEnabled ? "warning" : "pass",
      severity: execution.realExecutionEnabled ? "medium" : "info",
      message: execution.realExecutionEnabled
        ? "当前环境允许真实执行。适合私有测试，但公开发布/演示前应切回 dry_run。"
        : "默认 dry-run，适合演示、调试和开发者预览。",
    },
    {
      id: "direct_provider_actions_disabled",
      label: "Provider 直连执行关闭",
      status: "pass",
      severity: "critical",
      message: "真实动作必须经过 HCM、Safety、Policy、Simulation、Decision Review 和 Audit。",
    },
    {
      id: "agents_shadow_mode",
      label: "Agents Shadow Mode",
      status: "pass",
      severity: "medium",
      message: "后台 agents 只生成建议，不写 overlay、不执行设备。",
    },
    {
      id: "automation_shadow_mode",
      label: "自动化建议不执行",
      status: "pass",
      severity: "medium",
      message: "自动化建议仅可模拟、审核或忽略，不能启用真实自动化。",
    },
    {
      id: "onboarding_baseline",
      label: "Provider baseline",
      status: hasOnboardingBaseline ? "pass" : "warning",
      severity: "medium",
      message: hasOnboardingBaseline
        ? "已有 provider baseline，可检测新增/变更设备。"
        : "尚未记录 provider baseline；新增设备检测会退化为初始候选。",
    },
    {
      id: "command_audit",
      label: "Command Audit",
      status: commandAuditEnabled ? "pass" : "blocker",
      severity: "critical",
      message: commandAuditEnabled ? "命令审计已启用。" : "缺少命令审计，无法发布真实执行链路。",
    },
  ];
  const blockerCount = checks.filter((item) => item.status === "blocker").length;
  const warningCount = checks.filter((item) => item.status === "warning").length;
  return {
    version: RELEASE_GATE_VERSION,
    generatedAt: new Date().toISOString(),
    execution,
    release: {
      currentTarget: "v0.24 Runtime Gate",
      nextTarget: "v0.25 Release Candidate Prep",
      status: blockerCount > 0 ? "blocked" : warningCount > 0 ? "ready_with_warnings" : "ready",
      blockerCount,
      warningCount,
      definition: "私有本地运行可用；真实执行必须显式启用，默认 dry-run。",
    },
    checks,
    nextGaps: [
      "把状态可信度覆盖到所有主要设备类型，而不只传感器和逻辑灯。",
      "补齐固定意图回归集：模糊指令、上下文指令、状态查询、失败恢复。",
      "把 HA onboarding 建议提升为独立可审核配置页。",
      "整理公开发布文档：密钥轮换、真实执行开关、HA 权限最小化。",
    ],
  };
}

function check({ id, label, ok, severity, pass, fail }) {
  return {
    id,
    label,
    status: ok ? "pass" : "blocker",
    severity,
    message: ok ? pass : fail,
  };
}
