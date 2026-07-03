import { validatePlanSteps } from "./deviceRuntime.js";

export function validatePlanDraft({ steps, devices, needsConfirmation = false, summary = "" }) {
  const validation = devices ? validatePlanSteps(steps, devices) : { validSteps: steps, rejected: [] };
  const risk = summarizeRisk(validation.validSteps);
  const confirmationRequired =
    needsConfirmation ||
    risk.highRisk ||
    risk.sensitiveRisk ||
    validation.validSteps.some((step) => step.confirmation === "always");

  return {
    status: validation.rejected.length > 0 && validation.validSteps.length === 0 ? "blocked" : "valid",
    steps: validation.validSteps,
    rejectedSteps: validation.rejected,
    risk,
    confirmationRequired,
    summary: buildValidatedSummary(summary, validation),
  };
}

function summarizeRisk(steps) {
  const levels = new Set(steps.map((step) => step.risk));
  return {
    levels: Array.from(levels),
    highRisk: levels.has("high"),
    sensitiveRisk: levels.has("sensitive"),
    mediumRisk: levels.has("medium"),
  };
}

function buildValidatedSummary(summary, validation) {
  if (validation.rejected.length === 0 || validation.validSteps.length > 0) return summary;
  return `${summary} 但计划被能力边界拦截：${validation.rejected.map((item) => item.message).join("；")}`;
}
