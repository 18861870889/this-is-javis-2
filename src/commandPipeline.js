import { parseCommand } from "./simulator.js";

export async function planCommand({
  input,
  devices,
  currentRoomId,
  selectedRoomId,
  llmStatus,
  requestRealPlan,
  wait = defaultWait,
  clock = () => performance.now(),
}) {
  const commandId = crypto.randomUUID();
  const startedAt = clock();
  const stages = [];

  const routeStart = clock();
  let plan = parseCommand(input, devices, {
    currentRoomId,
    selectedRoomId,
  });
  stages.push(stage("router", routeStart, clock(), { path: plan.path ?? "empty" }));

  let fallbackError = null;
  if (plan.path === "llm-sim") {
    if (llmStatus.configured) {
      const llmStart = clock();
      try {
        plan = await requestRealPlan({
          input,
          devices,
          currentRoomId,
          selectedRoomId,
          timeoutMs: 3000,
        });
        stages.push(stage("llm_planner", llmStart, clock(), { mode: "real" }));
      } catch (error) {
        fallbackError = error;
        stages.push(stage("llm_planner", llmStart, clock(), { mode: "fallback", error: error.message }));
        const fallbackStart = clock();
        await wait(180);
        stages.push(stage("fallback_delay", fallbackStart, clock()));
      }
    } else {
      const simStart = clock();
      await wait(640 + Math.round(Math.random() * 220));
      stages.push(stage("llm_planner", simStart, clock(), { mode: "simulated" }));
    }
  } else {
    const fastStart = clock();
    await wait(70 + Math.round(Math.random() * 60));
    stages.push(stage("fast_path_delay", fastStart, clock()));
  }

  const safetyStart = clock();
  stages.push(
    stage("safety_gate", safetyStart, clock(), {
      needsConfirmation: Boolean(plan.needsConfirmation),
      rejectedSteps: plan.rejectedSteps?.length ?? 0,
    }),
  );

  const commandResult = {
    commandId,
    status: plan.kind === "empty" ? "empty" : plan.needsConfirmation ? "needs_confirmation" : "planned",
    path: plan.path ?? "empty",
    latencyMs: Math.round(clock() - startedAt),
    stages,
    fallbackError: fallbackError?.message ?? null,
  };

  return {
    plan: plan.kind === "empty" ? plan : { ...plan, commandResult },
    commandResult,
    fallbackError,
  };
}

function stage(name, startedAt, finishedAt, meta = {}) {
  return {
    name,
    latencyMs: Math.max(0, Math.round(finishedAt - startedAt)),
    ...meta,
  };
}

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
