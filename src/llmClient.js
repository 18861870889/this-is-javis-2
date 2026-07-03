import { commandStep, createPlan } from "./simulator.js";
import {
  createManifestRegistry,
  summarizeManifestsForPlanner,
  validateActionAgainstManifest,
} from "./deviceRuntime.js";

export async function getLlmStatus() {
  try {
    const response = await fetch("/api/llm/status");
    if (!response.ok) throw new Error(`status ${response.status}`);
    return response.json();
  } catch (error) {
    return {
      configured: false,
      mode: "simulated",
      error: error.message,
    };
  }
}

export async function requestLlmPlan({ input, devices, currentRoomId, selectedRoomId, timeoutMs = 1500 }) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("/api/llm/plan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        currentRoomId,
        selectedRoomId,
        devices: summarizeManifestsForPlanner(devices),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `LLM request failed: ${response.status}`);
    }

    const data = await response.json();
    return normalizeLlmDraft(input, data, devices);
  } finally {
    window.clearTimeout(timer);
  }
}

export function normalizeLlmDraft(input, draft, devices) {
  const actions = Array.isArray(draft.actions) ? draft.actions : [];
  const steps = [];
  const rejected = [];
  const manifests = createManifestRegistry(devices);

  for (const action of actions) {
    const device = devices[action.device_id];
    const result = validateActionAgainstManifest(action, manifests[action.device_id]);
    if (!result.ok) {
      rejected.push(`${result.code}: ${result.message}`);
      continue;
    }
    steps.push(
      commandStep(
        device,
        result.action.capability,
        result.action.value,
        action.reason || `LLM requested ${result.action.capability} for ${device.name}`,
      ),
    );
  }

  const needsConfirmation =
    Boolean(draft.needs_confirmation) ||
    steps.some((step) => ["high", "sensitive"].includes(step.risk));

  return createPlan({
    input,
    path: "llm-real",
    intent: draft.intent || "llm_control",
    confidence: clampConfidence(draft.confidence),
    devices,
    needsConfirmation,
    steps,
    summary:
      draft.summary ||
      (steps.length > 0
        ? `真实大模型生成了 ${steps.length} 个设备动作。`
        : `真实大模型没有生成可执行动作。${rejected.join("；")}`),
  });
}

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.6;
  return Math.max(0, Math.min(1, value));
}
