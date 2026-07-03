export function createCommandTrace({ input, path = "hcm-real", source = "text", dryRun = false, replayOf, now = () => Date.now() } = {}) {
  const startedAt = now();
  return {
    commandId: crypto.randomUUID(),
    input,
    path,
    source,
    dryRun,
    replayOf,
    startedAt,
    stages: [],
    status: "running",
  };
}

export async function runCommandStage(trace, name, fn, { now = () => Date.now(), summarize = defaultSummary } = {}) {
  const startedAt = now();
  try {
    const result = await fn();
    trace.stages.push({
      name,
      latencyMs: Math.max(0, now() - startedAt),
      status: "ok",
      summary: summarize(result),
    });
    return result;
  } catch (error) {
    trace.stages.push({
      name,
      latencyMs: Math.max(0, now() - startedAt),
      status: "error",
      error: error.message,
    });
    throw error;
  }
}

export function finishCommandTrace(trace, { status, plan, execution, explanation, agents, conversation, model, planner } = {}, now = () => Date.now()) {
  const finishedAt = now();
  const safety = summarizeSafety(plan, execution);
  const entry = {
    commandId: trace.commandId,
    input: trace.input,
    path: trace.path,
    source: trace.source,
    dryRun: trace.dryRun,
    replayOf: trace.replayOf,
    status,
    model,
    latencyMs: Math.max(0, finishedAt - trace.startedAt),
    startedAt: new Date(trace.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    stages: trace.stages,
    planner,
    plan: summarizePlan(plan),
    execution: summarizeExecution(execution),
    explanation: summarizeExplanation(explanation),
    agents: summarizeAgents(agents),
    conversation: conversation
      ? {
          focusedTargets: conversation.focusedTargets,
          focusedRooms: conversation.focusedRooms,
          pendingPartialExecution: conversation.pendingPartialExecution
            ? {
                intent: conversation.pendingPartialExecution.intent,
                targetCount: conversation.pendingPartialExecution.targets?.length ?? 0,
                actionCount: conversation.pendingPartialExecution.actions?.length ?? 0,
              }
            : null,
          recentTurnCount: conversation.recentTurns?.length ?? 0,
        }
      : null,
    safety,
  };
  trace.status = status;
  return entry;
}

function summarizeAgents(agents) {
  if (!agents) return null;
  return {
    version: agents.version,
    mode: agents.mode,
    generatedAt: agents.generatedAt,
    summary: agents.summary,
    context: agents.agents?.context
      ? {
          likelySpace: agents.agents.context.likelySpace
            ? {
                id: agents.agents.context.likelySpace.id,
                name: agents.agents.context.likelySpace.name,
                occupied: agents.agents.context.likelySpace.occupied,
                confidence: agents.agents.context.likelySpace.confidence,
              }
            : null,
          occupiedSpaces: agents.agents.context.spaces?.filter((space) => space.occupied).length ?? 0,
        }
      : null,
    mapping: agents.agents?.mapping
      ? {
          candidateCount: agents.agents.mapping.candidates?.length ?? 0,
          protectedCandidates: agents.agents.mapping.summary?.protectedCandidates ?? 0,
        }
      : null,
    learning: agents.agents?.learning
      ? {
          candidateCount: agents.agents.learning.candidates?.length ?? 0,
          autoAppliedCount: agents.agents.learning.summary?.autoAppliedCount ?? 0,
        }
      : null,
    diagnostics: agents.agents?.diagnostics
      ? {
          findingCount: agents.agents.diagnostics.findings?.length ?? 0,
          highFindings: agents.agents.diagnostics.findings?.filter((finding) => finding.severity === "high").length ?? 0,
        }
      : null,
    test: agents.agents?.test
      ? {
          generatedCount: agents.agents.test.testCases?.length ?? 0,
          safetyCount: agents.agents.test.summary?.safetyCount ?? 0,
        }
      : null,
  };
}

export function summarizeSafety(plan, execution) {
  const accepted = execution?.accepted ?? [];
  const rejected = execution?.rejected ?? [];
  const highestRisk = accepted.reduce((risk, item) => higherRisk(risk, item.risk || "low"), "low");
  return {
    level: highestRisk,
    confirmationRequired: Boolean(plan?.needsConfirmation),
    rejectedCount: rejected.length,
    executableCount: accepted.length,
    dryRun: Boolean(execution?.dryRun),
  };
}

function summarizePlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    kind: plan.kind,
    intent: plan.intent,
    intentType: plan.intentType,
    confidence: plan.confidence,
    summary: plan.summary,
    actionCount: plan.actions?.length ?? plan.steps?.length ?? 0,
    stateQuery: plan.stateQuery
      ? {
          thingId: plan.stateQuery.thingId,
          thingName: plan.stateQuery.thingName,
          roomId: plan.stateQuery.roomId,
          available: plan.stateQuery.available,
          state: plan.stateQuery.state,
          summary: plan.stateQuery.summary,
          mode: plan.stateQuery.mode,
          count: plan.stateQuery.count,
          items: plan.stateQuery.items?.map((item) => ({ id: item.id, name: item.name, roomId: item.roomId, type: item.type })),
        }
      : null,
    contextFocus: plan.contextFocus
      ? {
          rooms: plan.contextFocus.rooms,
          reason: plan.contextFocus.reason,
        }
      : null,
    groupResolution: plan.groupResolution
      ? {
          mode: plan.groupResolution.mode,
          groups: plan.groupResolution.groups,
          unresolved: plan.groupResolution.unresolved,
          blocked: plan.groupResolution.blocked,
        }
      : null,
    resolution: plan.resolution
      ? {
          type: plan.resolution.type,
          targetStatus: plan.resolution.targetResolution?.status,
          capabilityStatus: plan.resolution.capabilityResolution?.status,
        }
      : null,
    intentFrame: plan.intentFrame
      ? {
          version: plan.intentFrame.version,
          source: plan.intentFrame.source,
          intentType: plan.intentFrame.intentType,
          domain: plan.intentFrame.goal?.domain,
          outcome: plan.intentFrame.goal?.outcome,
          decisionMode: plan.intentFrame.decision?.mode,
          ambiguityLevel: plan.intentFrame.ambiguity?.level,
        }
      : null,
    grounding: plan.grounding
      ? {
          version: plan.grounding.version,
          status: plan.grounding.status,
          candidateCount: plan.grounding.targetCandidates?.length ?? 0,
          ambiguityLevel: plan.grounding.ambiguity?.level,
        }
      : null,
    rejected: plan.rejected ?? [],
  };
}

function summarizeExecution(execution) {
  if (!execution) return null;
  return {
    status: execution.status,
    acceptedCount: execution.accepted?.length ?? 0,
    rejectedCount: execution.rejected?.length ?? 0,
    resultCount: execution.results?.length ?? 0,
    services: (execution.accepted ?? []).map((item) => ({
      thingId: item.thingId,
      thingName: item.thingName,
      capabilityId: item.capabilityId,
      capabilityName: item.capabilityName,
      value: item.value,
      service: item.service,
      serviceData: item.serviceData,
      simulation: item.simulation,
    })),
    simulation: execution.simulation
      ? {
          ok: execution.simulation.ok,
          rejectedCount: execution.simulation.rejected?.length ?? 0,
          assumedCount: execution.simulation.checks?.filter((check) => check.code === "assumed_supported").length ?? 0,
        }
      : null,
    decisionReview: execution.decisionReview
      ? {
          version: execution.decisionReview.version,
          status: execution.decisionReview.status,
          ok: execution.decisionReview.ok,
          issueCount: execution.decisionReview.issues?.length ?? 0,
          recoveryMode: execution.decisionReview.recovery?.mode,
          summary: execution.decisionReview.summary,
        }
      : null,
    results: (execution.results ?? []).map((result) => ({
      ok: result.ok,
      thingId: result.thingId,
      thingName: result.thingName,
      capabilityId: result.capabilityId,
      service: result.service,
      error: result.error,
      verification: result.verification,
    })),
  };
}

function summarizeExplanation(explanation) {
  if (!explanation) return null;
  return {
    title: explanation.title,
    summary: explanation.summary,
    userMessage: explanation.userMessage,
    intent: explanation.intent,
    targets: explanation.targets ?? [],
    services: explanation.services ?? [],
    safety: explanation.safety,
    hints: explanation.hints ?? [],
  };
}

function higherRisk(first, second) {
  return riskRank(second) > riskRank(first) ? second : first;
}

function riskRank(risk) {
  if (risk === "sensitive") return 4;
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function defaultSummary(result) {
  if (Array.isArray(result)) return { count: result.length };
  if (!result || typeof result !== "object") return {};
  if ("stats" in result) return { stats: result.stats };
  if ("actions" in result) return { actionCount: result.actions.length, summary: result.summary };
  if ("accepted" in result) return { accepted: result.accepted.length, rejected: result.rejected.length };
  return {};
}
