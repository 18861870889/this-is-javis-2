import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
import { hasSpecificRoomReference } from "./src/roomAliases.js";
import {
  applyPersonalSemanticsToThingAliases,
  compilePersonalSemanticsForPlanner,
} from "./src/personalSemantics.js";
import { createCommandTrace, finishCommandTrace, runCommandStage } from "./src/commandRuntime.js";
import {
  createConversationContextStore,
  isReferentialControlInput,
  isRoomScopedFollowUpInput,
} from "./src/conversationContext.js";
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
  JARVIS_VOICE_BRIDGE_VERSION,
  buildDuplicateUtteranceResponse,
  buildHcmPayloadFromUtterance,
  buildHermesUnavailableResponse,
  buildUtteranceDedupeKey,
  formatVoiceBridgeResponse,
  normalizeUtterancePayload,
  normalizeVoiceAsrText,
} from "./src/jarvisVoiceBridge.js";
import { buildJarvisBrainIntent, createPlannerDraftFromHomeIntent } from "./src/jarvisBrain.js";
import {
  buildDeliveryForPcResult,
  buildDeliveryForVoiceBridgeResult,
  createDeliveryRouter,
  createHermesWechatSender,
} from "./src/deliveryRouter.js";
import {
  createPendingPromptQueue,
  enqueuePendingPrompt,
  resolvePendingPromptForFeedback,
  updatePendingPromptDecision,
} from "./src/jarvisPendingPromptQueue.js";
import { buildRuntimeStatus, getExecutionMode } from "./src/releaseGate.js";
import { createSpatialEditorState, hasSpatialEditorEdits } from "./src/spatialHomeEditor.js";
import { applySpatialSemanticOverlay } from "./src/spatialSemanticOverlay.js";
import { createTaskRuntime, isLongRunningAgentTask } from "./src/taskRuntime.js";
import { createJarvisContextMemory, summarizeContextMemory } from "./src/jarvisContextMemory.js";
import {
  buildSemanticPlanMarkdown,
  createSemanticPlanningCache,
  homeSignatureFromHome,
  recordableHcmStatus,
  successfulCacheExecutionStatus,
  summarizeSemanticPlanningCache,
} from "./src/semanticPlanningCache.js";
import { isSubagentConfigured, runConfiguredSubagentTask } from "./src/subagentRuntime.js";

const app = express();
loadLocalEnv();
const port = getCliPort() ?? Number(process.env.PORT ?? 5173);
const bindHost = String(process.env.JARVIS_BIND_HOST || process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const hcmOverlayPath = resolve(process.cwd(), process.env.HARNESS_HCM_OVERLAY_PATH || "data/home-model-overlay.local.json");
const commandAuditPath = resolve(process.cwd(), process.env.HARNESS_COMMAND_AUDIT_PATH || "data/command-audit.local.jsonl");
const learningMemoryPath = resolve(process.cwd(), process.env.HARNESS_LEARNING_MEMORY_PATH || "data/learning-memory.local.json");
const providerSnapshotPath = resolve(process.cwd(), process.env.HARNESS_PROVIDER_SNAPSHOT_PATH || "data/provider-snapshot.local.json");
const automationMemoryPath = resolve(process.cwd(), process.env.HARNESS_AUTOMATION_MEMORY_PATH || "data/automation-memory.local.json");
const spatialEditorPath = resolve(process.cwd(), process.env.HARNESS_SPATIAL_EDITOR_PATH || "data/spatial-editor.local.json");
const pendingPromptQueuePath = resolve(process.cwd(), process.env.JARVIS_PENDING_PROMPT_QUEUE_PATH || "data/pending-prompts.local.json");
const deliveryAuditPath = resolve(process.cwd(), process.env.JARVIS_DELIVERY_AUDIT_PATH || "data/delivery-audit.local.jsonl");
const taskAuditPath = resolve(process.cwd(), process.env.JARVIS_TASK_AUDIT_PATH || "data/task-audit.local.jsonl");
const pcWorkspaceRoot = resolve(process.cwd(), process.env.JARVIS_PC_WORKSPACE_ROOT || "data/pc-workspace.local");
const jarvisContextMemoryPath = resolve(process.cwd(), process.env.JARVIS_CONTEXT_MEMORY_PATH || "data/jarvis-context.local.json");
const semanticPlanningCachePath = resolve(process.cwd(), process.env.JARVIS_SEMANTIC_CACHE_PATH || "data/semantic-planning-cache.local.json");
const semanticPlanningObsidianDir = resolve(process.cwd(), process.env.JARVIS_OBSIDIAN_SEMANTIC_DIR || "data/obsidian-jarvis/semantic-plans");
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
const deliveryRouter = createDeliveryRouter({
  writeAudit: writeDeliveryAuditEntry,
  wechatSender: createHermesWechatSender(),
});
const taskRuntime = createTaskRuntime({
  writeAudit: writeTaskAuditEntry,
});
const contextMemory = createJarvisContextMemory({
  read: readJarvisContextMemory,
  write: writeJarvisContextMemory,
});
const semanticPlanningCache = createSemanticPlanningCache({
  read: readSemanticPlanningCache,
  write: writeSemanticPlanningCache,
  writeMarkdown: writeSemanticPlanMarkdown,
});
const MCP_HOME_TOOL_NAMES = new Set(["jarvis_home_command", "home_assistant_control", "turn_on_home_device", "turn_off_home_device", "get_home_device_state"]);
const MCP_COMPUTER_TOOL_NAMES = new Set(["computer_create_markdown_file"]);
const MCP_TOOL_NAMES = new Set([...MCP_HOME_TOOL_NAMES, ...MCP_COMPUTER_TOOL_NAMES]);

app.use((request, response, next) => {
  if (!parseBooleanEnv(process.env.JARVIS_ACCESS_LOG)) {
    next();
    return;
  }
  const startedAt = Date.now();
  response.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(`[access] ${request.method} ${request.originalUrl || request.url} ${response.statusCode} ${durationMs}ms from ${request.ip}`);
  });
  next();
});
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
    response.json(await discoverCurrentHcmHome());
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
      home: applyRuntimeHomeSemantics(home, overlay),
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
  try {
    response.json(await processJarvisUtterancePayload(request.body ?? {}));
  } catch (error) {
    response.status(error.statusCode || 502).json({ error: error.message || "Jarvis utterance failed" });
  }
});

app.get("/mcp", (_request, response) => {
  response.json({
    name: "harness-house-jarvis",
    transport: "json-rpc-http",
    tools: Array.from(MCP_TOOL_NAMES),
    defaultDryRun: !parseBooleanEnv(process.env.JARVIS_MCP_ALLOW_REAL),
  });
});

app.post("/mcp", async (request, response) => {
  try {
    const payload = request.body;
    if (Array.isArray(payload)) {
      response.json(await Promise.all(payload.map((message) => handleMcpJsonRpc(message))));
      return;
    }
    const result = await handleMcpJsonRpc(payload);
    if (!result) {
      response.status(204).end();
      return;
    }
    response.json(result);
  } catch (error) {
    response.status(error.statusCode || 400).json(mcpError(null, -32603, error.message || "MCP request failed"));
  }
});

app.post("/v1/chat/completions", async (request, response) => {
  try {
    const completion = await buildJarvisChatCompletion(request.body ?? {}, request.headers ?? {});
    if (request.body?.stream) {
      sendOpenAiChatCompletionStream(response, completion);
      return;
    }
    response.json(completion);
  } catch (error) {
    response.status(error.statusCode || 400).json({
      error: {
        message: error.message || "Jarvis chat completion failed",
        type: "jarvis_error",
      },
    });
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

app.get("/api/tasks", (request, response) => {
  const limit = Math.max(1, Math.min(100, Number(request.query.limit ?? 20)));
  response.json({
    tasks: taskRuntime.listTasks({
      limit,
      includeTerminal: request.query.active !== "true",
    }),
  });
});

app.get("/api/tasks/:taskId", (request, response) => {
  const task = taskRuntime.getTask(request.params.taskId);
  if (!task) {
    response.status(404).json({ error: "Task not found" });
    return;
  }
  response.json({ task });
});

app.get("/api/jarvis/context", (_request, response) => {
  response.json(summarizeContextMemory(readJarvisContextMemory()));
});

app.get("/api/jarvis/semantic-cache", (_request, response) => {
  response.json(summarizeSemanticPlanningCache(readSemanticPlanningCache()));
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

const httpServer = createHttpServer(app);

const vite = await createViteServer({
  server: {
    middlewareMode: true,
    hmr: {
      server: httpServer,
    },
  },
  appType: "spa",
});

app.use(vite.middlewares);

httpServer.listen(port, bindHost, () => {
  const displayHost = bindHost === "0.0.0.0" ? "localhost" : bindHost;
  console.log(`Harness House running at http://${displayHost}:${port}/`);
  if (bindHost === "0.0.0.0") {
    console.log("Jarvis is listening on all interfaces. Restrict access with a firewall or private tunnel before real execution.");
  }
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
  if (payload.homeIntent !== undefined && (typeof payload.homeIntent !== "object" || Array.isArray(payload.homeIntent))) {
    throw badRequest("homeIntent must be an object");
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

function writeDeliveryAuditEntry(entry) {
  mkdirSync(dirname(deliveryAuditPath), { recursive: true });
  appendFileSync(deliveryAuditPath, `${JSON.stringify(entry)}\n`);
}

function writeTaskAuditEntry(entry) {
  mkdirSync(dirname(taskAuditPath), { recursive: true });
  appendFileSync(taskAuditPath, `${JSON.stringify(entry)}\n`);
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

function readJarvisContextMemory() {
  if (!existsSync(jarvisContextMemoryPath)) return null;
  try {
    return JSON.parse(readFileSync(jarvisContextMemoryPath, "utf8"));
  } catch (error) {
    throw new Error(`Jarvis context memory file is invalid JSON: ${error.message}`);
  }
}

function writeJarvisContextMemory(memory) {
  mkdirSync(dirname(jarvisContextMemoryPath), { recursive: true });
  writeFileSync(jarvisContextMemoryPath, `${JSON.stringify(memory, null, 2)}\n`);
}

function readSemanticPlanningCache() {
  if (!existsSync(semanticPlanningCachePath)) return null;
  try {
    return JSON.parse(readFileSync(semanticPlanningCachePath, "utf8"));
  } catch (error) {
    throw new Error(`Semantic planning cache file is invalid JSON: ${error.message}`);
  }
}

function writeSemanticPlanningCache(cache) {
  mkdirSync(dirname(semanticPlanningCachePath), { recursive: true });
  writeFileSync(semanticPlanningCachePath, `${JSON.stringify(cache, null, 2)}\n`);
}

function writeSemanticPlanMarkdown(entry) {
  if (!entry?.id) return "";
  const filename = `${String(entry.id).replace(/[^A-Za-z0-9_-]/g, "_")}.md`;
  const targetPath = resolve(semanticPlanningObsidianDir, filename);
  if (basename(targetPath) !== filename) return "";
  mkdirSync(semanticPlanningObsidianDir, { recursive: true });
  writeFileSync(targetPath, `${buildSemanticPlanMarkdown(entry)}\n`, "utf8");
  return targetPath;
}

async function discoverCurrentHcmHome() {
  const rawHome = await activeProviderAdapter.discoverHcmHome();
  return applyRuntimeHomeSemantics(rawHome);
}

function applyRuntimeHomeSemantics(rawHome, overlay = readHcmOverlay()) {
  return applyPersonalSemanticsToThingAliases(
    applySpatialSemanticOverlay(applyHcmOverlay(rawHome, overlay), readSpatialEditorRecord()),
  );
}

function updateLearningMemory(auditEntry) {
  const memory = recordLearningObservation(readLearningMemory(), auditEntry);
  writeLearningMemory(memory);
}

async function handleJarvisUtterance(utterance, rawPayload) {
  const taskStatusReply = await maybeReplyWithTaskStatus(utterance.text, {}, originFromVoiceUtterance(utterance));
  if (taskStatusReply) {
    return buildAgentTaskVoiceResponse(utterance, {
      routeReason: "task_status_query",
      status: "answered",
      replyText: taskStatusReply,
      deliveryHandled: true,
    });
  }

  const contextReply = await maybeReplyWithContextMemory(utterance.text, originFromVoiceUtterance(utterance));
  if (contextReply) {
    return buildAgentTaskVoiceResponse(utterance, {
      routeReason: contextReply.type,
      status: "answered",
      commandId: contextReply.taskId,
      replyText: contextReply.replyText,
      delivery: contextReply.delivery,
      deliveryHandled: true,
    });
  }

  const pcMarkdownRequest = parsePcMarkdownRequest(utterance.text);
  if (pcMarkdownRequest) return handlePcMarkdownUtterance(utterance, pcMarkdownRequest);

  if (isLongRunningAgentTask(utterance.text)) {
    const replyText = await startLongRunningHermesTask(utterance.text, originFromVoiceUtterance(utterance));
    return buildAgentTaskVoiceResponse(utterance, {
      routeReason: "long_running_agent_task",
      status: "queued",
      replyText,
      deliveryHandled: true,
    });
  }

  const brainIntent = buildJarvisBrainIntent({ text: utterance.text, utterance });
  const classification = brainIntent.classification;

  if (brainIntent.type === "learning_feedback") {
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

  if (brainIntent.type === "home_intent") {
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
    const useExternalSemanticPlanner = classification.reason !== "read_only_home_state_query";
    const semanticCacheHit = useExternalSemanticPlanner ? await maybeGetSemanticPlanCacheDraft(utterance) : null;
    const hermesPlannerDraft = useExternalSemanticPlanner && !semanticCacheHit?.plannerDraft ? await maybeBuildHermesHomeIntentDraft(utterance) : null;
    const plannerDraft = semanticCacheHit?.plannerDraft || hermesPlannerDraft;
    const plannerDraftSource = semanticCacheHit?.plannerDraft
      ? "semantic_planning_cache"
      : hermesPlannerDraft ? "hermes_home_intent" : "";
    const hcmResult = await runHcmCommandPipeline(buildHcmPayloadFromUtterance(utterance, classification, {
      homeIntent: plannerDraft ? null : brainIntent.homeIntent,
      plannerDraft,
      plannerDraftSource,
    }));
    if (useExternalSemanticPlanner) await recordSemanticPlanCacheFromHcm({
      utterance,
      hcmResult,
      plannerDraft: plannerDraft || createPlannerDraftFromHomeIntent(brainIntent.homeIntent),
      source: plannerDraftSource || "jarvis_brain_home_intent",
      cacheHit: semanticCacheHit,
    });
    const learningSuggestion = await buildUserVisibleLearningSuggestion(hcmResult.commandId, utterance);
    return formatVoiceBridgeResponse({ utterance, classification, hcmResult, learningSuggestion });
  }

  const hermesResult = await callHermesSlowPath(utterance);
  if (!hermesResult) return buildHermesUnavailableResponse(utterance, classification);
  return formatVoiceBridgeResponse({ utterance, classification, hermesResult });
}

async function handlePcMarkdownUtterance(utterance, pcMarkdownRequest) {
  const result = createPcMarkdownFile(pcMarkdownRequest);
  const origin = originFromVoiceUtterance(utterance);
  contextMemory.rememberPcFile(result, origin);
  const delivery = await routePcResultDelivery(result, origin);
  const replyText = delivery.voiceSummary || result.replyText;
  return buildAgentTaskVoiceResponse(utterance, {
    routeReason: "pc_markdown_file",
    status: result.status,
    commandId: result.path,
    replyText,
    delivery,
    deliveryHandled: true,
  });
}

function buildAgentTaskVoiceResponse(utterance, {
  routeReason,
  status,
  commandId = null,
  replyText = "",
  delivery = null,
  deliveryHandled = false,
} = {}) {
  return {
    version: JARVIS_VOICE_BRIDGE_VERSION,
    deviceId: utterance.deviceId,
    roomId: utterance.roomId,
    wakeSessionId: utterance.wakeSessionId,
    trigger: utterance.trigger,
    route: "agent_task",
    routeReason,
    commandId,
    status,
    risk: "low",
    speak: Boolean(replyText),
    display: replyText,
    replyText,
    learnedSuggestion: null,
    latencyMs: 0,
    ...(delivery ? { delivery } : {}),
    deliveryHandled,
  };
}

function originFromVoiceUtterance(utterance = {}) {
  return {
    ingress: "voice_bridge",
    trigger: utterance.trigger || "voice",
    sourceDeviceId: utterance.deviceId || "",
    roomId: utterance.roomId || "",
    wakeSessionId: utterance.wakeSessionId || "",
  };
}

async function processJarvisUtterancePayload(rawPayload) {
  let dedupeKey = "";
  try {
    const utterance = applyTrustedRoomTextDefaults(applyTrustedStackChanRoom(normalizeUtterancePayload(rawPayload ?? {})));
    validateJarvisIngressPolicy({ text: utterance.text, roomId: utterance.roomId, deviceId: utterance.deviceId });
    dedupeKey = buildUtteranceDedupeKey(utterance);
    const existing = findRecentVoiceUtterance(dedupeKey);
    if (existing) {
      return buildDuplicateUtteranceResponse({
        utterance,
        handledByDeviceId: existing.deviceId,
        dedupeKey,
      });
    }
    rememberVoiceUtterance(dedupeKey, utterance);
    const result = await handleJarvisUtterance(utterance, rawPayload ?? {});
    const deliveredResult = await attachDeliveryToVoiceBridgeResult(result, utterance);
    return {
      ...deliveredResult,
      duplicate: false,
      handledByDeviceId: utterance.deviceId,
      dedupeKey,
    };
  } catch (error) {
    if (dedupeKey) voiceUtteranceDedupe.delete(dedupeKey);
    throw error;
  }
}

async function attachDeliveryToVoiceBridgeResult(result, utterance) {
  if (result?.deliveryHandled) return result;
  if (!result || result.speak === false || result.status === "duplicate_ignored") return result;
  const message = buildDeliveryForVoiceBridgeResult(result, {
    utterance,
    source: "voice_bridge",
  });
  const delivery = await deliveryRouter.route(message);
  const voiceSummary = delivery.voiceSummary || result.replyText || result.display;
  return {
    ...result,
    delivery,
    replyText: voiceSummary,
    display: voiceSummary || result.display,
  };
}

async function handleMcpJsonRpc(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return mcpError(message?.id ?? null, -32600, "Invalid MCP JSON-RPC request");
  }
  if (message.id === undefined && message.method.startsWith("notifications/")) return null;

  if (message.method === "initialize") {
    return mcpResult(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "home-assistant",
        version: "0.1.0",
      },
    });
  }
  if (message.method === "ping") return mcpResult(message.id, {});
  if (message.method === "tools/list") {
    return mcpResult(message.id, {
      tools: await buildMcpTools(),
    });
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (!MCP_TOOL_NAMES.has(name)) {
      return mcpError(message.id, -32602, `Unknown tool: ${name || ""}`);
    }
    if (MCP_COMPUTER_TOOL_NAMES.has(name)) {
      return mcpResult(message.id, await callJarvisComputerTool(name, message.params?.arguments ?? {}));
    }
    return mcpResult(message.id, await callJarvisHomeCommandTool(name, message.params?.arguments ?? {}));
  }
  return mcpError(message.id, -32601, `Unknown MCP method: ${message.method}`);
}

async function buildMcpTools() {
  return [
    ...await buildMcpHomeTools(),
    mcpComputerMarkdownTool(),
  ];
}

async function buildMcpHomeTools() {
  const context = await buildMcpHomeToolContext();
  const contextSuffix = context ? `\n${context}` : "";
  const callInstruction = "当用户要求控制或查询家里设备时必须调用此工具，不要回答“没有控制能力”。工具会进入 Jarvis HCM 安全、审计、去重和 Home Assistant 执行链路。";
  return [
    mcpHomeCommandTool(
      "home_assistant_control",
      `${callInstruction} 适用于打开/关闭/查询灯、射灯、吸顶灯、空调、风扇、窗帘、电视等。用户说“打开次卧吸顶灯”“关闭书房射灯”“客厅灯开着吗”时调用。${contextSuffix}`,
    ),
    mcpHomeCommandTool(
      "jarvis_home_command",
      `${callInstruction} Route a StackChan/Xiaozhi utterance into Jarvis HCM. Use for smart-home control or state queries.${contextSuffix}`,
    ),
    mcpTargetTool("turn_on_home_device", `打开指定的智能家居设备，例如打开次卧吸顶灯、打开书房射灯。${contextSuffix}`),
    mcpTargetTool("turn_off_home_device", `关闭指定的智能家居设备，例如关闭次卧吸顶灯、关闭书房射灯。${contextSuffix}`),
    mcpTargetTool("get_home_device_state", `查询指定智能家居设备的状态，例如次卧吸顶灯开着吗。${contextSuffix}`),
  ];
}

async function buildMcpHomeToolContext() {
  if (!activeProviderAdapter.isConfigured()) return "";
  try {
    const home = await discoverCurrentHcmHome();
    const allowedRoomIds = parseAllowedActionRoomIds();
    const roomNames = new Map((home.spaces ?? []).map((space) => [space.id, space.name || space.id]));
    const allowedRoomNames = Array.from(allowedRoomIds).map((roomId) => roomNames.get(roomId) || roomId);
    const targets = [];
    const plannerDevices = compileHcmForPlanner(home, { limit: 200 })
      .filter((device) => (device.capabilities ?? []).some(isMcpControllableCapability))
      .sort((first, second) => compareMcpContextTargets(first, second, roomNames, home));
    for (const device of plannerDevices) {
      if (allowedRoomIds.size > 0 && !allowedRoomIds.has(device.roomId)) continue;
      const capabilities = (device.capabilities ?? []).filter(isMcpControllableCapability);
      if (!capabilities.length) continue;
      const roomName = roomNames.get(device.roomId) || device.roomId || "未知房间";
      const capabilityNames = capabilities.slice(0, 3).map((capability) => capability.name).join("/");
      targets.push(`${device.name}（${roomName}，${capabilityNames}）`);
    }
    const guard = allowedRoomNames.length ? `当前真实执行只允许目标房间：${allowedRoomNames.join("、")}。` : "";
    const targetSummary = targets.length ? `当前可控目标示例：${targets.slice(0, 24).join("；")}。` : "";
    return `${guard}${targetSummary}`.trim();
  } catch (error) {
    return "";
  }
}

function compareMcpContextTargets(first, second, roomNames, home) {
  return mcpContextTargetRank(first, roomNames, home) - mcpContextTargetRank(second, roomNames, home)
    || String(first.name).localeCompare(String(second.name), "zh-CN");
}

function mcpContextTargetRank(device, roomNames, home) {
  let rank = 100;
  if (device.logicalAsset) rank -= 40;
  if (device.type === "light" || /灯|照明/.test(device.name ?? "")) rank -= 25;
  const room = (home.spaces ?? []).find((space) => space.id === device.roomId);
  if (room?.spatialSemantic?.custom) rank -= 30;
  if (/过道/.test(`${device.name ?? ""}${roomNames.get(device.roomId) ?? ""}`)) rank -= 10;
  return rank;
}

function isMcpControllableCapability(capability) {
  if (capability?.access === "execute") return ["control", "action"].includes(capability.kind);
  return ["control", "action"].includes(capability?.kind)
    && capability?.policy?.autoExecutable
    && capability?.policy?.risk === "low"
    && capability?.policy?.confirmation === "never";
}

function mcpHomeCommandTool(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "用户的完整中文家居指令，例如：打开次卧吸顶灯" },
        deviceId: { type: "string", description: "StackChan 或小智设备 ID。可省略，默认 stackchan-mcp。" },
        roomId: { type: "string", description: "可信来源房间 ID，例如 second。可省略，Jarvis 可按设备映射推断。" },
        wakeSessionId: { type: "string", description: "唤醒会话 ID，用于多设备去重。可省略。" },
        trigger: { type: "string", description: "触发来源，默认 mcp。" },
        dryRun: { type: "boolean", description: "默认 true。真实执行还必须满足 JARVIS_MCP_ALLOW_REAL=true 和 HARNESS_EXECUTION_MODE=real。" },
      },
      required: ["text"],
    },
  };
}

function mcpTargetTool(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", description: "设备名称，例如：次卧吸顶灯" },
        room: { type: "string", description: "房间名称，例如：次卧" },
        text: { type: "string", description: "可选。用户原始完整指令。" },
        deviceId: { type: "string", description: "StackChan 或小智设备 ID。可省略。" },
        roomId: { type: "string", description: "可信来源房间 ID，例如 second。可省略。" },
        wakeSessionId: { type: "string", description: "唤醒会话 ID，可省略。" },
        dryRun: { type: "boolean", description: "默认 true。真实执行还必须满足服务端真实执行闸门。" },
      },
      required: ["target"],
    },
  };
}

function mcpComputerMarkdownTool() {
  return {
    name: "computer_create_markdown_file",
    description: `在 Jarvis PC 的受限工作区创建 Markdown 文件。只允许 .md 文件，根目录为 ${pcWorkspaceRoot}。适用于“在电脑上新建一个 md 文件并写入 helloworld”。`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        filename: { type: "string", description: "Markdown 文件名。可省略，默认 hello.md；无扩展名时自动补 .md。" },
        content: { type: "string", description: "要写入文件的文本。可省略，默认 helloworld。" },
        overwrite: { type: "boolean", description: "是否覆盖已存在文件，默认 false。" },
      },
    },
  };
}

async function callJarvisHomeCommandTool(toolName, args) {
  const text = buildMcpToolText(toolName, args);
  if (!text) throw statusError("jarvis_home_command requires text", 400);

  const deviceId = String(args.deviceId || "stackchan-mcp").trim();
  const roomId = String(args.roomId || stackchanDeviceRooms.get(deviceId) || "").trim();
  validateMcpBridgePolicy({ text, roomId });
  const mcpAllowsReal = parseBooleanEnv(process.env.JARVIS_MCP_ALLOW_REAL);
  const requestedDryRun = args.dryRun === undefined ? true : Boolean(args.dryRun);
  const dryRun = mcpAllowsReal ? requestedDryRun : true;
  const payload = {
    deviceId,
    roomId,
    wakeSessionId: String(args.wakeSessionId || `mcp-${Date.now()}`).trim(),
    trigger: String(args.trigger || "mcp").trim(),
    text,
    dryRun,
  };
  const result = await processJarvisUtterancePayload(payload);
  const replyText = formatMcpToolReplyText(result);
  return {
    content: [{ type: "text", text: replyText }],
    structuredContent: {
      ...result,
      mcp: {
        dryRunForced: !mcpAllowsReal && requestedDryRun === false,
        allowReal: mcpAllowsReal,
      },
    },
    isError: ["dry_run", "rejected", "integration_unavailable", "brain_timeout", "brain_unavailable"].includes(result.status),
  };
}

async function callJarvisComputerTool(toolName, args) {
  if (toolName !== "computer_create_markdown_file") throw statusError(`Unknown computer tool: ${toolName}`, 400);
  const result = createPcMarkdownFile(args);
  const origin = {
    ingress: "mcp",
    trigger: "mcp",
    sourceDeviceId: String(args.deviceId || "stackchan-mcp").trim(),
    roomId: String(args.roomId || "").trim(),
    wakeSessionId: String(args.wakeSessionId || "").trim(),
  };
  contextMemory.rememberPcFile(result, origin);
  const delivery = await routePcResultDelivery(result, origin);
  const replyText = delivery.voiceSummary || result.replyText;
  return {
    content: [{ type: "text", text: replyText }],
    structuredContent: {
      ...result,
      replyText,
      delivery,
    },
    isError: false,
  };
}

function createPcMarkdownFile(args = {}) {
  const filename = normalizeMarkdownFilename(args.filename);
  const content = args.content === undefined ? "helloworld" : String(args.content);
  const overwrite = Boolean(args.overwrite);
  const targetPath = resolve(pcWorkspaceRoot, filename);
  if (basename(targetPath) !== filename) throw statusError("Markdown filename is invalid", 400);

  mkdirSync(pcWorkspaceRoot, { recursive: true });
  if (existsSync(targetPath) && !overwrite) {
    throw statusError(`电脑工作区里已经有 ${filename}，为了安全我没有覆盖。`, 409);
  }

  writeFileSync(targetPath, content, "utf8");
  const operation = overwrite ? "updated" : "created";
  const preview = summarizeSpeakableContent(content);
  return {
    status: "completed",
    operation: "computer_create_markdown_file",
    fileOperation: operation,
    filename,
    path: targetPath,
    workspaceRoot: pcWorkspaceRoot,
    bytes: Buffer.byteLength(content, "utf8"),
    replyText: `${overwrite ? "已更新" : "已创建"}电脑工作区里的 ${filename}，写入内容：${preview}。`,
  };
}

async function routePcResultDelivery(result, origin) {
  return deliveryRouter.route(buildDeliveryForPcResult(result, {
    origin,
    source: "pc_markdown_file",
  }));
}

function normalizeMarkdownFilename(filename) {
  const raw = String(filename || "hello.md").trim() || "hello.md";
  if (raw.includes("\0") || /[\\/]/.test(raw) || raw.includes("..")) {
    throw statusError("Markdown filename must be a simple file name inside the Jarvis PC workspace", 400);
  }
  const withExtension = /\.[^.\s]+$/.test(raw) ? raw : `${raw}.md`;
  if (!withExtension.toLowerCase().endsWith(".md")) throw statusError("Only .md files can be created by this tool", 400);
  const safe = basename(withExtension);
  if (!safe || safe !== withExtension || safe === "." || safe === "..") throw statusError("Markdown filename is invalid", 400);
  return safe;
}

function summarizeSpeakableContent(content) {
  const trimmed = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "空内容";
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
}

async function buildJarvisChatCompletion(payload, headers = {}) {
  const created = Math.floor(Date.now() / 1000);
  const model = String(payload.model || "jarvis");
  const userText = extractChatCompletionUserText(payload.messages);
  if (!userText) throw statusError("messages must include a user message", 400);
  const content = await buildJarvisBrainReply(userText, { headers });
  return {
    id: `chatcmpl-jarvis-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
      },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

async function buildJarvisBrainReply(text, { headers = {} } = {}) {
  const normalizedText = normalizeSpokenText(text);
  const taskStatusReply = await maybeReplyWithTaskStatus(normalizedText, headers);
  if (taskStatusReply) return taskStatusReply;

  const contextReply = await maybeReplyWithContextMemory(normalizedText, resolveXiaozhiDeliveryOrigin(headers));
  if (contextReply) return contextReply.replyText;

  const pcMarkdownRequest = parsePcMarkdownRequest(normalizedText);
  if (pcMarkdownRequest) {
    const result = createPcMarkdownFile(pcMarkdownRequest);
    const origin = resolveXiaozhiDeliveryOrigin(headers);
    contextMemory.rememberPcFile(result, origin);
    const delivery = await routePcResultDelivery(result, origin);
    return delivery.voiceSummary || result.replyText;
  }

  if (isLongRunningAgentTask(normalizedText)) {
    return startLongRunningHermesTask(normalizedText, resolveXiaozhiDeliveryOrigin(headers));
  }

  const brainIntent = buildJarvisBrainIntent({ text: normalizedText });
  if (brainIntent.type !== "agent_task") {
    const deviceId = resolveXiaozhiDeviceId(headers);
    const roomId = resolveXiaozhiRoomId(headers, deviceId);
    const xiaozhiAllowsReal = parseBooleanEnv(process.env.JARVIS_XIAOZHI_ALLOW_REAL || process.env.JARVIS_MCP_ALLOW_REAL);
    const result = await processJarvisUtterancePayload({
      deviceId,
      roomId,
      wakeSessionId: resolveXiaozhiSessionId(headers),
      trigger: "xiaozhi_llm",
      text: normalizedText,
      dryRun: !xiaozhiAllowsReal,
    });
    return formatJarvisVoiceResultForChat(result);
  }

  const hermesResult = await callHermesSlowPath({
    text: normalizedText,
    wakeSessionId: resolveXiaozhiSessionId(headers),
  });
  if (!hermesResult) return "Hermes 现在还没有配置好，我暂时不能处理这个非家居任务。";
  return hermesResult.replyText || "Hermes 已处理完成。";
}

function formatJarvisVoiceResultForChat(result) {
  if (result?.speak === false && result?.status === "duplicate_ignored") return "这句我刚刚已经处理过了。";
  return result?.delivery?.voiceSummary || result?.replyText || result?.display || "Jarvis 已处理完成。";
}

async function maybeReplyWithTaskStatus(text, headers = {}, originOverride = null) {
  if (!looksLikeTaskStatusRequest(text)) return "";
  const tasks = taskRuntime.listTasks({ limit: 5, includeTerminal: true });
  if (tasks.length === 0) return "目前没有正在跟踪的 Jarvis 任务。";
  const latest = tasks[0];
  const statusText = taskStatusText(latest.status);
  const summary = latest.resultSummary || latest.progressSummary || latest.error || latest.userIntent;
  const reply = `${latest.kind === "long_running_agent_task" ? "刚才那个任务" : "最近的任务"}${statusText}：${summary}`;
  await deliveryRouter.route({
    taskId: latest.taskId,
    origin: originOverride || resolveXiaozhiDeliveryOrigin(headers),
    voiceSummary: reply,
    channels: ["voice"],
    priority: "normal",
    source: "task_status_query",
  });
  return reply;
}

async function maybeReplyWithContextMemory(text, origin) {
  const answer = contextMemory.answer(text);
  if (!answer?.handled) return null;
  const taskId = answer.item?.path || answer.item?.taskId || answer.type;
  const delivery = await deliveryRouter.route({
    taskId,
    origin,
    voiceSummary: answer.replyText,
    wechatTitle: answer.type === "pc_file_location" ? "Jarvis 文件位置" : "Jarvis 上下文回复",
    wechatBody: answer.replyText,
    channels: ["voice", "wechat"],
    priority: "normal",
    source: "context_memory",
  });
  return {
    type: answer.type,
    taskId,
    replyText: delivery.voiceSummary || answer.replyText,
    delivery,
  };
}

async function startLongRunningHermesTask(text, origin) {
  const task = taskRuntime.createTask({
    source: "xiaozhi_llm",
    kind: "long_running_agent_task",
    userIntent: text,
    status: "queued",
    progressSummary: "我已经把这个长任务排进 Jarvis 后台。",
    origin,
    subagent: {
      enabled: isSubagentConfigured(process.env),
      runner: process.env.JARVIS_SUBAGENT_COMMAND || (String(process.env.HERMES_API_TRANSPORT || "").trim().toLowerCase() === "cli" ? "hermes_cli" : "hermes_api"),
      status: "queued",
    },
  });
  contextMemory.rememberTask(task);
  const voiceSummary = "好，我开始处理。这个可能要花几分钟，我会在关键节点告诉你进度。";
  await deliveryRouter.route({
    taskId: task.taskId,
    origin,
    voiceSummary,
    wechatTitle: "Jarvis 长任务已开始",
    wechatBody: `任务：${text}\n任务 ID：${task.taskId}`,
    channels: ["voice", "wechat"],
    priority: "normal",
    source: "task_runtime",
  });
  runHermesLongTaskInBackground(task.taskId, text, origin);
  return voiceSummary;
}

function runHermesLongTaskInBackground(taskId, text, origin) {
  setTimeout(async () => {
    try {
      const running = taskRuntime.updateTask(taskId, {
        status: "running",
        progressSummary: isSubagentConfigured(process.env) ? "Jarvis subagent 已开始处理这个长任务。" : "Hermes 已开始处理这个长任务。",
        subagent: {
          enabled: isSubagentConfigured(process.env),
          id: taskId,
          runner: process.env.JARVIS_SUBAGENT_COMMAND || (String(process.env.HERMES_API_TRANSPORT || "").trim().toLowerCase() === "cli" ? "hermes_cli" : "hermes_api"),
          status: "running",
          startedAt: new Date().toISOString(),
        },
      });
      contextMemory.rememberTask(running);
      const timeoutMs = configuredLongTaskTimeoutMs();
      const subagentResult = await runConfiguredSubagentTask({
        taskId,
        text,
        origin,
        timeoutMs,
      });
      if (subagentResult) {
        if (subagentResult.status !== "completed") {
          const failed = taskRuntime.updateTask(taskId, {
            status: "failed",
            error: subagentResult.error || "Jarvis subagent 执行失败。",
            subagent: subagentResult,
          });
          contextMemory.rememberTask(failed);
          await routeTaskCompletionDelivery(failed, origin);
          return;
        }
        const completed = taskRuntime.updateTask(taskId, {
          status: "completed",
          resultSummary: summarizeSpeakableContent(subagentResult.resultSummary || "Jarvis subagent 已完成任务。"),
          artifacts: subagentResult.artifacts,
          subagent: subagentResult,
        });
        contextMemory.rememberTask(completed);
        await routeTaskCompletionDelivery(completed, origin);
        return;
      }

      const result = await callHermesSlowPath({
        text,
        wakeSessionId: origin.wakeSessionId || taskId,
      }, { timeoutMs });
      if (!result || result.status === "brain_timeout" || result.status === "brain_unavailable") {
        const failed = taskRuntime.updateTask(taskId, {
          status: "failed",
          error: result?.replyText || "Hermes 长任务执行失败。",
          subagent: {
            enabled: false,
            id: taskId,
            runner: "hermes",
            status: "failed",
            error: result?.error || result?.replyText || "",
            finishedAt: new Date().toISOString(),
          },
        });
        contextMemory.rememberTask(failed);
        await routeTaskCompletionDelivery(failed, origin);
        return;
      }
      const completed = taskRuntime.updateTask(taskId, {
        status: "completed",
        resultSummary: summarizeSpeakableContent(result.replyText || "Hermes 已完成任务。"),
        subagent: {
          enabled: false,
          id: taskId,
          runner: "hermes",
          status: "completed",
          finishedAt: new Date().toISOString(),
        },
      });
      contextMemory.rememberTask(completed);
      await routeTaskCompletionDelivery(completed, origin);
    } catch (error) {
      const failed = taskRuntime.updateTask(taskId, {
        status: "failed",
        error: error.message || "Jarvis 长任务后台执行异常。",
        subagent: {
          enabled: isSubagentConfigured(process.env),
          id: taskId,
          runner: process.env.JARVIS_SUBAGENT_COMMAND || "hermes",
          status: "failed",
          error: error.message || "",
          finishedAt: new Date().toISOString(),
        },
      });
      contextMemory.rememberTask(failed);
      await routeTaskCompletionDelivery(failed, origin);
    }
  }, 0);
}

async function routeTaskCompletionDelivery(task, origin) {
  if (!task) return;
  const ok = task.status === "completed";
  const voiceSummary = ok
    ? `任务完成了：${task.resultSummary || "Hermes 已处理完成。"}`
    : `任务没有完成：${task.error || "Hermes 执行失败。"}。`;
  await deliveryRouter.route({
    taskId: task.taskId,
    origin,
    voiceSummary,
    wechatTitle: ok ? "Jarvis 长任务完成" : "Jarvis 长任务失败",
    wechatBody: [
      `任务：${task.userIntent}`,
      task.resultSummary ? `结果：${task.resultSummary}` : "",
      task.error ? `错误：${task.error}` : "",
    ].filter(Boolean).join("\n"),
    channels: ["voice", "wechat"],
    priority: ok ? "normal" : "high",
    source: "task_runtime",
  });
}

function looksLikeTaskStatusRequest(text = "") {
  const value = String(text || "").replace(/[，。！？,.!?\s]/g, "");
  return /(刚才|上个|那个|任务|app|应用|项目).*(做到哪|进度|怎么样|完成了吗|好了没|状态)/.test(value)
    || /(做到哪|进度怎么样|任务状态|好了没|完成了吗)/.test(value);
}

function taskStatusText(status) {
  if (status === "queued") return "还在排队";
  if (status === "running") return "正在处理";
  if (status === "waiting_input") return "需要你补充信息";
  if (status === "completed") return "已经完成";
  if (status === "failed") return "失败了";
  if (status === "cancelled") return "已取消";
  return "状态未知";
}

function configuredLongTaskTimeoutMs() {
  const value = Number(process.env.JARVIS_LONG_TASK_HERMES_TIMEOUT_MS ?? process.env.HERMES_LONG_TASK_TIMEOUT_MS ?? 120000);
  return Number.isFinite(value) && value > 0 ? value : 120000;
}

async function maybeGetSemanticPlanCacheDraft(utterance) {
  if (!shouldUseSemanticPlanningCache()) return null;
  if (!homeAssistantAdapter.isConfigured()) return null;
  try {
    const home = await discoverCurrentHcmHome();
    const lookup = semanticPlanningCache.lookup(utterance.text, {
      homeSignature: homeSignatureFromHome(home),
      currentRoomId: utterance.roomId,
    });
    if (!lookup.hit || !lookup.plannerDraft) return null;
    return {
      cacheId: lookup.entry.id,
      reason: lookup.reason,
      confidence: lookup.confidence,
      plannerDraft: {
        ...lookup.plannerDraft,
        _source: "semantic_planning_cache",
        _cacheId: lookup.entry.id,
        _cacheConfidence: lookup.confidence,
      },
    };
  } catch (error) {
    console.warn(`[semantic-cache] lookup failed: ${error.message}`);
    return null;
  }
}

async function recordSemanticPlanCacheFromHcm({
  utterance,
  hcmResult,
  plannerDraft,
  source = "",
  cacheHit = null,
} = {}) {
  if (!shouldUseSemanticPlanningCache()) return;
  try {
    if (cacheHit?.cacheId) {
      semanticPlanningCache.recordCacheOutcome(cacheHit.cacheId, {
        ok: successfulCacheExecutionStatus(hcmResult?.status),
        auditEntry: hcmResult?.trace,
      });
      return;
    }
    if (!recordableHcmStatus(hcmResult?.status)) return;
    if (!plannerDraft) return;
    const home = await discoverCurrentHcmHome();
    semanticPlanningCache.recordSuccess(utterance.text, {
      plannerDraft,
      auditEntry: hcmResult?.trace,
      homeSignature: homeSignatureFromHome(home),
      source,
    });
  } catch (error) {
    console.warn(`[semantic-cache] record failed: ${error.message}`);
  }
}

function shouldUseSemanticPlanningCache() {
  const value = String(process.env.JARVIS_SEMANTIC_CACHE_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "disabled", "no"].includes(value);
}

function parsePcMarkdownRequest(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const wantsMarkdown = /(^|[^a-z])md([^a-z]|$)|markdown|\.md/i.test(value);
  const wantsFile = /文件|文档|笔记|文本|便签|记录/.test(value);
  const wantsWrite = /新建|创建|建立|生成|写入|保存|建一个|建个/.test(value);
  if ((!wantsMarkdown && !wantsFile) || !wantsWrite) return null;
  return {
    filename: extractMarkdownFilename(value),
    content: extractMarkdownContent(value),
    overwrite: /覆盖|重写|重新写|更新/.test(value),
  };
}

function extractMarkdownFilename(text) {
  const raw = String(text || "");
  const explicitAscii = raw.match(/([A-Za-z0-9_-]+\.md)/i);
  if (explicitAscii?.[1]) return explicitAscii[1];

  const compact = String(text || "").replace(/\s+/g, "");

  const named = compact.match(/(?:叫做|叫|名为|名字叫|文件名(?:为|叫)?)([A-Za-z0-9_\-\u4e00-\u9fa5]+)(?:的)?(?:MD|md|Markdown|markdown)/i);
  const namedStem = normalizeMarkdownFilenameStem(named?.[1]);
  if (namedStem) return `${namedStem}.md`;

  const createNamed = compact.match(/(?:新建|创建|建立|生成)(?:一个|个)?([A-Za-z0-9_\-\u4e00-\u9fa5]+)(?:的)?(?:MD|md|Markdown|markdown)/i);
  const createStem = normalizeMarkdownFilenameStem(createNamed?.[1]);
  if (createStem) return `${createStem}.md`;

  const createFileNamed = compact.match(/(?:新建|创建|建立|生成)(?:一个|个)?([A-Za-z0-9_\-\u4e00-\u9fa5]+?)(?:的)?(?:文件|文档|笔记|文本|便签|记录)/i);
  const createFileStem = normalizeMarkdownFilenameStem(createFileNamed?.[1]);
  if (createFileStem) return `${createFileStem}.md`;

  return "hello.md";
}

function normalizeMarkdownFilenameStem(stem) {
  const value = String(stem || "").trim().replace(/的$/, "");
  if (!value || ["一个", "个", "文件", "文档", "文本", "笔记", "便签", "记录", "md", "markdown"].includes(value.toLowerCase())) return "";
  return value;
}

function extractMarkdownContent(text) {
  const quoted = String(text).match(/(?:写入|内容是|内容为|保存)[：:\s]*[“"']([^”"']+)[”"']/);
  if (quoted?.[1]?.trim()) return normalizeSpokenFileContent(quoted[1].trim());
  const inline = String(text).match(/(?:写入|内容是|内容为|保存)[：:\s]*([^，。！？!?,]+)/);
  if (inline?.[1]?.trim()) return normalizeSpokenFileContent(inline[1].trim());
  if (/helloworld/i.test(text)) return "helloworld";
  if (/hello\s*world|hello\s*word/i.test(text)) return "helloworld";
  return "helloworld";
}

function normalizeSpokenText(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("{") || !value.endsWith("}")) return normalizeVoiceAsrText(value);
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.content === "string" && parsed.content.trim()) return normalizeVoiceAsrText(parsed.content);
  } catch {
    // Keep the original text if it is not a JSON ASR wrapper.
  }
  return normalizeVoiceAsrText(value);
}

function normalizeSpokenFileContent(content) {
  const value = String(content || "").trim();
  if (/^hello\s*world$/i.test(value) || /^hello\s*word$/i.test(value) || /^helloworld$/i.test(value)) return "helloworld";
  return value;
}

function extractChatCompletionUserText(messages) {
  if (!Array.isArray(messages)) return "";
  const userMessages = messages.filter((message) => message?.role === "user");
  const last = userMessages.at(-1);
  return extractChatMessageContent(last?.content).trim();
}

function extractChatMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    if (typeof part?.text === "string") return part.text;
    return "";
  }).join("\n");
}

function resolveXiaozhiDeviceId(headers = {}) {
  return String(
    process.env.JARVIS_XIAOZHI_DEVICE_ID
    || headers["device-id"]
    || headers["x-device-id"]
    || headers["client-id"]
    || headers["x-client-id"]
    || "stackchan-xiaozhi",
  ).trim();
}

function resolveXiaozhiRoomId(headers = {}, deviceId = "") {
  return String(
    process.env.JARVIS_XIAOZHI_ROOM_ID
    || headers["room-id"]
    || headers["x-room-id"]
    || stackchanDeviceRooms.get(deviceId)
    || "",
  ).trim();
}

function resolveXiaozhiSessionId(headers = {}) {
  const explicit = String(
    headers["x-session-id"]
    || headers["session-id"]
    || headers["x-conversation-id"]
    || "",
  ).trim();
  if (explicit) return explicit;
  const deviceId = resolveXiaozhiDeviceId(headers);
  return `xiaozhi:${deviceId || "stackchan-xiaozhi"}`;
}

function resolveXiaozhiDeliveryOrigin(headers = {}) {
  const deviceId = resolveXiaozhiDeviceId(headers);
  return {
    ingress: "xiaozhi_llm",
    trigger: "xiaozhi_llm",
    sourceDeviceId: deviceId,
    roomId: resolveXiaozhiRoomId(headers, deviceId),
    wakeSessionId: resolveXiaozhiSessionId(headers),
  };
}

function sendOpenAiChatCompletionStream(response, completion) {
  const choice = completion.choices?.[0];
  const content = choice?.message?.content || "";
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

function formatMcpToolReplyText(result) {
  if (result?.status === "dry_run") {
    return `没有打开真实设备：当前是 dry-run 预览模式。${result.replyText || result.display || ""}`.trim();
  }
  return result?.replyText || result?.display || JSON.stringify(result);
}

function buildMcpToolText(toolName, args = {}) {
  const explicitText = String(args.text ?? "").trim();
  if (explicitText) return explicitText;

  const target = String(args.target ?? args.name ?? args.device ?? args.entity ?? "").trim();
  const room = String(args.room ?? "").trim();
  if (!target) return "";
  const targetText = target.includes(room) ? target : `${room}${target}`;
  if (toolName === "turn_on_home_device") return `打开${targetText}`;
  if (toolName === "turn_off_home_device") return `关闭${targetText}`;
  if (toolName === "get_home_device_state") return `${targetText}开着吗`;
  return targetText;
}

function validateMcpBridgePolicy({ text, roomId }) {
  validateAllowedTexts(text, process.env.JARVIS_MCP_ALLOWED_TEXTS, "MCP bridge");
  const allowedRooms = String(process.env.JARVIS_MCP_ALLOWED_ROOM_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowedRooms.length && !allowedRooms.includes(String(roomId || "").trim())) {
    throw statusError(`MCP bridge rejected roomId ${roomId || "(empty)"}`, 403);
  }
  const requiredPattern = String(process.env.JARVIS_MCP_REQUIRE_TEXT_PATTERN || "").trim();
  if (requiredPattern) {
    const pattern = new RegExp(requiredPattern);
    if (!pattern.test(text)) throw statusError("MCP bridge rejected utterance outside the allowed text pattern", 403);
  }
}

function validateJarvisIngressPolicy({ text, roomId, deviceId }) {
  validateAllowedTexts(text, process.env.JARVIS_INGRESS_ALLOWED_TEXTS, "Jarvis ingress");
  const allowedDevices = String(process.env.JARVIS_INGRESS_ALLOWED_DEVICE_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowedDevices.length && !allowedDevices.includes(String(deviceId || "").trim())) {
    throw statusError(`Jarvis ingress rejected deviceId ${deviceId || "(empty)"}`, 403);
  }

  const allowedRooms = String(process.env.JARVIS_INGRESS_ALLOWED_ROOM_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowedRooms.length && !allowedRooms.includes(String(roomId || "").trim())) {
    throw statusError(`Jarvis ingress rejected roomId ${roomId || "(empty)"}`, 403);
  }

  const requiredPattern = String(process.env.JARVIS_INGRESS_REQUIRE_TEXT_PATTERN || "").trim();
  if (requiredPattern) {
    const pattern = new RegExp(requiredPattern);
    if (!pattern.test(text)) throw statusError("Jarvis ingress rejected utterance outside the allowed text pattern", 403);
  }
}

function validateAllowedTexts(text, rawAllowedTexts, label) {
  const allowedTexts = String(rawAllowedTexts || "")
    .split("|")
    .map((item) => normalizeGuardText(item))
    .filter(Boolean);
  if (allowedTexts.length === 0) return;
  const normalizedText = normalizeGuardText(text);
  if (!allowedTexts.includes(normalizedText)) {
    throw statusError(`${label} rejected utterance outside the exact allowed text list`, 403);
  }
}

function normalizeGuardText(text) {
  return String(text || "")
    .replace(/[。！？!?,，.\s]/g, "")
    .trim();
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseBooleanEnv(value) {
  return ["1", "true", "yes", "on", "enabled", "real"].includes(String(value ?? "").trim().toLowerCase());
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

function applyTrustedRoomTextDefaults(utterance) {
  const roomLabel = trustedRoomSpeechLabel(utterance.roomId);
  if (!roomLabel || hasSpecificRoomReference(utterance.text)) return utterance;
  const expandedText = prefixImplicitRoomDevice(utterance.text, roomLabel);
  if (expandedText === utterance.text) return utterance;
  return {
    ...utterance,
    originalText: utterance.originalText || utterance.text,
    text: expandedText,
  };
}

function trustedRoomSpeechLabel(roomId) {
  if (roomId === "second") return "次卧";
  return "";
}

function prefixImplicitRoomDevice(text, roomLabel) {
  const value = String(text || "").trim();
  if (!/^(打开|开启|关闭|关掉|关上|把|请问|查询|看看|看一下)?(一下|下|那个|这个)?(吸顶灯|入户射灯|床头右射灯|床头左射灯|床头射灯|床尾射灯|射灯)/.test(value)) {
    return value;
  }
  return value.replace(
    /^(打开|开启|关闭|关掉|关上|把|请问|查询|看看|看一下)?(一下|下|那个|这个)?(?=(吸顶灯|入户射灯|床头右射灯|床头左射灯|床头射灯|床尾射灯|射灯))/,
    `$1$2${roomLabel}`,
  );
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

async function callHermesSlowPath(utterance, { timeoutMs: overrideTimeoutMs } = {}) {
  if (String(process.env.HERMES_API_TRANSPORT || "").trim().toLowerCase() === "cli") {
    return callHermesCliOneShot(utterance, { timeoutMs: overrideTimeoutMs });
  }
  const baseUrl = process.env.HERMES_API_BASE_URL || process.env.HERMES_API_URL;
  const apiKey = process.env.HERMES_API_KEY || process.env.API_SERVER_KEY;
  if (!baseUrl) return null;
  const startedAt = Date.now();
  const configuredTimeoutMs = Number(process.env.HERMES_API_TIMEOUT_MS ?? 3500);
  const timeoutMs = Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0
    ? overrideTimeoutMs
    : Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 3500;
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

async function callHermesCliOneShot(utterance, { timeoutMs: overrideTimeoutMs } = {}) {
  const startedAt = Date.now();
  const configuredTimeoutMs = Number(process.env.HERMES_API_TIMEOUT_MS ?? 15000);
  const timeoutMs = Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0
    ? overrideTimeoutMs
    : Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 15000;
  const hermesHome = process.env.HERMES_HOME || resolve(homedir(), ".hermes");
  const hermesAgentRoot = process.env.HERMES_AGENT_ROOT || resolve(hermesHome, "hermes-agent");
  const python = process.env.HERMES_CLI_PYTHON || resolve(hermesAgentRoot, "venv/bin/python");
  const model = process.env.HERMES_API_MODEL || "";
  const args = ["-m", "hermes_cli.main", "--oneshot", utterance.text];
  if (model && model !== "jarvis") args.push("--model", model);
  return new Promise((resolve) => {
    const child = spawn(python, args, {
      cwd: process.cwd(),
      env: buildHermesCliEnv({ hermesHome, hermesAgentRoot }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(hermesFallbackResult({
        status: "brain_unavailable",
        replyText: "Hermes 本地命令暂时不可用，我先不继续处理这个问题。",
        latencyMs: Date.now() - startedAt,
        error: error.message,
      }));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal === "SIGTERM") {
        resolve(hermesFallbackResult({
          status: "brain_timeout",
          replyText: "Hermes 慢路径响应超时了，我先不继续处理这个问题。",
          latencyMs: Date.now() - startedAt,
          error: `Hermes CLI timed out after ${timeoutMs}ms`,
        }));
        return;
      }
      if (code !== 0) {
        resolve(hermesFallbackResult({
          status: "brain_unavailable",
          replyText: "Hermes 慢路径现在暂时不可用，我先不继续处理这个问题。",
          latencyMs: Date.now() - startedAt,
          error: stderr.trim() || `Hermes CLI exited ${code}`,
        }));
        return;
      }
      resolve({
        status: "answered",
        replyText: stdout.trim() || "Hermes 没有返回可播报内容。",
        latencyMs: Date.now() - startedAt,
      });
    });
  });
}

function buildHermesCliEnv({ hermesHome, hermesAgentRoot }) {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    HERMES_HOME: hermesHome,
    PYTHONPATH: hermesAgentRoot,
    TERM: "dumb",
    NO_COLOR: "1",
  };
}

function hermesFallbackResult({ status, replyText, latencyMs, error }) {
  return {
    status,
    replyText,
    latencyMs,
    error,
  };
}

async function maybeBuildHermesHomeIntentDraft(utterance) {
  if (!shouldUseHermesHomeIntentPlanner()) return null;
  const baseUrl = process.env.HERMES_HOME_INTENT_API_BASE_URL || process.env.HERMES_API_BASE_URL || process.env.HERMES_API_URL;
  if (!baseUrl || !activeProviderAdapter.isConfigured()) return null;
  const startedAt = Date.now();
  const timeoutMs = configuredHermesHomeIntentTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const home = await discoverCurrentHcmHome();
    const devices = compileHcmForPlanner(home, {
      input: utterance.text,
      currentRoomId: utterance.roomId,
      selectedRoomId: utterance.roomId,
      limit: 200,
    });
    const contextPack = buildPromptContextPackV2({
      input: utterance.text,
      home,
      devices,
      currentRoomId: utterance.roomId,
      selectedRoomId: utterance.roomId,
      personalSemantics: await compilePersonalSemanticsForPlanner(utterance.text, home),
      learningContext: await compileHouseholdLearningContext(readLearningMemory(), { input: utterance.text, home }),
      conversation: conversationContextStore.get(utterance.wakeSessionId || utterance.deviceId),
    });
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(process.env.HERMES_HOME_INTENT_API_KEY || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY
          ? { Authorization: `Bearer ${process.env.HERMES_HOME_INTENT_API_KEY || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: process.env.HERMES_HOME_INTENT_MODEL || process.env.HERMES_API_MODEL || "jarvis",
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildHermesHomeIntentSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify({
              input: utterance.text,
              deviceId: utterance.deviceId,
              currentRoomId: utterance.roomId || null,
              selectedRoomId: utterance.roomId || null,
              hcm_context: contextPack,
              devices,
            }),
          },
        ],
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      console.warn(`[hermes-home-intent] HTTP ${response.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const content = JSON.parse(text).choices?.[0]?.message?.content;
    if (!content) return null;
    const draft = parseJsonContent(content);
    validatePlannerDraft(draft);
    return {
      ...draft,
      summary: draft.summary || utterance.text,
      _source: "hermes_home_intent",
      _latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error.name !== "AbortError") console.warn(`[hermes-home-intent] ${error.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function shouldUseHermesHomeIntentPlanner() {
  const explicit = process.env.JARVIS_HOME_INTENT_PLANNER ?? process.env.JARVIS_HERMES_HOME_INTENT;
  const mode = String(explicit || "").trim().toLowerCase();
  if (["off", "false", "0", "disabled", "none", "local"].includes(mode)) return false;
  if (["hermes", "true", "1", "on", "auto"].includes(mode)) return true;
  return Boolean(process.env.HERMES_HOME_INTENT_API_BASE_URL || process.env.HERMES_API_BASE_URL || process.env.HERMES_API_URL);
}

function configuredHermesHomeIntentTimeoutMs() {
  const value = Number(process.env.JARVIS_HOME_INTENT_TIMEOUT_MS ?? process.env.HERMES_HOME_INTENT_TIMEOUT_MS ?? 2500);
  return Number.isFinite(value) && value > 0 ? value : 2500;
}

function buildHermesHomeIntentSystemPrompt() {
  return [
    "你是 Jarvis 的 Hermes Brain 家居意图规划器。",
    "你只负责理解用户自然语言并输出 HCM-level JSON，不允许直接控制 Home Assistant，不允许编造设备、房间或能力。",
    "你会收到完整 HCM 上下文，包括房间、设备、别名、状态、能力、会话焦点和安全策略。",
    "显式房间优先；如果用户明确说主卧，就不要因为 StackChan 在次卧而改成次卧。没有显式房间时，可以参考 currentRoomId、selectedRoomId 和 conversation。",
    "中文口语词、语气词、ASR 小错误要按上下文理解，但不确定时必须 needs_confirmation=true 且不给 actions。",
    "返回严格 JSON，使用 HCM device id / capability id 或 target/room_id 语义动作，Provider service call 由 HCM 编译。",
    "JSON 形状：",
    '{"intent_type":"device_control|scene|state_query|inventory_query|unknown","intent":"string","confidence":0.0,"summary":"中文短句","needs_confirmation":false,"query":{"mode":"state|count|list","device_id":"可空","target":"可空","room_id":"可空","reason":"中文短句"},"actions":[{"device_id":"可空","target":"可空","room_id":"可空","capability":"power 或 HCM capability id","value":true,"reason":"中文短句"}],"intent_frame":{"intent_type":"device_control|scene|state_query|inventory_query|unknown","intent":"string","confidence":0.0,"goal":{"domain":"lighting|climate|media|cover|general","desired_outcome":"string","space_refs":[],"target_refs":[],"constraints":[]},"grounding":{"required_facts":[],"candidate_targets":[]},"ambiguity":{"level":"low|medium|high","needs_clarification":false,"ambiguous_terms":[],"alternatives":[]},"decision":{"mode":"execute|answer|ask_clarification|no_action","reason":"中文短句"}}}',
  ].join("\n");
}

function applyConversationFocusToExternalDraft(draft, { input = "", conversation } = {}) {
  if (!draft || !Array.isArray(draft.actions) || draft.actions.length === 0) return draft;
  if (!shouldUseConversationFocusForExternalDraft(input, conversation)) return draft;
  let changed = false;
  const focusedTargets = conversation.focusedTargets ?? [];
  const focusedRooms = conversation.focusedRooms ?? [];
  const actions = draft.actions.flatMap((action) => {
    if (action?.device_id || action?.thingId) return [action];
    const matchedTargets = matchingFocusedTargetsForAction(action, input, focusedTargets);
    if (matchedTargets.length > 0) {
      changed = true;
      return matchedTargets.map((target) => ({
        ...action,
        device_id: target.id,
        target: target.name,
        room_id: target.roomId || action.room_id,
        reason: action.reason || `${target.name} 来自上一轮对话焦点`,
      }));
    }
    if (focusedRooms.length === 1 && !action.room_id) {
      changed = true;
      return [{
        ...action,
        room_id: focusedRooms[0].id,
        reason: action.reason || `${focusedRooms[0].name || focusedRooms[0].id} 来自上一轮对话焦点`,
      }];
    }
    return [action];
  });
  return changed ? { ...draft, actions } : draft;
}

function shouldUseConversationFocusForExternalDraft(input = "", conversation = null) {
  if (!conversation) return false;
  if (hasSpecificRoomReference(input)) return false;
  const hasFocus = (conversation.focusedTargets?.length ?? 0) > 0 || (conversation.focusedRooms?.length ?? 0) > 0;
  if (!hasFocus) return false;
  return isReferentialControlInput(input) || isRoomScopedFollowUpInput(input) || looksLikeShortLightFollowUp(input);
}

function matchingFocusedTargetsForAction(action = {}, input = "", focusedTargets = []) {
  if (!Array.isArray(focusedTargets) || focusedTargets.length === 0) return [];
  const targetRef = normalizeConversationFocusTarget(action.target || action.name || input);
  if (!targetRef || /^(灯|照明|它|这个|那个)$/.test(targetRef)) return focusedTargets;
  const matches = focusedTargets.filter((target) => {
    const targetName = normalizeConversationFocusText(target.name);
    return targetName.includes(targetRef) || targetRef.includes(targetName);
  });
  return matches.length > 0 ? matches : [];
}

function looksLikeShortLightFollowUp(input = "") {
  const text = normalizeConversationFocusText(input);
  return /^(打开|开启|开|关闭|关掉|关上|关)(射灯|吊灯|灯带|台灯|主灯|吸顶灯|筒灯|壁灯|落地灯|灯)(一下|下|吧|了)?$/.test(text)
    || /^(射灯|吊灯|灯带|台灯|主灯|吸顶灯|筒灯|壁灯|落地灯|灯)(打开|开启|开|关闭|关掉|关上|关)(一下|下|吧|了)?$/.test(text);
}

function normalizeConversationFocusTarget(value = "") {
  return normalizeConversationFocusText(value)
    .replace(/^(请|麻烦|帮我|给我|替我|能不能|可以|把|将|那个|这个)+/, "")
    .replace(/^(打开|开启|开一下|开下|开|关闭|关掉|关上|关一下|关下|关)/, "")
    .replace(/(打开|开启|开一下|开下|开|关闭|关掉|关上|关一下|关下|关)$/, "")
    .replace(/^(一下|下)+/, "")
    .replace(/(一下|下|吧|了)$/, "");
}

function normalizeConversationFocusText(value = "") {
  return String(value ?? "").trim().replace(/[，。！？,.!?\s]/g, "");
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
    const home = await runCommandStage(trace, "semantic_overlay", async () => applyRuntimeHomeSemantics(rawHome), {
      summarize: (home) => ({
        autoExecutable: home.stats.autoExecutableCapabilities,
        protected: home.stats.unresolvedBindingCount,
        spatial: Boolean(home.spatialSemantic?.applied),
        spatialAssets: home.spatialSemantic?.assignedAssetCount ?? 0,
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
    const homeIntentDraft = payload.homeIntent ? createPlannerDraftFromHomeIntent(payload.homeIntent) : null;
    const externalPlannerDraft = applyConversationFocusToExternalDraft(payload.plannerDraft ?? homeIntentDraft, {
      input: payload.input,
      conversation,
    });
    const useExternalDraft = (Boolean(payload.skipPlanner) || Boolean(payload.homeIntent)) && externalPlannerDraft;
    const draft = useExternalDraft
      ? await runCommandStage(
          trace,
          payload.homeIntent ? "brain_home_intent" : "planner_external",
          () => externalPlannerDraft,
          {
            summarize: (draft) => ({
              intent: draft.intent,
              intentType: draft.intent_type ?? draft.intent_frame?.intent_type,
              frame: Boolean(draft.intent_frame),
              actionCount: draft.actions?.length ?? draft.intent_frame?.decision?.actions?.length ?? 0,
              source: payload.homeIntent ? "jarvis_brain_home_intent" : payload.plannerDraftSource || "external",
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
    const entityScopedPolicyPlan = await runCommandStage(
      trace,
      "entity_scope_gate",
      async () => applyAllowedEntityScope(policyPlan),
      {
        summarize: (scopedPlan) => ({
          accepted: scopedPlan.accepted.length,
          rejected: scopedPlan.rejected.length,
          scopeEnabled: parseAllowedEntityIds().size > 0,
        }),
      },
    );
    const scopedPolicyPlan = await runCommandStage(
      trace,
      "action_room_scope_gate",
      async () => applyAllowedActionRoomScope(entityScopedPolicyPlan),
      {
        summarize: (scopedPlan) => ({
          accepted: scopedPlan.accepted.length,
          rejected: scopedPlan.rejected.length,
          scopeEnabled: parseAllowedActionRoomIds().size > 0,
          allowedRooms: Array.from(parseAllowedActionRoomIds()),
        }),
      },
    );
    const serviceSimulation = await runCommandStage(
      trace,
      "ha_service_simulator",
      async () => simulateProviderExecutionPlan({ adapter: activeProviderAdapter, accepted: scopedPolicyPlan.accepted, home }),
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
          policyPlan: scopedPolicyPlan,
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
      accepted: scopedPolicyPlan.accepted.map((item) => formatAcceptedExecution(item, serviceSimulation)),
      rejected: [...scopedPolicyPlan.rejected, ...serviceSimulation.rejected],
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
    } else if (!scopedPolicyPlan.ok) {
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
  const home = await discoverCurrentHcmHome();
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
    logicalRoomId: item.action.logicalRoomId ?? item.thing.spaceId,
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

function applyAllowedEntityScope(policyPlan) {
  const allowedEntityIds = parseAllowedEntityIds();
  if (allowedEntityIds.size === 0) return policyPlan;

  const accepted = [];
  const rejectedByScope = [];
  for (const item of policyPlan.accepted ?? []) {
    const entityId = extractExecutionEntityId(item);
    if (entityId && allowedEntityIds.has(entityId)) {
      accepted.push(item);
      continue;
    }
    rejectedByScope.push({
      ok: false,
      code: "entity_outside_stage_scope",
      message: `${item.thing?.name || item.action?.thingName || "目标"} 不在本阶段允许控制的实体白名单内`,
      action: item.action,
      thingId: item.thing?.id,
      thingName: item.thing?.name,
      capabilityId: item.capability?.id,
      capabilityName: item.capability?.name,
      entityId: entityId || null,
    });
  }

  return {
    ...policyPlan,
    ok: accepted.length > 0,
    accepted,
    rejected: [...(policyPlan.rejected ?? []), ...rejectedByScope],
    summary: {
      ...(policyPlan.summary ?? {}),
      acceptedCount: accepted.length,
      rejectedCount: (policyPlan.rejected?.length ?? 0) + rejectedByScope.length,
      policyCodes: [
        ...(policyPlan.summary?.policyCodes ?? []),
        ...rejectedByScope.map((item) => item.code),
      ],
    },
  };
}

function parseAllowedEntityIds() {
  return new Set(
    String(process.env.JARVIS_ALLOWED_ENTITY_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function extractExecutionEntityId(item) {
  const direct = item?.serviceCall?.serviceData?.entity_id;
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0];
  return item?.capability?.binding?.entityId || item?.capability?.binding?.entity_id || "";
}

function applyAllowedActionRoomScope(policyPlan) {
  const allowedRoomIds = parseAllowedActionRoomIds();
  if (allowedRoomIds.size === 0) return policyPlan;

  const accepted = [];
  const rejectedByScope = [];
  for (const item of policyPlan.accepted ?? []) {
    const roomIds = extractExecutionRoomIds(item);
    if (roomIds.length > 0 && roomIds.every((roomId) => allowedRoomIds.has(roomId))) {
      accepted.push(item);
      continue;
    }
    rejectedByScope.push({
      ok: false,
      code: "action_room_outside_stage_scope",
      message: `${item.thing?.name || item.action?.thingName || "目标"} 不在当前真实执行允许的房间范围内`,
      action: item.action,
      thingId: item.thing?.id,
      thingName: item.thing?.name,
      capabilityId: item.capability?.id,
      capabilityName: item.capability?.name,
      roomIds,
      allowedRoomIds: Array.from(allowedRoomIds),
    });
  }

  return {
    ...policyPlan,
    ok: accepted.length > 0,
    accepted,
    rejected: [...(policyPlan.rejected ?? []), ...rejectedByScope],
    summary: {
      ...(policyPlan.summary ?? {}),
      acceptedCount: accepted.length,
      rejectedCount: (policyPlan.rejected?.length ?? 0) + rejectedByScope.length,
      policyCodes: [
        ...(policyPlan.summary?.policyCodes ?? []),
        ...rejectedByScope.map((item) => item.code),
      ],
    },
  };
}

function parseAllowedActionRoomIds() {
  return new Set(
    String(process.env.JARVIS_ALLOWED_ACTION_ROOM_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function extractExecutionRoomIds(item) {
  const logicalRoomId = item?.action?.logicalRoomId;
  if (typeof logicalRoomId === "string" && logicalRoomId.trim()) return [logicalRoomId.trim()];
  return Array.from(new Set([
    item?.action?.roomId,
    item?.thing?.spaceId,
    item?.thing?.roomId,
    item?.capability?.roomId,
    item?.capability?.logicalRoomId,
  ].filter((roomId) => typeof roomId === "string" && roomId.trim()).map((roomId) => roomId.trim())));
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
