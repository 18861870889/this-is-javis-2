import express from "express";
import { createServer as createViteServer } from "vite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HOME_ASSISTANT_ADAPTER_ID, createHomeAssistantAdapter } from "./src/adapters/homeAssistantAdapter.js";
import { createProviderAdapterRegistry } from "./src/adapters/providerAdapterRegistry.js";
import { runAgentRuntime, runContextAgent } from "./src/agentRuntime.js";
import {
  captureHomeEventSnapshot,
  createAutomationMemory,
  deriveAutomationSuggestions,
  simulateAutomationSuggestion,
  summarizeAutomationSuggestions,
  updateAutomationSuggestionDecision,
} from "./src/automationSuggestionEngine.js";
import { planProviderOnboarding } from "./src/providerOnboarding.js";
import { createProviderSnapshot } from "./src/providerSync.js";
import {
  applyDefaultRunPolicy,
  applyHcmOverlay,
  createHcmOverlay,
  setBindingReviewDecision,
  setControlEndpointMapping,
  setThingOverride,
} from "./src/hcmOverlay.js";
import { buildHcmExecutionPlan } from "./src/hcmExecutor.js";
import { executeSimulatedProviderPlan, simulateProviderExecutionPlan, verifyProviderExecutionResults } from "./src/providerExecutionRuntime.js";
import { evaluateExecutionPolicy } from "./src/policyEngine.js";
import {
  buildNoPlannerDevicesDraft,
  buildHcmPlannerSystemPrompt,
  compileHcmForPlanner,
  normalizeHcmPlannerDraft,
} from "./src/hcmPlanner.js";
import { buildPromptContextPackV2, summarizePromptContextPack } from "./src/intentFrame.js";
import { expandBatchActions } from "./src/batchExpander.js";
import { explainIntentResult } from "./src/intentExplainer.js";
import { applyIntentAccuracyGate, evaluateIntentAccuracy } from "./src/intentAccuracyEngine.js";
import { reviewDecisionBeforeExecution } from "./src/decisionReview.js";
import {
  applyPersonalSemanticsToThingAliases,
  compilePersonalSemanticsForPlanner,
} from "./src/personalSemantics.js";
import { createCommandTrace, finishCommandTrace, runCommandStage } from "./src/commandRuntime.js";
import { createConversationContextStore } from "./src/conversationContext.js";
import {
  createLearningMemory,
  compileHouseholdLearningContext,
  deleteLearningCandidate,
  recordLearningObservation,
  summarizeLearningMemory,
  updateLearningCandidate,
} from "./src/learningLayer.js";
import {
  applyJarvisLearningFeedback,
  selectUserVisibleLearningSuggestion,
} from "./src/jarvisLearningFeedback.js";
import {
  buildDuplicateUtteranceResponse,
  buildHcmPayloadFromUtterance,
  buildHermesUnavailableResponse,
  buildUtteranceDedupeKey,
  classifyUtterance,
  formatVoiceBridgeResponse,
  normalizeUtterancePayload,
} from "./src/jarvisVoiceBridge.js";
import {
  createPendingPromptQueue,
  enqueuePendingPrompt,
  resolvePendingPromptForFeedback,
  updatePendingPromptDecision,
} from "./src/jarvisPendingPromptQueue.js";
import { buildRuntimeStatus, getExecutionMode } from "./src/releaseGate.js";
import { createSpatialEditorState, hasSpatialEditorEdits } from "./src/spatialHomeEditor.js";

const app = express();
loadLocalEnv();
const port = getCliPort() ?? Number(process.env.PORT ?? 5173);
const hcmOverlayPath = resolve(process.cwd(), process.env.HARNESS_HCM_OVERLAY_PATH || "data/home-model-overlay.local.json");
const commandAuditPath = resolve(process.cwd(), process.env.HARNESS_COMMAND_AUDIT_PATH || "data/command-audit.local.jsonl");
const learningMemoryPath = resolve(process.cwd(), process.env.HARNESS_LEARNING_MEMORY_PATH || "data/learning-memory.local.json");
const providerSnapshotPath = resolve(process.cwd(), process.env.HARNESS_PROVIDER_SNAPSHOT_PATH || "data/provider-snapshot.local.json");
const automationMemoryPath = resolve(process.cwd(), process.env.HARNESS_AUTOMATION_MEMORY_PATH || "data/automation-memory.local.json");
const spatialEditorPath = resolve(process.cwd(), process.env.HARNESS_SPATIAL_EDITOR_PATH || "data/spatial-editor.local.json");
const pendingPromptQueuePath = resolve(process.cwd(), process.env.JARVIS_PENDING_PROMPT_QUEUE_PATH || "data/pending-prompts.local.json");
const stackchanDeviceRooms = parseStackChanDeviceRooms(process.env.JARVIS_STACKCHAN_DEVICE_ROOMS);
const configuredVoiceDedupeWindowMs = Number(process.env.JARVIS_UTTERANCE_DEDUPE_WINDOW_MS ?? 1500);
const voiceUtteranceDedupeWindowMs = Number.isFinite(configuredVoiceDedupeWindowMs) && configuredVoiceDedupeWindowMs > 0
  ? configuredVoiceDedupeWindowMs
  : 1500;
const voiceUtteranceDedupe = new Map();
const homeAssistantAdapter = createHomeAssistantAdapter({
  baseUrl: process.env.HA_BASE_URL || process.env.HOME_ASSISTANT_URL,
  token: process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN,
});
const providerRegistry = createProviderAdapterRegistry([homeAssistantAdapter]);
const activeProviderAdapter = providerRegistry.get(HOME_ASSISTANT_ADAPTER_ID);
const conversationContextStore = createConversationContextStore();

app.use(express.json({ limit: "20mb" }));

app.get("/api/runtime/status", (_request, response) => {
  response.json(buildRuntimeStatus({
    env: process.env,
    haConfigured: homeAssistantAdapter.isConfigured(),
    llmConfigured: Boolean(process.env.OPENAI_API_KEY),
    hasOnboardingBaseline: Boolean(readProviderSnapshotRecord()?.graph),
    commandAuditEnabled: Boolean(commandAuditPath),
  }));
});

app.get("/api/spatial-editor/state", (_request, response) => {
  const record = readSpatialEditorRecord();
  response.json({
    exists: Boolean(record),
    updatedAt: record?.updatedAt ?? null,
    source: record?.source ?? "default",
    hasEdits: hasSpatialEditorEdits(record?.state),
    state: createSpatialEditorState(record?.state),
  });
});

app.put("/api/spatial-editor/state", (request, response) => {
  try {
    const payload = request.body ?? {};
    validateSpatialEditorStateRequest(payload);
    const record = {
      version: "0.1",
      updatedAt: new Date().toISOString(),
      source: typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : "browser",
      state: createSpatialEditorState(payload.state),
    };
    writeSpatialEditorRecord(record);
    response.json({
      exists: true,
      updatedAt: record.updatedAt,
      source: record.source,
      hasEdits: hasSpatialEditorEdits(record.state),
      state: record.state,
    });
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: error.message || "Spatial editor state update failed",
    });
  }
});

app.get("/api/llm/status", (_request, response) => {
  response.json({
    configured: Boolean(process.env.OPENAI_API_KEY),
    provider: process.env.OPENAI_BASE_URL ? "openai-compatible" : "openai",
    model: getModel(),
    mode: process.env.OPENAI_API_KEY ? "real" : "simulated",
  });
});

app.post("/api/llm/plan", async (request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(503).json({
      error: "OPENAI_API_KEY is not configured; frontend should use LLM Sim fallback.",
    });
    return;
  }

  const startedAt = Date.now();

  try {
    const payload = request.body ?? {};
    validatePlanRequest(payload);
    const draft = await callPlannerModel(payload);
    response.json({
      ...draft,
      provider_latency_ms: Date.now() - startedAt,
      model: getModel(),
    });
  } catch (error) {
    response.status(error.statusCode || 500).json({
      error: error.message || "LLM planning failed",
    });
  }
});

app.get("/api/adapters/home-assistant/status", (_request, response) => {
  response.json(homeAssistantAdapter.getStatus());
});

app.get("/api/adapters", async (_request, response) => {
  try {
    response.json({ adapters: await providerRegistry.list() });
  } catch (error) {
    response.status(500).json({ error: error.message || "Adapter registry failed" });
  }
});

app.get("/api/adapters/home-assistant/entities", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({
      error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN.",
    });
    return;
  }

  try {
    const entities = await homeAssistantAdapter.discoverEntities();
    response.json({
      adapter: homeAssistantAdapter.id,
      count: entities.length,
      entities,
    });
  } catch (error) {
    response.status(502).json({
      error: error.message || "Home Assistant discovery failed",
    });
  }
});

app.get("/api/hcm/home", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({
      error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN.",
    });
    return;
  }

  try {
    const home = await homeAssistantAdapter.discoverHcmHome();
    response.json(applyHcmOverlay(home, readHcmOverlay()));
  } catch (error) {
    response.status(502).json({
      error: error.message || "Home Capability Model sync failed",
    });
  }
});

app.get("/api/hcm/overrides", (_request, response) => {
  response.json(readHcmOverlay());
});

app.post("/api/hcm/overrides/bindings", (request, response) => {
  try {
    const payload = request.body ?? {};
    validateBindingOverrideRequest(payload);
    const overlay = setBindingReviewDecision(readHcmOverlay(), {
      providerId: payload.providerId || HOME_ASSISTANT_ADAPTER_ID,
      entityId: payload.entityId,
      action: payload.action,
    });
    writeHcmOverlay(overlay);
    response.json(overlay);
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: error.message || "HCM override update failed",
    });
  }
});

app.post("/api/hcm/overrides/things", (request, response) => {
  try {
    const payload = request.body ?? {};
    validateThingOverrideRequest(payload);
    const overlay = setThingOverride(readHcmOverlay(), {
      providerId: payload.providerId || HOME_ASSISTANT_ADAPTER_ID,
      thingId: payload.thingId,
      patch: payload.patch,
    });
    writeHcmOverlay(overlay);
    response.json(overlay);
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: error.message || "HCM thing override update failed",
    });
  }
});

app.post("/api/hcm/overrides/control-mappings", (request, response) => {
  try {
    const payload = request.body ?? {};
    validateControlMappingRequest(payload);
    const overlay = setControlEndpointMapping(readHcmOverlay(), {
      providerId: payload.providerId || HOME_ASSISTANT_ADAPTER_ID,
      entityId: payload.entityId,
      patch: payload.patch,
    });
    writeHcmOverlay(overlay);
    response.json(overlay);
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: error.message || "HCM control mapping update failed",
    });
  }
});

app.post("/api/hcm/overrides/default-run", async (request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({
      error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN.",
    });
    return;
  }

  try {
    const payload = request.body ?? {};
    validateDefaultRunRequest(payload);
    const home = await homeAssistantAdapter.discoverHcmHome();
    const { overlay, summary } = applyDefaultRunPolicy(readHcmOverlay(), home, {
      providerId: payload.providerId || home.provider?.id || HOME_ASSISTANT_ADAPTER_ID,
    });
    writeHcmOverlay(overlay);
    response.json({
      summary,
      home: applyHcmOverlay(home, overlay),
    });
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: error.message || "HCM default-run update failed",
    });
  }
});

app.post("/api/hcm/command", async (request, response) => {
  try {
    const payload = request.body ?? {};
    validateHcmCommandRequest(payload);
    response.json(await runHcmCommandPipeline(payload));
  } catch (error) {
    response.status(error.statusCode || 502).json({
      error: error.message || "HCM command failed",
    });
  }
});

app.post("/v1/utterance", async (request, response) => {
  let dedupeKey = "";
  try {
    const utterance = applyTrustedStackChanRoom(normalizeUtterancePayload(request.body ?? {}));
    dedupeKey = buildUtteranceDedupeKey(utterance);
    const existing = findRecentVoiceUtterance(dedupeKey);
    if (existing) {
      response.json(buildDuplicateUtteranceResponse({
        utterance,
        handledByDeviceId: existing.deviceId,
        dedupeKey,
      }));
      return;
    }
    rememberVoiceUtterance(dedupeKey, utterance);
    const result = await handleJarvisUtterance(utterance, request.body ?? {});
    response.json({
      ...result,
      duplicate: false,
      handledByDeviceId: utterance.deviceId,
      dedupeKey,
    });
  } catch (error) {
    if (dedupeKey) voiceUtteranceDedupe.delete(dedupeKey);
    response.status(error.statusCode || 502).json({ error: error.message || "Jarvis utterance failed" });
  }
});

app.post("/v1/learning/feedback", async (request, response) => {
  try {
    response.json(await applyLearningFeedbackRequest(request.body ?? {}));
  } catch (error) {
    response.status(error.statusCode || 400).json({ error: error.message || "Learning feedback failed" });
  }
});

app.get("/api/agents/snapshot", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({
      error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN.",
    });
    return;
  }

  try {
    response.json(await buildAgentSnapshot());
  } catch (error) {
    response.status(502).json({
      error: error.message || "Agent snapshot failed",
    });
  }
});

app.get("/api/onboarding/plan", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({
      error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN.",
    });
    return;
  }

  try {
    const nextGraph = await homeAssistantAdapter.discoverDeviceGraph();
    const previous = readProviderSnapshotRecord();
    const currentSnapshot = createProviderSnapshot(nextGraph);
    response.json({
      previousSnapshotHash: previous?.snapshot?.hash ?? null,
      currentSnapshotHash: currentSnapshot.hash,
      hasBaseline: Boolean(previous?.graph),
      plan: planProviderOnboarding({
        previousGraph: previous?.graph,
        nextGraph,
      }),
    });
  } catch (error) {
    response.status(error.statusCode || 502).json({
      error: error.message || "Provider onboarding plan failed",
    });
  }
});

app.post("/api/onboarding/snapshot", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({
      error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN.",
    });
    return;
  }

  try {
    const graph = await homeAssistantAdapter.discoverDeviceGraph();
    const snapshot = createProviderSnapshot(graph);
    const record = {
      version: "0.1",
      updatedAt: new Date().toISOString(),
      provider: graph.provider ?? { id: HOME_ASSISTANT_ADAPTER_ID, name: "Home Assistant" },
      snapshot,
      graph,
    };
    writeProviderSnapshotRecord(record);
    response.json({
      updatedAt: record.updatedAt,
      provider: record.provider,
      snapshotHash: snapshot.hash,
      deviceCount: graph.devices?.length ?? 0,
      entityCount: graph.entities?.length ?? 0,
    });
  } catch (error) {
    response.status(error.statusCode || 502).json({
      error: error.message || "Provider onboarding snapshot failed",
    });
  }
});

app.get("/api/commands/audit", (request, response) => {
  const limit = Math.max(1, Math.min(100, Number(request.query.limit ?? 20)));
  response.json({
    entries: readCommandAuditEntries(limit),
  });
});

app.post("/api/commands/replay", async (request, response) => {
  try {
    const payload = request.body ?? {};
    validateReplayRequest(payload);
    const entry = readCommandAuditEntries(200).find((item) => item.commandId === payload.commandId);
    if (!entry) {
      response.status(404).json({ error: "Command audit entry not found" });
      return;
    }
    const replayResponse = await runHcmCommandPipeline({
      input: entry.input,
      currentRoomId: payload.currentRoomId,
      selectedRoomId: payload.selectedRoomId,
      dryRun: true,
      replayOf: entry.commandId,
    });
    response.json(replayResponse);
  } catch (error) {
    response.status(error.statusCode || 502).json({
      error: error.message || "Command replay failed",
    });
  }
});

app.get("/api/learning/memory", (_request, response) => {
  response.json(summarizeLearningMemory(readLearningMemory()));
});

app.get("/api/automation/suggestions", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({ error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN." });
    return;
  }
  try {
    const home = await discoverCurrentHcmHome();
    const memory = readAutomationMemory();
    const suggestions = deriveAutomationSuggestions({ memory, auditEntries: readCommandAuditEntries(200), home });
    response.json(summarizeAutomationSuggestions(memory, suggestions));
  } catch (error) {
    response.status(error.statusCode || 502).json({ error: error.message || "Automation suggestions failed" });
  }
});

app.post("/api/automation/events/capture", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({ error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN." });
    return;
  }
  try {
    const home = await discoverCurrentHcmHome();
    const captured = captureHomeEventSnapshot(readAutomationMemory(), home);
    writeAutomationMemory(captured.memory);
    const suggestions = deriveAutomationSuggestions({
      memory: captured.memory,
      auditEntries: readCommandAuditEntries(200),
      home,
    });
    response.json({
      ...summarizeAutomationSuggestions(captured.memory, suggestions),
      capturedEvents: captured.events,
      realDeviceControl: false,
    });
  } catch (error) {
    response.status(error.statusCode || 502).json({ error: error.message || "Automation event capture failed" });
  }
});

app.patch("/api/automation/suggestions/:suggestionId", async (request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({ error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN." });
    return;
  }
  try {
    const status = request.body?.status;
    const home = await discoverCurrentHcmHome();
    const current = readAutomationMemory();
    const suggestions = deriveAutomationSuggestions({ memory: current, auditEntries: readCommandAuditEntries(200), home });
    if (!suggestions.some((item) => item.id === request.params.suggestionId)) {
      response.status(404).json({ error: "Automation suggestion not found" });
      return;
    }
    const memory = updateAutomationSuggestionDecision(current, request.params.suggestionId, status);
    writeAutomationMemory(memory);
    const updatedSuggestions = deriveAutomationSuggestions({ memory, auditEntries: readCommandAuditEntries(200), home });
    response.json(summarizeAutomationSuggestions(memory, updatedSuggestions));
  } catch (error) {
    response.status(error.statusCode || 400).json({ error: error.message || "Automation suggestion update failed" });
  }
});

app.post("/api/automation/suggestions/:suggestionId/simulate", async (_request, response) => {
  if (!homeAssistantAdapter.isConfigured()) {
    response.status(503).json({ error: "Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN." });
    return;
  }
  try {
    const home = await discoverCurrentHcmHome();
    const memory = readAutomationMemory();
    const suggestions = deriveAutomationSuggestions({ memory, auditEntries: readCommandAuditEntries(200), home });
    const suggestion = suggestions.find((item) => item.id === _request.params.suggestionId);
    if (!suggestion) {
      response.status(404).json({ error: "Automation suggestion not found" });
      return;
    }
    response.json({ suggestionId: suggestion.id, preview: simulateAutomationSuggestion(suggestion, home) });
  } catch (error) {
    response.status(error.statusCode || 502).json({ error: error.message || "Automation suggestion simulation failed" });
  }
});

app.patch("/api/learning/candidates/:candidateId", (request, response) => {
  try {
    const memory = updateLearningCandidate(readLearningMemory(), request.params.candidateId, request.body ?? {});
    writeLearningMemory(memory);
    response.json(summarizeLearningMemory(memory));
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: error.message || "Learning candidate update failed",
    });
  }
});

app.delete("/api/learning/candidates/:candidateId", (request, response) => {
  try {
    const memory = deleteLearningCandidate(readLearningMemory(), request.params.candidateId);
    writeLearningMemory(memory);
    response.json(summarizeLearningMemory(memory));
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: error.message || "Learning candidate delete failed",
    });
  }
});

app.post("/api/adapters/home-assistant/actions", async (request, response) => {
  response.status(410).json({
    error: "Direct provider actions are disabled. Use /api/hcm/command so execution passes HCM, safety, policy, simulation, and audit gates.",
  });
});

const vite = await createViteServer({
  server: {
    middlewareMode: true,
  },
  appType: "spa",
});

app.use(vite.middlewares);

app.listen(port, "0.0.0.0", () => {
  console.log(`Harness House running at http://localhost:${port}/`);
  console.log(
    process.env.OPENAI_API_KEY
      ? `LLM Gateway enabled with model ${getModel()}`
      : "LLM Gateway running in simulated fallback mode. Set OPENAI_API_KEY to enable real model calls.",
  );
});

function getCliPort() {
  const args = process.argv.slice(2);
  const portFlag = args.findIndex((arg) => arg === "--port" || arg === "-p");
  if (portFlag >= 0 && args[portFlag + 1]) return Number(args[portFlag + 1]);
  const inline = args.find((arg) => arg.startsWith("--port="));
  if (inline) return Number(inline.split("=")[1]);
  return undefined;
}

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function getModel() {
  return process.env.OPENAI_MODEL || process.env.HARNESS_LLM_MODEL || "gpt-4o-mini";
}

function getBaseUrl() {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
}

function validatePlanRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (typeof payload.input !== "string" || !payload.input.trim()) {
    throw badRequest("input is required");
  }
  if (!Array.isArray(payload.devices) || payload.devices.length === 0) {
    throw badRequest("devices are required");
  }
}

function validateBindingOverrideRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (typeof payload.entityId !== "string" || !payload.entityId.trim()) {
    throw badRequest("entityId is required");
  }
  if (typeof payload.action !== "string" || !payload.action.trim()) {
    throw badRequest("action is required");
  }
  if (payload.providerId !== undefined && typeof payload.providerId !== "string") {
    throw badRequest("providerId must be a string");
  }
}

function validateDefaultRunRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (payload.providerId !== undefined && typeof payload.providerId !== "string") {
    throw badRequest("providerId must be a string");
  }
}

function validateThingOverrideRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (typeof payload.thingId !== "string" || !payload.thingId.trim()) {
    throw badRequest("thingId is required");
  }
  if (!payload.patch || typeof payload.patch !== "object" || Array.isArray(payload.patch)) {
    throw badRequest("patch is required");
  }
  if (payload.providerId !== undefined && typeof payload.providerId !== "string") {
    throw badRequest("providerId must be a string");
  }
}

function validateControlMappingRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (typeof payload.entityId !== "string" || !payload.entityId.trim()) {
    throw badRequest("entityId is required");
  }
  if (!payload.patch || typeof payload.patch !== "object" || Array.isArray(payload.patch)) {
    throw badRequest("patch is required");
  }
  if (payload.providerId !== undefined && typeof payload.providerId !== "string") {
    throw badRequest("providerId must be a string");
  }
}

function validateHcmCommandRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (typeof payload.input !== "string" || !payload.input.trim()) {
    throw badRequest("input is required");
  }
  if (payload.currentRoomId !== undefined && typeof payload.currentRoomId !== "string") {
    throw badRequest("currentRoomId must be a string");
  }
  if (payload.selectedRoomId !== undefined && typeof payload.selectedRoomId !== "string") {
    throw badRequest("selectedRoomId must be a string");
  }
  if (payload.dryRun !== undefined && typeof payload.dryRun !== "boolean") {
    throw badRequest("dryRun must be a boolean");
  }
  if (payload.source !== undefined && !["text", "voice", "replay"].includes(payload.source)) {
    throw badRequest("source must be text, voice, or replay");
  }
  if (payload.replayOf !== undefined && typeof payload.replayOf !== "string") {
    throw badRequest("replayOf must be a string");
  }
  if (payload.sessionId !== undefined && typeof payload.sessionId !== "string") {
    throw badRequest("sessionId must be a string");
  }
  if (payload.skipPlanner !== undefined && typeof payload.skipPlanner !== "boolean") {
    throw badRequest("skipPlanner must be a boolean");
  }
  if (payload.plannerDraft !== undefined && (typeof payload.plannerDraft !== "object" || Array.isArray(payload.plannerDraft))) {
    throw badRequest("plannerDraft must be an object");
  }
}

function validateReplayRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (typeof payload.commandId !== "string" || !payload.commandId.trim()) {
    throw badRequest("commandId is required");
  }
  if (payload.currentRoomId !== undefined && typeof payload.currentRoomId !== "string") {
    throw badRequest("currentRoomId must be a string");
  }
  if (payload.selectedRoomId !== undefined && typeof payload.selectedRoomId !== "string") {
    throw badRequest("selectedRoomId must be a string");
  }
}

function validateSpatialEditorStateRequest(payload) {
  if (!payload || typeof payload !== "object") throw badRequest("Invalid JSON body");
  if (!payload.state || typeof payload.state !== "object" || Array.isArray(payload.state)) {
    throw badRequest("state is required");
  }
  if (payload.source !== undefined && typeof payload.source !== "string") {
    throw badRequest("source must be a string");
  }
}

function readHcmOverlay() {
  if (!existsSync(hcmOverlayPath)) return createHcmOverlay();
  try {
    return JSON.parse(readFileSync(hcmOverlayPath, "utf8"));
  } catch (error) {
    throw new Error(`HCM overlay file is invalid JSON: ${error.message}`);
  }
}

function writeHcmOverlay(overlay) {
  mkdirSync(dirname(hcmOverlayPath), { recursive: true });
  writeFileSync(hcmOverlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
}

function readSpatialEditorRecord() {
  if (!existsSync(spatialEditorPath)) return null;
  try {
    const record = JSON.parse(readFileSync(spatialEditorPath, "utf8"));
    return {
      version: typeof record.version === "string" ? record.version : "0.1",
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
      source: typeof record.source === "string" ? record.source : "unknown",
      state: createSpatialEditorState(record.state),
    };
  } catch (error) {
    throw new Error(`Spatial editor file is invalid JSON: ${error.message}`);
  }
}

function writeSpatialEditorRecord(record) {
  mkdirSync(dirname(spatialEditorPath), { recursive: true });
  writeFileSync(spatialEditorPath, `${JSON.stringify(record, null, 2)}\n`);
}

function writeCommandAuditEntry(entry) {
  mkdirSync(dirname(commandAuditPath), { recursive: true });
  appendFileSync(commandAuditPath, `${JSON.stringify(entry)}\n`);
}

function readCommandAuditEntries(limit = 20) {
  if (!existsSync(commandAuditPath)) return [];
  return readFileSync(commandAuditPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => JSON.parse(line));
}

function readLearningMemory() {
  if (!existsSync(learningMemoryPath)) return createLearningMemory();
  try {
    return JSON.parse(readFileSync(learningMemoryPath, "utf8"));
  } catch (error) {
    throw new Error(`Learning memory file is invalid JSON: ${error.message}`);
  }
}

function writeLearningMemory(memory) {
  mkdirSync(dirname(learningMemoryPath), { recursive: true });
  writeFileSync(learningMemoryPath, `${JSON.stringify(memory, null, 2)}\n`);
}

function readProviderSnapshotRecord() {
  if (!existsSync(providerSnapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(providerSnapshotPath, "utf8"));
  } catch (error) {
    throw new Error(`Provider snapshot file is invalid JSON: ${error.message}`);
  }
}

function writeProviderSnapshotRecord(record) {
  mkdirSync(dirname(providerSnapshotPath), { recursive: true });
  writeFileSync(providerSnapshotPath, `${JSON.stringify(record, null, 2)}\n`);
}

function readAutomationMemory() {
  if (!existsSync(automationMemoryPath)) return createAutomationMemory();
  try {
    return JSON.parse(readFileSync(automationMemoryPath, "utf8"));
  } catch (error) {
    throw new Error(`Automation memory file is invalid JSON: ${error.message}`);
  }
}

function writeAutomationMemory(memory) {
  mkdirSync(dirname(automationMemoryPath), { recursive: true });
  writeFileSync(automationMemoryPath, `${JSON.stringify(memory, null, 2)}\n`);
}

function readPendingPromptQueue() {
  if (!existsSync(pendingPromptQueuePath)) return createPendingPromptQueue();
  try {
    return JSON.parse(readFileSync(pendingPromptQueuePath, "utf8"));
  } catch (error) {
    throw new Error(`Pending prompt queue file is invalid JSON: ${error.message}`);
  }
}

function writePendingPromptQueue(queue) {
  mkdirSync(dirname(pendingPromptQueuePath), { recursive: true });
  writeFileSync(pendingPromptQueuePath, `${JSON.stringify(queue, null, 2)}\n`);
}

async function discoverCurrentHcmHome() {
  const rawHome = await activeProviderAdapter.discoverHcmHome();
  return applyPersonalSemanticsToThingAliases(applyHcmOverlay(rawHome, readHcmOverlay()));
}

function updateLearningMemory(auditEntry) {
  const memory = recordLearningObservation(readLearningMemory(), auditEntry);
  writeLearningMemory(memory);
}

async function handleJarvisUtterance(utterance, rawPayload) {
  const classification = classifyUtterance(utterance.text);

  if (classification.route === "learning_feedback") {
    const feedback = await applyLearningFeedbackRequest({
      ...rawPayload,
      text: utterance.text,
      deviceId: utterance.deviceId,
      roomId: utterance.roomId,
      wakeSessionId: utterance.wakeSessionId,
      sessionId: utterance.wakeSessionId || utterance.deviceId,
    });
    return {
      version: "0.1",
      deviceId: utterance.deviceId,
      roomId: utterance.roomId,
      wakeSessionId: utterance.wakeSessionId,
      trigger: utterance.trigger,
      route: classification.route,
      routeReason: classification.reason,
      commandId: feedback.sourceCommandId || null,
      status: feedback.appliedTo === "none" ? "feedback_recorded" : "feedback_applied",
      risk: "low",
      speak: true,
      display: feedback.replyText,
      replyText: feedback.replyText,
      learnedSuggestion: null,
      latencyMs: 0,
      feedback,
    };
  }

  if (classification.route === "hcm_fast_path" || classification.route === "hcm_slow_path") {
    if (!homeAssistantAdapter.isConfigured()) {
      const fallbackClassification = {
        route: "hermes_slow_path",
        reason: classification.reason === "read_only_home_state_query"
          ? "home_state_or_inventory_query"
          : "hcm_unavailable",
      };
      const hermesResult = classification.reason === "read_only_home_state_query"
        ? await callHermesSlowPath(utterance)
        : null;
      if (hermesResult) return formatVoiceBridgeResponse({ utterance, classification: fallbackClassification, hermesResult });
      return formatVoiceBridgeResponse({
        utterance,
        classification,
        hermesResult: {
          status: "integration_unavailable",
          replyText: "我还没有连接 Home Assistant，暂时不能读取或控制家里的设备。",
          latencyMs: 0,
        },
      });
    }
    const hcmResult = await runHcmCommandPipeline(buildHcmPayloadFromUtterance(utterance, classification));
    const learningSuggestion = await buildUserVisibleLearningSuggestion(hcmResult.commandId, utterance);
    return formatVoiceBridgeResponse({ utterance, classification, hcmResult, learningSuggestion });
  }

  const hermesResult = await callHermesSlowPath(utterance);
  if (!hermesResult) return buildHermesUnavailableResponse(utterance, classification);
  return formatVoiceBridgeResponse({ utterance, classification, hermesResult });
}

function findRecentVoiceUtterance(dedupeKey) {
  const now = Date.now();
  for (const [key, record] of voiceUtteranceDedupe) {
    if (record.expiresAt <= now) voiceUtteranceDedupe.delete(key);
  }
  const record = voiceUtteranceDedupe.get(dedupeKey);
  if (!record || record.expiresAt <= now) return null;
  return record;
}

function parseStackChanDeviceRooms(raw = "") {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`JARVIS_STACKCHAN_DEVICE_ROOMS must be JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JARVIS_STACKCHAN_DEVICE_ROOMS must be a JSON object mapping deviceId to roomId");
  }
  return new Map(
    Object.entries(parsed)
      .filter(([deviceId, roomId]) => typeof deviceId === "string" && deviceId.trim() && typeof roomId === "string" && roomId.trim())
      .map(([deviceId, roomId]) => [deviceId.trim(), roomId.trim()]),
  );
}

function applyTrustedStackChanRoom(utterance) {
  const trustedRoomId = stackchanDeviceRooms.get(utterance.deviceId);
  if (!trustedRoomId || utterance.roomId === trustedRoomId) return utterance;
  return {
    ...utterance,
    reportedRoomId: utterance.roomId || "",
    roomId: trustedRoomId,
  };
}

function rememberVoiceUtterance(dedupeKey, utterance) {
  voiceUtteranceDedupe.set(dedupeKey, {
    deviceId: utterance.deviceId,
    roomId: utterance.roomId,
    createdAt: Date.now(),
    expiresAt: Date.now() + voiceUtteranceDedupeWindowMs,
  });
}

async function buildUserVisibleLearningSuggestion(sourceCommandId, utterance = null) {
  const learningSummary = summarizeLearningMemory(readLearningMemory());
  let automationSummary = null;
  if (homeAssistantAdapter.isConfigured()) {
    try {
      const home = await discoverCurrentHcmHome();
      const automationMemory = readAutomationMemory();
      const automationSuggestions = deriveAutomationSuggestions({
        memory: automationMemory,
        auditEntries: readCommandAuditEntries(200),
        home,
      });
      automationSummary = summarizeAutomationSuggestions(automationMemory, automationSuggestions);
    } catch {
      automationSummary = null;
    }
  }
  const suggestion = selectUserVisibleLearningSuggestion({ learningSummary, automationSummary, sourceCommandId });
  if (!suggestion) return null;
  const pending = enqueuePendingPrompt(readPendingPromptQueue(), suggestion, {
    context: {
      deviceId: utterance?.deviceId,
      roomId: utterance?.roomId,
      wakeSessionId: utterance?.wakeSessionId,
      sessionId: utterance?.wakeSessionId || utterance?.deviceId,
    },
  });
  writePendingPromptQueue(pending.queue);
  return {
    ...suggestion,
    pendingPromptId: pending.prompt?.id,
    expiresAt: pending.prompt?.expiresAt,
  };
}

async function applyLearningFeedbackRequest(payload) {
  const auditEntries = readCommandAuditEntries(200);
  let automationSuggestions = [];
  if (homeAssistantAdapter.isConfigured()) {
    try {
      const home = await discoverCurrentHcmHome();
      automationSuggestions = deriveAutomationSuggestions({
        memory: readAutomationMemory(),
        auditEntries,
        home,
      });
    } catch {
      automationSuggestions = [];
    }
  }
  const pendingResolution = resolvePendingPromptForFeedback(readPendingPromptQueue(), payload, {
    context: {
      deviceId: payload.deviceId,
      roomId: payload.roomId,
      wakeSessionId: payload.wakeSessionId,
      sessionId: payload.sessionId || payload.wakeSessionId || payload.deviceId,
    },
  });
  writePendingPromptQueue(pendingResolution.queue);
  const hasFeedbackTarget = Boolean(
    pendingResolution.payload.sourceCommandId ||
    pendingResolution.payload.candidateId ||
    pendingResolution.payload.suggestionId,
  );
  const feedbackPayload = {
    ...pendingResolution.payload,
    sourceCommandId: hasFeedbackTarget ? pendingResolution.payload.sourceCommandId : auditEntries[0]?.commandId,
  };
  const result = applyJarvisLearningFeedback({
    payload: feedbackPayload,
    learningMemory: readLearningMemory(),
    automationMemory: readAutomationMemory(),
    automationSuggestions,
    auditEntries,
  });
  if (result.learningMemory) writeLearningMemory(result.learningMemory);
  if (result.automationMemory) writeAutomationMemory(result.automationMemory);
  if (pendingResolution.prompt && result.appliedTo !== "none") {
    writePendingPromptQueue(updatePendingPromptDecision(readPendingPromptQueue(), pendingResolution.prompt.id, result.feedback));
  }
  const { learningMemory, automationMemory, ...publicResult } = result;
  return {
    ...publicResult,
    sourceCommandId: feedbackPayload.sourceCommandId || "",
    pendingPromptId: pendingResolution.prompt?.id || pendingResolution.payload.pendingPromptId || "",
  };
}

async function callHermesSlowPath(utterance) {
  const baseUrl = process.env.HERMES_API_BASE_URL || process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY || process.env.API_SERVER_KEY;
  if (!baseUrl) return null;
  const startedAt = Date.now();
  const configuredTimeoutMs = Number(process.env.HERMES_API_TIMEOUT_MS ?? 3500);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 3500;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(utterance.wakeSessionId ? { "X-Hermes-Session-Id": utterance.wakeSessionId } : {}),
      },
      body: JSON.stringify({
        model: process.env.HERMES_API_MODEL || "jarvis",
        messages: [
          {
            role: "system",
            content: "你是 JARVIS 的慢路径大脑。回答要适合语音播报，简短、明确、自然。",
          },
          {
            role: "user",
            content: utterance.text,
          },
        ],
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      return hermesFallbackResult({
        status: "brain_unavailable",
        replyText: "Hermes 慢路径现在暂时不可用，我先不继续处理这个问题。",
        latencyMs: Date.now() - startedAt,
        error: `Hermes API error ${response.status}: ${text.slice(0, 300)}`,
      });
    }
    const data = JSON.parse(text);
    return {
      status: "answered",
      replyText: data.choices?.[0]?.message?.content?.trim() || "Hermes 没有返回可播报内容。",
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return hermesFallbackResult({
      status: error.name === "AbortError" ? "brain_timeout" : "brain_unavailable",
      replyText: error.name === "AbortError"
        ? "Hermes 慢路径响应超时了，我先不继续处理这个问题。"
        : "Hermes 慢路径连接失败了，我先不继续处理这个问题。",
      latencyMs: Date.now() - startedAt,
      error: error.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function hermesFallbackResult({ status, replyText, latencyMs, error }) {
  return {
    status,
    replyText,
    latencyMs,
    error,
  };
}

async function runHcmCommandPipeline(payload) {
  const executionMode = getExecutionMode(process.env);
  const effectiveDryRun = Boolean(payload.dryRun) || !executionMode.realExecutionEnabled || Boolean(payload.replayOf);
  if (!homeAssistantAdapter.isConfigured()) {
    const error = new Error("Home Assistant adapter is not configured. Set HA_BASE_URL and HA_TOKEN.");
    error.statusCode = 503;
    throw error;
  }
  if (!process.env.OPENAI_API_KEY && !payload.skipPlanner) {
    const error = new Error("OPENAI_API_KEY is not configured; real HCM command execution requires a planner model.");
    error.statusCode = 503;
    throw error;
  }

  const trace = createCommandTrace({
    input: payload.input,
    path: "hcm-real",
    source: payload.source || (payload.replayOf ? "replay" : "text"),
    dryRun: effectiveDryRun,
    replayOf: payload.replayOf,
  });

  try {
    const conversation = conversationContextStore.get(payload.sessionId);
    const rawHome = await runCommandStage(trace, "context_snapshot", () => activeProviderAdapter.discoverHcmHome(), {
      summarize: (home) => ({ things: home.stats?.thingCount, capabilities: home.stats?.capabilityCount }),
    });
    const home = await runCommandStage(trace, "policy_overlay", async () => applyPersonalSemanticsToThingAliases(applyHcmOverlay(rawHome, readHcmOverlay())), {
      summarize: (home) => ({
        autoExecutable: home.stats.autoExecutableCapabilities,
        protected: home.stats.unresolvedBindingCount,
      }),
    });
    const contextAgent = await runCommandStage(trace, "context_agent", async () => runContextAgent({ home }), {
      summarize: (context) => ({
        likelySpace: context.likelySpace?.name,
        confidence: context.likelySpace?.confidence,
        occupiedSpaces: context.spaces?.filter((space) => space.occupied).length ?? 0,
      }),
    });
    const personalSemantics = await runCommandStage(
      trace,
      "personal_semantics",
      async () => compilePersonalSemanticsForPlanner(payload.input, home),
      {
        summarize: (hints) => ({
          hints: hints.length,
          phrases: hints.map((hint) => hint.phrase).slice(0, 4),
        }),
      },
    );
    const learningContext = await runCommandStage(
      trace,
      "learning_context",
      async () => compileHouseholdLearningContext(readLearningMemory(), { input: payload.input, home }),
      {
        summarize: (context) => ({
          hints: context.hints.length,
          preferences: context.preferenceHints.length,
          corrections: context.correctionHints.length,
        }),
      },
    );
    const plannerDevices = await runCommandStage(
      trace,
      "prompt_compile",
      async () =>
        compileHcmForPlanner(home, {
          input: payload.input,
          currentRoomId: payload.currentRoomId,
          selectedRoomId: payload.selectedRoomId,
          focusTargetIds: conversation.focusedTargets.map((target) => target.id),
          focusRoomIds: (conversation.focusedRooms ?? []).map((room) => room.id),
        }),
      {
        summarize: (devices) => ({
          devices: devices.length,
          capabilities: devices.reduce((sum, device) => sum + device.capabilities.length, 0),
        }),
      },
    );
    const promptContextPack = await runCommandStage(
      trace,
      "prompt_context_pack_v2",
      async () =>
        buildPromptContextPackV2({
          input: payload.input,
          home,
          devices: plannerDevices,
          currentRoomId: payload.currentRoomId,
          selectedRoomId: payload.selectedRoomId,
          personalSemantics,
          context: contextAgent,
          conversation,
          learningContext,
        }),
      { summarize: summarizePromptContextPack },
    );
    // skip_planner: when an external caller (e.g. Hermes) provides a planner_draft,
    // we skip the LLM call entirely and use the provided draft directly.
    // This eliminates the second LLM call (~3.5s) when the caller has already
    // understood the intent. Safety Gate, Policy Gate, Decision Review, and
    // Provider Simulation still run — only the LLM planner is skipped.
    const useExternalDraft = Boolean(payload.skipPlanner) && payload.plannerDraft;
    const draft = useExternalDraft
      ? await runCommandStage(
          trace,
          "planner_external",
          () => payload.plannerDraft,
          {
            summarize: (draft) => ({
              intent: draft.intent,
              intentType: draft.intent_type ?? draft.intent_frame?.intent_type,
              frame: Boolean(draft.intent_frame),
              actionCount: draft.actions?.length ?? draft.intent_frame?.decision?.actions?.length ?? 0,
              source: "external",
            }),
          },
        )
      : plannerDevices.length === 0
      ? await runCommandStage(
          trace,
          "planner_fallback",
          () => buildNoPlannerDevicesDraft(payload.input, home),
          {
            summarize: (draft) => ({
              intent: draft.intent,
              intentType: draft.intent_type ?? draft.intent_frame?.intent_type,
              frame: Boolean(draft.intent_frame),
              actionCount: draft.actions?.length ?? 0,
            }),
          },
        )
      : await runCommandStage(
          trace,
          "llm_planner",
          () =>
            callHcmPlannerModel({
              input: payload.input,
              currentRoomId: payload.currentRoomId,
              selectedRoomId: payload.selectedRoomId,
              devices: plannerDevices,
              personalSemantics,
              learningContext,
              contextPack: promptContextPack,
              context: contextAgent,
              conversation,
            }),
          {
            summarize: (draft) => ({
              intent: draft.intent,
              intentType: draft.intent_type ?? draft.intent_frame?.intent_type,
              frame: Boolean(draft.intent_frame),
              actionCount: draft.actions?.length ?? draft.intent_frame?.decision?.actions?.length ?? 0,
            }),
          },
        );
    // batch_expander: expand batch actions (e.g. "关主卧所有灯") into per-device actions.
    // Pure local operation — queries Control Graph, no LLM. <1ms for typical homes.
    const expandedDraft = await runCommandStage(
      trace,
      "batch_expander",
      async () => expandBatchActions(draft, home, payload.input),
      {
        summarize: (d) => ({
          batchExpanded: Boolean(d?._batch_expanded),
          originalActions: d?._batch_original_count ?? draft.actions?.length ?? 0,
          expandedActions: d?._batch_expanded_count ?? draft.actions?.length ?? 0,
        }),
      },
    );
    const normalizedPlan = await runCommandStage(trace, "plan_normalize", async () => normalizeHcmPlannerDraft(payload.input, expandedDraft, home), {
      summarize: (plan) => ({
        intent: plan.intent,
        intentType: plan.intentType,
        actionCount: plan.actions.length,
        stateQuery: plan.stateQuery?.thingName,
        needsConfirmation: plan.needsConfirmation,
      }),
    });
    const accuracyGate = await runCommandStage(
      trace,
      "intent_accuracy",
      async () => {
        const analysis = evaluateIntentAccuracy({
          input: payload.input,
          plan: normalizedPlan,
          home,
          context: contextAgent,
          currentRoomId: payload.currentRoomId,
          selectedRoomId: payload.selectedRoomId,
          conversation,
        });
        return {
          ...applyIntentAccuracyGate(normalizedPlan, analysis),
          analysis,
        };
      },
      {
        summarize: (result) => ({
          ok: result.analysis.ok,
          severity: result.analysis.severity,
          issues: result.analysis.issues.map((issue) => issue.code),
        }),
      },
    );
    const plan = accuracyGate.plan;
    const executionPlan = await runCommandStage(trace, "safety_gate", async () => buildHcmExecutionPlan(plan.actions, home), {
      summarize: (executionPlan) => ({ accepted: executionPlan.accepted.length, rejected: executionPlan.rejected.length }),
    });
    const policyPlan = await runCommandStage(
      trace,
      "policy_gate",
      async () =>
        evaluateExecutionPolicy({
          plan,
          executionPlan,
          context: contextAgent,
          source: payload.source || "chat",
        }),
      {
        summarize: (policyPlan) => ({
          accepted: policyPlan.accepted.length,
          rejected: policyPlan.rejected.length,
          policyCodes: policyPlan.summary.policyCodes,
        }),
      },
    );
    const serviceSimulation = await runCommandStage(
      trace,
      "ha_service_simulator",
      async () => simulateProviderExecutionPlan({ adapter: activeProviderAdapter, accepted: policyPlan.accepted, home }),
      {
        summarize: (simulation) => ({
          ok: simulation.checks.filter((check) => check.ok).length,
          rejected: simulation.rejected.length,
          assumed: simulation.checks.filter((check) => check.code === "assumed_supported").length,
        }),
      },
    );
    const decisionReview = await runCommandStage(
      trace,
      "decision_review",
      async () =>
        reviewDecisionBeforeExecution({
          input: payload.input,
          plan,
          executionPlan,
          policyPlan,
          simulation: serviceSimulation,
        }),
      {
        summarize: (review) => ({
          status: review.status,
          ok: review.ok,
          issues: review.issues.map((issue) => issue.code),
        }),
      },
    );
    const execution = {
      status: "planned",
      dryRun: effectiveDryRun,
      requestedDryRun: Boolean(payload.dryRun),
      executionMode,
      accepted: policyPlan.accepted.map((item) => formatAcceptedExecution(item, serviceSimulation)),
      rejected: [...policyPlan.rejected, ...serviceSimulation.rejected],
      simulation: serviceSimulation,
      decisionReview,
      results: [],
    };

    if (["hcm_state_query", "hcm_inventory_query", "hcm_preference_feedback", "hcm_correction_feedback"].includes(plan.kind)) {
      execution.status = "answered";
    } else if (decisionReview.blocksExecution && decisionReview.status === "partial_available") {
      execution.status = "needs_confirmation";
    } else if (decisionReview.blocksExecution && decisionReview.status === "needs_clarification") {
      execution.status = "needs_clarification";
    } else if (decisionReview.blocksExecution) {
      execution.status = "rejected";
    } else if (plan.requiresClarification || (plan.needsConfirmation && plan.actions.length === 0)) {
      execution.status = "needs_clarification";
    } else if (plan.actions.length === 0) {
      execution.status = "no_action";
    } else if (plan.needsConfirmation) {
      execution.status = "needs_confirmation";
    } else if (!policyPlan.ok) {
      execution.status = "rejected";
    } else if (!serviceSimulation.ok) {
      execution.status = "rejected";
    } else if (effectiveDryRun) {
      execution.status = "dry_run";
      execution.guard = executionMode.realExecutionEnabled
        ? "requested_dry_run"
        : "real_execution_disabled";
    } else {
      execution.status = "executing";
      const rawResults = await runCommandStage(
        trace,
        "device_executor",
        () => executeSimulatedProviderPlan({ adapter: activeProviderAdapter, simulation: serviceSimulation, commandId: trace.commandId }),
        {
        summarize: (results) => ({
          ok: results.filter((result) => result.ok).length,
          failed: results.filter((result) => !result.ok).length,
        }),
        },
      );
      execution.results = await runCommandStage(
        trace,
        "state_verifier",
        () => verifyProviderExecutionResults({ adapter: activeProviderAdapter, results: rawResults }),
        {
          summarize: (results) => ({
            verified: results.filter((result) => result.verification?.ok).length,
            mismatched: results.filter((result) => !result.verification?.ok).length,
          }),
        },
      );
      execution.status = execution.results.every((result) => result.ok && result.verification?.ok) ? "executed" : "partial_failure";
    }

    const conversationAfter = payload.source !== "replay"
      ? conversationContextStore.record(payload.sessionId, { input: payload.input, plan, execution })
      : conversation;

    const explanation = explainIntentResult({
      input: payload.input,
      plan,
      execution,
      plannerHints: personalSemantics,
    });
    const agents = runAgentRuntime({
      home,
      auditEntries: readCommandAuditEntries(20),
      learningMemory: readLearningMemory(),
    });

    const planner = {
      deviceCount: plannerDevices.length,
      capabilityCount: plannerDevices.reduce((sum, device) => sum + device.capabilities.length, 0),
      personalSemanticHintCount: personalSemantics.length,
      learningHintCount: learningContext.hints.length,
      promptContext: summarizePromptContextPack(promptContextPack),
    };
    const auditEntry = finishCommandTrace(trace, {
      status: execution.status,
      plan,
      execution,
      explanation,
      agents,
      conversation: conversationAfter,
      model: getModel(),
      planner,
    });
    writeCommandAuditEntry(auditEntry);
    updateLearningMemory(auditEntry);

    return {
      commandId: trace.commandId,
      replayOf: payload.replayOf,
      status: execution.status,
      latencyMs: auditEntry.latencyMs,
      model: getModel(),
      plan,
      execution,
      planner,
      resolution: plan.resolution,
      intentAccuracy: plan.intentAccuracy ?? accuracyGate.analysis,
      explanation,
      agents,
      conversation: conversationAfter,
      trace: auditEntry,
    };
  } catch (error) {
    const auditEntry = finishCommandTrace(trace, { status: "error", model: getModel() });
    writeCommandAuditEntry({ ...auditEntry, error: error.message });
    throw error;
  }
}

async function buildAgentSnapshot() {
  const home = applyPersonalSemanticsToThingAliases(applyHcmOverlay(await activeProviderAdapter.discoverHcmHome(), readHcmOverlay()));
  return runAgentRuntime({
    home,
    auditEntries: readCommandAuditEntries(20),
    learningMemory: readLearningMemory(),
  });
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function callPlannerModel(payload) {
  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getModel(),
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
      ...getProviderOptions(),
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(),
        },
        {
          role: "user",
          content: JSON.stringify({
            input: payload.input,
            currentRoomId: payload.currentRoomId,
            selectedRoomId: payload.selectedRoomId,
            devices: payload.devices,
          }),
        },
      ],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Model provider error ${response.status}: ${text.slice(0, 500)}`);
    error.statusCode = 502;
    throw error;
  }

  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model returned no content");

  const draft = parseJsonContent(content);
  validatePlannerDraft(draft);
  return draft;
}

async function callHcmPlannerModel(payload) {
  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getModel(),
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      ...getProviderOptions(),
      messages: [
        {
          role: "system",
          content: buildHcmPlannerSystemPrompt(),
        },
        {
          role: "user",
          content: JSON.stringify({
            input: payload.input,
            currentRoomId: payload.currentRoomId,
            selectedRoomId: payload.selectedRoomId,
            context_pack_v2: payload.contextPack,
            devices: payload.devices,
            personal_semantics: payload.personalSemantics ?? [],
            household_learning: payload.learningContext ?? null,
            context: compactPlannerContext(payload.context),
            conversation: compactConversationContext(payload.conversation),
          }),
        },
      ],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Model provider error ${response.status}: ${text.slice(0, 500)}`);
    error.statusCode = 502;
    throw error;
  }

  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model returned no content");
  const draft = parseJsonContent(content);
  validatePlannerDraft(draft);
  return draft;
}

function compactConversationContext(conversation) {
  if (!conversation) return null;
  return {
    focused_targets: (conversation.focusedTargets ?? []).map((target) => ({
      id: target.id,
      name: target.name,
      room_id: target.roomId,
    })),
    focused_rooms: (conversation.focusedRooms ?? []).map((room) => ({
      id: room.id,
      name: room.name,
    })),
    pending_partial_execution: conversation.pendingPartialExecution
      ? {
          intent: conversation.pendingPartialExecution.intent,
          actions: conversation.pendingPartialExecution.actions.map((action) => ({
            device_id: action.logicalAssetId ?? action.thingId,
            name: action.logicalAssetName ?? action.thingName,
            room_id: action.logicalRoomId,
            capability: action.capabilityId,
            value: action.value,
          })),
        }
      : null,
    recent_turns: (conversation.recentTurns ?? []).slice(-4),
  };
}

function compactPlannerContext(context) {
  if (!context) return null;
  return {
    likely_space: context.likelySpace
      ? {
          id: context.likelySpace.id,
          name: context.likelySpace.name,
          confidence: context.likelySpace.confidence,
        }
      : null,
    occupied_spaces: (context.spaces ?? [])
      .filter((space) => space.occupied)
      .slice(0, 4)
      .map((space) => ({
        id: space.id,
        name: space.name,
        confidence: space.confidence,
      })),
  };
}

function formatAcceptedExecution(item, simulation) {
  const fallbackService = item.serviceCall
    ? `${item.serviceCall.domain}.${item.serviceCall.service}`
    : item.capability.name;
  const check = simulation?.checks?.find(
    (candidate) => candidate.thingId === item.thing.id && candidate.capabilityId === item.capability.id,
  );
  return {
    thingId: item.thing.id,
    thingName: item.action.logicalAssetName ?? item.action.thingName ?? item.thing.name,
    providerThingName: item.thing.name,
    logicalAssetId: item.action.logicalAssetId,
    logicalRoomId: item.action.logicalRoomId,
    capabilityId: item.capability.id,
    capabilityName: item.capability.name,
    value: item.action.value,
    service: check?.service ?? fallbackService,
    serviceData: check?.command?.payload ?? item.serviceCall?.serviceData,
    simulation: check
      ? {
          ok: check.ok,
          code: check.code,
          message: check.message,
        }
      : null,
  };
}

function getProviderOptions() {
  if (!getBaseUrl().includes("deepseek.com")) return {};
  return {
    thinking: { type: "disabled" },
  };
}

function buildSystemPrompt() {
  return [
    "You are Harness House Hermes Gateway, a smart-home planning agent.",
    "Convert the user's Chinese smart-home instruction into strict JSON only.",
    "Never execute devices. Never invent devices.",
    "Only use device ids provided in the user JSON.",
    "Only use capabilities explicitly listed on each device. Do not use a capability just because it appears on another device.",
    "Respect capability valueType, min, max, unit, risk, and confirmation fields.",
    "High, sensitive, or confirmation=always capabilities must set needs_confirmation=true.",
    "Prefer small plans. For ambiguous instructions, use currentRoomId and selectedRoomId.",
    "Return exactly this JSON shape:",
    '{"intent":"string","confidence":0.0,"summary":"中文短句","needs_confirmation":false,"actions":[{"device_id":"string","capability":"string","value":true,"reason":"中文短句"}]}',
  ].join("\n");
}

function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON");
    return JSON.parse(match[0]);
  }
}

function validatePlannerDraft(draft) {
  if (!draft || typeof draft !== "object") throw new Error("Planner draft must be an object");
  if (!Array.isArray(draft.actions)) draft.actions = [];
  if (typeof draft.summary !== "string") draft.summary = "已生成真实大模型计划。";
  if (typeof draft.intent !== "string") draft.intent = "llm_control";
  if (typeof draft.confidence !== "number") draft.confidence = 0.6;
  if (typeof draft.needs_confirmation !== "boolean") draft.needs_confirmation = false;
}
