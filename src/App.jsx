import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  Clock3,
  Cpu,
  Gauge,
  Home,
  Info,
  Layers3,
  LocateFixed,
  LockKeyhole,
  Map as MapIcon,
  Mic,
  MicOff,
  MousePointer2,
  Network,
  Pencil,
  Plus,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import ThreeHouse from "./ThreeHouse.jsx";
import { applyDigitalTwinLayersToScene, buildDigitalTwinLayers } from "./digitalTwinLayers.js";
import { planCommand } from "./commandPipeline.js";
import { createHouseSceneModel, getSceneRoomName } from "./houseSceneModel.js";
import {
  addSpatialRoom,
  assignSpatialDevice,
  applySpatialEditorToScene,
  applySpatialSuggestion,
  clearSpatialPlacement,
  createSpatialEditorModel,
  createSpatialEditorState,
  dismissSpatialSuggestion,
  findSpatialRoomAtPoint,
  hasSpatialEditorEdits,
  mergeSpatialRooms,
  migrateSpatialEditorStateToImageCoordinates,
  NAMING_MODES,
  placeSpatialDevice,
  removeSpatialRoom,
  splitSpatialRoom,
  SPATIAL_DEVICE_STATUS,
  updateSpatialDeviceName,
  updateSpatialRoomRect,
  updateSpatialRoomRects,
  updateSpatialRoomName,
} from "./spatialHomeEditor.js";
import {
  applyDefaultRunPolicy,
  captureAutomationEvents,
  deleteLearningCandidate,
  getAgentSnapshot,
  getAutomationSuggestions,
  getCommandAudit,
  getHcmHome,
  getLearningMemory,
  getOnboardingPlan,
  getRuntimeStatus,
  getSpatialEditorState,
  recordOnboardingSnapshot,
  previewAutomationSuggestion,
  replayCommandAudit,
  runHcmCommand,
  saveSpatialEditorState,
  updateLearningCandidate,
  updateAutomationSuggestion,
  updateHcmThingOverride,
} from "./hcmClient.js";
import { getLlmStatus, requestLlmPlan } from "./llmClient.js";
import { assessSpeechTranscript, createBrowserSpeechInput, createBrowserSpeechOutput } from "./speechRuntime.js";
import {
  createInitialLog,
  describeStep,
  deviceTypeNames,
  examples,
  executePlan,
  getRoomName,
  inferCurrentRoom,
  initialDevices,
  rooms,
  summarizeHome,
  tickDevices,
} from "./simulator.js";
import { createDeviceManifest } from "./deviceRuntime.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPATIAL_EDITOR_STORAGE_KEY = "harness-house.spatial-editor.v0.22";
const SPATIAL_EDITOR_LEGACY_STORAGE_KEYS = [
  "harness-house.spatial-editor.v0.21",
  "harness-house.spatial-editor.v0.20",
  "harness-house.spatial-editor.v0.19",
  "harness-house.spatial-editor.v0.18B",
];
const APP_VIEWS = {
  CONTROL: "control",
  MAP_EDITOR: "map-editor",
  HOME_MODEL: "home-model",
};
const COMMAND_EXECUTION_PREFERENCE = {
  DRY_RUN: "dry_run",
  REAL: "real",
};

function makeMessage(role, content, meta = {}) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    ...meta,
  };
}

function latencyClass(latency) {
  if (latency < 800) return "good";
  if (latency < 2000) return "ok";
  return "slow";
}

function canUseRealHcmCommand(home, llmStatus) {
  return Boolean(
    home?.things?.length > 0 &&
      llmStatus?.configured &&
      llmStatus?.mode === "real",
  );
}

function isActiveHomeDevice(device) {
  if (!device) return false;
  if ("on" in device) return Boolean(device.on);
  if ("detected" in device) return Boolean(device.detected);
  if ("open" in device) return Boolean(device.open);
  if (device.type === "robot_vacuum") return device.status === "cleaning";
  if (["washer", "dryer"].includes(device.type)) return device.status === "running";
  return false;
}

function readSpatialEditorState() {
  if (typeof window === "undefined") return createSpatialEditorState();
  for (const key of [SPATIAL_EDITOR_STORAGE_KEY, ...SPATIAL_EDITOR_LEGACY_STORAGE_KEYS]) {
    try {
      const value = window.localStorage.getItem(key);
      if (value) return createSpatialEditorState(JSON.parse(value));
    } catch {
      return createSpatialEditorState();
    }
  }
  return createSpatialEditorState();
}

function writeSpatialEditorState(state) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SPATIAL_EDITOR_STORAGE_KEY, JSON.stringify(createSpatialEditorState(state)));
  } catch {
    // Oversized floor plan images can exceed localStorage; keep the runtime usable.
  }
}

function readAppView() {
  if (typeof window === "undefined") return APP_VIEWS.CONTROL;
  if (window.location.hash === "#home-model") return APP_VIEWS.HOME_MODEL;
  return window.location.hash === "#map-editor" ? APP_VIEWS.MAP_EDITOR : APP_VIEWS.CONTROL;
}

function isImageFile(file) {
  return Boolean(file?.type?.startsWith("image/"));
}

function formatFileSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

function clampRoomRectForMap(rect) {
  const width = Math.max(4, Math.min(100, Number(rect.width) || 4));
  const height = Math.max(4, Math.min(100, Number(rect.height) || 4));
  const left = Math.max(0, Math.min(100 - width, Number(rect.left) || 0));
  const top = Math.max(0, Math.min(100 - height, Number(rect.top) || 0));
  return {
    left: Math.round(left * 100) / 100,
    top: Math.round(top * 100) / 100,
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
  };
}

function conciseChatText(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";
  const priority = lines.find((line) => /是否|需要|已|无人|有人|状态未知|没有执行|等待|失败|离线/.test(line));
  return priority ?? lines[0];
}

export default function App() {
  const sessionIdRef = useRef(crypto.randomUUID());
  const [activeView, setActiveView] = useState(readAppView);
  const [devices, setDevices] = useState(() => structuredClone(initialDevices));
  const [input, setInput] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState("study");
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [capabilityOverrides, setCapabilityOverrides] = useState({});
  const [messages, setMessages] = useState(() => [
    makeMessage("assistant", "Harness House 本地模拟器已就绪。", {
      path: "system",
      latency: 0,
    }),
  ]);
  const [logs, setLogs] = useState(createInitialLog);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [lastPlan, setLastPlan] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [llmStatus, setLlmStatus] = useState({
    configured: false,
    mode: "simulated",
    model: "simulated",
  });
  const [runtimeStatus, setRuntimeStatus] = useState(null);
  const [executionPreference, setExecutionPreference] = useState(COMMAND_EXECUTION_PREFERENCE.DRY_RUN);
  const [hcmHome, setHcmHome] = useState(null);
  const [onboardingPlan, setOnboardingPlan] = useState(null);
  const [hcmStatus, setHcmStatus] = useState({
    state: "idle",
    error: null,
  });
  const [reviewActionId, setReviewActionId] = useState(null);
  const [defaultRunSummary, setDefaultRunSummary] = useState(null);
  const [commandAudit, setCommandAudit] = useState([]);
  const [learningMemory, setLearningMemory] = useState(null);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [automationSuggestions, setAutomationSuggestions] = useState(null);
  const [automationActionId, setAutomationActionId] = useState(null);
  const [intelligenceActionId, setIntelligenceActionId] = useState(null);
  const [onboardingActionId, setOnboardingActionId] = useState(null);
  const [speechState, setSpeechState] = useState({
    listening: false,
    speaking: false,
    confidence: 0,
    error: null,
    ttsEnabled: true,
  });
  const [spatialEditorState, setSpatialEditorState] = useState(readSpatialEditorState);
  const [spatialSyncStatus, setSpatialSyncStatus] = useState({
    state: "local",
    source: "localStorage",
    updatedAt: null,
    error: null,
  });
  const inputRef = useRef(null);
  const spatialRemoteReadyRef = useRef(false);
  const lastSpokenMessageIdRef = useRef(null);
  const speechInput = useMemo(() => createBrowserSpeechInput(), []);
  const speechOutput = useMemo(() => createBrowserSpeechOutput(), []);
  const realExecutionAvailable = runtimeStatus?.execution?.mode === "real";
  const effectiveCommandMode =
    realExecutionAvailable && executionPreference === COMMAND_EXECUTION_PREFERENCE.REAL
      ? COMMAND_EXECUTION_PREFERENCE.REAL
      : COMMAND_EXECUTION_PREFERENCE.DRY_RUN;

  useEffect(() => {
    const handleHashChange = () => setActiveView(readAppView());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const currentRoomId = useMemo(() => inferCurrentRoom(devices), [devices]);
  const baseHouseSceneModel = useMemo(
    () =>
      createHouseSceneModel({
        hcmHome,
        simulatorRooms: rooms,
        simulatorDevices: devices,
      }),
    [devices, hcmHome],
  );
  const spatialEditorModel = useMemo(
    () =>
      createSpatialEditorModel({
        hcmHome,
        sceneModel: baseHouseSceneModel,
        state: spatialEditorState,
      }),
    [baseHouseSceneModel, hcmHome, spatialEditorState],
  );
  const spatialHouseSceneModel = useMemo(
    () => applySpatialEditorToScene(baseHouseSceneModel, spatialEditorModel),
    [baseHouseSceneModel, spatialEditorModel],
  );
  const houseSceneModel = useMemo(
    () => {
      const twinLayers = buildDigitalTwinLayers({
        sceneModel: spatialHouseSceneModel,
        selectedRoomId,
        context: agentSnapshot?.agents?.context,
        plan: lastPlan,
        diagnostics: agentSnapshot?.agents?.diagnostics,
      });
      return applyDigitalTwinLayersToScene(spatialHouseSceneModel, twinLayers);
    },
    [agentSnapshot, lastPlan, selectedRoomId, spatialHouseSceneModel],
  );
  const selectedRoomDevices = useMemo(
    () =>
      houseSceneModel.devices.filter((device) => device.roomId === selectedRoomId),
    [houseSceneModel, selectedRoomId],
  );
  const liveOccupiedRooms = useMemo(() => {
    const occupied = houseSceneModel.devices
      .filter(
        (device) =>
          ["presence_sensor", "motion_sensor"].includes(device.type) &&
          device.detected,
      )
      .map((device) => device.roomId);
    return [...new Set(occupied)];
  }, [houseSceneModel.devices]);
  const liveCurrentRoomId = useMemo(
    () => inferCurrentRoom(Object.fromEntries(houseSceneModel.devices.map((d) => [d.id, d]))),
    [houseSceneModel.devices],
  );
  const selectedDevice = useMemo(
    () => selectedRoomDevices.find((device) => device.id === selectedDeviceId) ?? null,
    [selectedRoomDevices, selectedDeviceId],
  );
  const toggleCapability = useCallback((deviceKey, capabilityName) => {
    setCapabilityOverrides((prev) => {
      const key = `${deviceKey}:${capabilityName}`;
      return { ...prev, [key]: !prev[key] };
    });
  }, []);
  const selectedRoomName = useMemo(
    () => getSceneRoomName(selectedRoomId, houseSceneModel.rooms),
    [houseSceneModel.rooms, selectedRoomId],
  );
  const activeDevices = useMemo(
    () => houseSceneModel.devices.filter(isActiveHomeDevice),
    [houseSceneModel.devices],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setDevices((current) => tickDevices(current));
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    getLlmStatus().then(setLlmStatus);
    getRuntimeStatus().then(setRuntimeStatus).catch(() => setRuntimeStatus(null));
  }, []);

  useEffect(() => {
    const message = messages.at(-1);
    if (!speechState.ttsEnabled || !speechOutput.supported || !message || message.role !== "assistant" || message.path === "system") return;
    if (lastSpokenMessageIdRef.current === message.id) return;
    lastSpokenMessageIdRef.current = message.id;
    speechInput.stop();
    setSpeechState((current) => ({ ...current, listening: false }));
    speechOutput.speak(message.content, {
      key: message.id,
      onStart: () => setSpeechState((current) => ({ ...current, speaking: true })),
      onEnd: () => setSpeechState((current) => ({ ...current, speaking: false })),
      onError: (error) => setSpeechState((current) => ({ ...current, speaking: false, error: error.message })),
    });
  }, [messages, speechInput, speechOutput, speechState.ttsEnabled]);

  useEffect(() => () => {
    speechInput.stop();
    speechOutput.stop();
  }, [speechInput, speechOutput]);

  const refreshHcmHome = useCallback(async () => {
    setHcmStatus({ state: "loading", error: null });
    const [homeResult, onboardingResult] = await Promise.allSettled([getHcmHome(), getOnboardingPlan()]);
    if (homeResult.status === "fulfilled") {
      setHcmHome(homeResult.value);
      setHcmStatus({ state: "ready", error: null });
    } else {
      setHcmStatus({ state: "error", error: homeResult.reason.message });
    }
    if (onboardingResult.status === "fulfilled") {
      setOnboardingPlan(onboardingResult.value);
    } else {
      setOnboardingPlan(null);
    }
  }, []);

  useEffect(() => {
    refreshHcmHome();
  }, [refreshHcmHome]);

  const refreshIntelligence = useCallback(async () => {
    const [auditResult, memoryResult, agentResult, automationResult] = await Promise.allSettled([
      getCommandAudit({ limit: 8 }),
      getLearningMemory(),
      getAgentSnapshot(),
      getAutomationSuggestions(),
    ]);
    if (auditResult.status === "fulfilled") {
      setCommandAudit(auditResult.value.entries ?? []);
    } else {
      setCommandAudit([]);
    }
    if (memoryResult.status === "fulfilled") {
      setLearningMemory(memoryResult.value);
    } else {
      setLearningMemory(null);
    }
    if (agentResult.status === "fulfilled") {
      setAgentSnapshot(agentResult.value);
    } else {
      setAgentSnapshot(null);
    }
    if (automationResult.status === "fulfilled") {
      setAutomationSuggestions(automationResult.value);
    } else {
      setAutomationSuggestions(null);
    }
  }, []);

  useEffect(() => {
    refreshIntelligence();
  }, [refreshIntelligence]);

  useEffect(() => {
    let cancelled = false;
    const localState = readSpatialEditorState();
    getSpatialEditorState()
      .then(async (record) => {
        if (cancelled) return;
        const remoteState = createSpatialEditorState(record.state);
        if (record.exists && record.hasEdits) {
          setSpatialEditorState(remoteState);
          writeSpatialEditorState(remoteState);
          setSpatialSyncStatus({
            state: "synced",
            source: record.source || "server",
            updatedAt: record.updatedAt,
            error: null,
          });
        } else if (hasSpatialEditorEdits(localState)) {
          const migrated = await saveSpatialEditorState({
            state: localState,
            source: "localStorage_migration",
          });
          if (cancelled) return;
          setSpatialSyncStatus({
            state: "synced",
            source: migrated.source,
            updatedAt: migrated.updatedAt,
            error: null,
          });
        } else {
          setSpatialSyncStatus({
            state: "synced",
            source: "server",
            updatedAt: record.updatedAt,
            error: null,
          });
        }
        spatialRemoteReadyRef.current = true;
      })
      .catch((error) => {
        if (cancelled) return;
        spatialRemoteReadyRef.current = true;
        setSpatialSyncStatus({
          state: "local",
          source: "localStorage",
          updatedAt: null,
          error: error.message,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const normalized = createSpatialEditorState(spatialEditorState);
    writeSpatialEditorState(normalized);
    if (!spatialRemoteReadyRef.current) return;
    const timer = setTimeout(() => {
      setSpatialSyncStatus((current) => ({ ...current, state: "saving", error: null }));
      saveSpatialEditorState({
        state: normalized,
        source: "browser",
      })
        .then((record) => {
          setSpatialSyncStatus({
            state: "synced",
            source: record.source,
            updatedAt: record.updatedAt,
            error: null,
          });
        })
        .catch((error) => {
          setSpatialSyncStatus((current) => ({
            ...current,
            state: "error",
            error: error.message,
          }));
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [spatialEditorState]);

  const applyDefaultRun = useCallback(async () => {
    if (reviewActionId) return;
    setReviewActionId("default-run");
    setHcmStatus({ state: "loading", error: null });
    try {
      const result = await applyDefaultRunPolicy({ providerId: hcmHome?.provider?.id });
      setDefaultRunSummary(result.summary);
      setHcmHome(result.home);
      setHcmStatus({ state: "ready", error: null });
    } catch (error) {
      setHcmStatus({ state: "error", error: error.message });
    } finally {
      setReviewActionId(null);
    }
  }, [hcmHome?.provider?.id, reviewActionId]);

  const hideHcmThing = useCallback(
    async (thingId) => {
      if (!thingId || reviewActionId) return;
      setReviewActionId(`hide:${thingId}`);
      setHcmStatus({ state: "loading", error: null });
      try {
        await updateHcmThingOverride({
          providerId: hcmHome?.provider?.id,
          thingId,
          patch: { reviewHidden: true },
        });
        await refreshHcmHome();
      } catch (error) {
        setHcmStatus({ state: "error", error: error.message });
      } finally {
        setReviewActionId(null);
      }
    },
    [hcmHome?.provider?.id, refreshHcmHome, reviewActionId],
  );

  const recordOnboardingBaseline = useCallback(async () => {
    if (onboardingActionId) return;
    setOnboardingActionId("baseline");
    try {
      await recordOnboardingSnapshot();
      await refreshHcmHome();
      setLogs((current) => [
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          level: "success",
          text: "已记录当前 HA provider baseline，后续新增/变更设备会进入 Onboarding Plan。",
        },
        ...current,
      ]);
    } catch (error) {
      setLogs((current) => [
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          level: "cancel",
          text: `记录 Onboarding baseline 失败：${error.message}`,
        },
        ...current,
      ]);
    } finally {
      setOnboardingActionId(null);
    }
  }, [onboardingActionId, refreshHcmHome]);

  const replayAuditEntry = useCallback(
    async (entry) => {
      if (!entry?.commandId || intelligenceActionId) return;
      setIntelligenceActionId(`replay:${entry.commandId}`);
      try {
        const result = await replayCommandAudit({
          commandId: entry.commandId,
          currentRoomId,
          selectedRoomId,
        });
        setLogs((current) => [
          {
            id: crypto.randomUUID(),
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            level: "info",
            text: `Dry-run 回放：${entry.input} -> ${result.status}，计划 ${result.plan?.actions?.length ?? 0} 个动作`,
          },
          ...current,
        ]);
        setMessages((current) => [
          ...current,
          makeMessage("assistant", `已完成 dry-run 回放：${result.plan?.summary ?? entry.input}`, {
            path: "hcm-replay",
            latency: result.latencyMs,
            planId: result.commandId,
          }),
        ]);
        await refreshIntelligence();
      } catch (error) {
        setLogs((current) => [
          {
            id: crypto.randomUUID(),
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            level: "cancel",
            text: `Dry-run 回放失败：${error.message}`,
          },
          ...current,
        ]);
      } finally {
        setIntelligenceActionId(null);
      }
    },
    [currentRoomId, intelligenceActionId, refreshIntelligence, selectedRoomId],
  );

  const ignoreLearningCandidate = useCallback(
    async (candidate) => {
      if (!candidate?.id || intelligenceActionId) return;
      setIntelligenceActionId(`ignore:${candidate.id}`);
      try {
        const memory = await updateLearningCandidate({
          candidateId: candidate.id,
          status: "ignored",
          note: "用户在 Learning 面板忽略",
        });
        setLearningMemory(memory);
      } catch (error) {
        setLogs((current) => [
          {
            id: crypto.randomUUID(),
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            level: "cancel",
            text: `学习候选更新失败：${error.message}`,
          },
          ...current,
        ]);
      } finally {
        setIntelligenceActionId(null);
      }
    },
    [intelligenceActionId],
  );

  const deleteLearningCandidateFromMemory = useCallback(
    async (candidate) => {
      if (!candidate?.id || intelligenceActionId) return;
      setIntelligenceActionId(`delete:${candidate.id}`);
      try {
        const memory = await deleteLearningCandidate({ candidateId: candidate.id });
        setLearningMemory(memory);
      } catch (error) {
        setLogs((current) => [
          {
            id: crypto.randomUUID(),
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            level: "cancel",
            text: `学习候选删除失败：${error.message}`,
          },
          ...current,
        ]);
      } finally {
        setIntelligenceActionId(null);
      }
    },
    [intelligenceActionId],
  );

  const captureHomeEvents = useCallback(async () => {
    if (automationActionId) return;
    setAutomationActionId("capture");
    try {
      const result = await captureAutomationEvents();
      setAutomationSuggestions(result);
      setLogs((current) => [{
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        level: "info",
        text: `事件快照已采集：新增 ${result.capturedEvents?.length ?? 0} 个变化，自动化建议 ${result.suggestionCount ?? 0} 条。`,
      }, ...current]);
    } catch (error) {
      setLogs((current) => [{
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        level: "cancel",
        text: `事件快照采集失败：${error.message}`,
      }, ...current]);
    } finally {
      setAutomationActionId(null);
    }
  }, [automationActionId]);

  const reviewAutomationSuggestion = useCallback(async (suggestion, status) => {
    if (!suggestion?.id || automationActionId) return;
    setAutomationActionId(`${status}:${suggestion.id}`);
    try {
      setAutomationSuggestions(await updateAutomationSuggestion({ suggestionId: suggestion.id, status }));
    } catch (error) {
      setLogs((current) => [{
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        level: "cancel",
        text: `自动化建议更新失败：${error.message}`,
      }, ...current]);
    } finally {
      setAutomationActionId(null);
    }
  }, [automationActionId]);

  const simulateAutomation = useCallback(async (suggestion) => {
    if (!suggestion?.id || automationActionId) return;
    setAutomationActionId(`simulate:${suggestion.id}`);
    try {
      const result = await previewAutomationSuggestion(suggestion.id);
      setLastPlan({
        id: suggestion.id,
        kind: "automation_preview",
        path: "automation-preview",
        intent: suggestion.type,
        confidence: suggestion.confidence,
        summary: `${suggestion.summary}（仅模拟，不控制真实设备）`,
        steps: suggestion.actions.map((action) => ({
          id: `${suggestion.id}:${action.thingId}:${action.capabilityId}`,
          deviceId: action.thingId,
          deviceName: action.thingName,
          capability: action.capabilityName,
          value: action.value,
          risk: "low",
          reason: "automation preview",
        })),
        commandResult: { status: "dry_run", path: "automation-preview", latencyMs: 0 },
      });
      setLogs((current) => [{
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        level: result.preview?.ok ? "success" : "cancel",
        text: `自动化模拟：${suggestion.title} -> ${result.preview?.ok ? "通过" : "拒绝"}，未控制真实设备。`,
      }, ...current]);
    } catch (error) {
      setLogs((current) => [{
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        level: "cancel",
        text: `自动化模拟失败：${error.message}`,
      }, ...current]);
    } finally {
      setAutomationActionId(null);
    }
  }, [automationActionId]);

  async function submitCommand(raw = input, { source = "text" } = {}) {
    const command = raw.trim();
    if (!command || processing) return;

    setInput("");
    setPendingPlan(null);
    setMessages((current) => [...current, makeMessage("user", command)]);
    setProcessing(true);

    if (canUseRealHcmCommand(hcmHome, llmStatus)) {
      try {
        const realResult = await runHcmCommand({
          input: command,
          currentRoomId,
          selectedRoomId,
          sessionId: sessionIdRef.current,
          dryRun: effectiveCommandMode !== COMMAND_EXECUTION_PREFERENCE.REAL,
          source,
        });
        if (
          realResult.plan?.actions?.length > 0 ||
          ["answered", "executed", "partial_failure", "rejected", "needs_confirmation", "needs_clarification", "dry_run", "no_action"].includes(
            realResult.status,
          )
        ) {
          handleRealCommandResult(realResult);
          setProcessing(false);
          return;
        }
      } catch (error) {
        setLogs((current) => [
          {
            id: crypto.randomUUID(),
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            level: "info",
            text: `真实设备链路未执行，回退本地模拟：${error.message}`,
          },
          ...current,
        ]);
      }
    }

    const pipeline = await planCommand({
      input: command,
      devices,
      currentRoomId,
      selectedRoomId,
      llmStatus,
      requestRealPlan: requestLlmPlan,
      wait: delay,
    });
    let plan = pipeline.plan;

    if (pipeline.fallbackError) {
      setLogs((current) => [
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          level: "info",
          text: `真实 LLM 不可用，已退回 LLM Sim：${pipeline.fallbackError.message}`,
        },
        ...current,
      ]);
    }

    const latency = pipeline.commandResult.latencyMs;
    setLastPlan(plan);

    if (plan.kind === "empty") {
      setMessages((current) => [...current, makeMessage("assistant", plan.message, { latency })]);
      setProcessing(false);
      return;
    }

    if (plan.needsConfirmation) {
      setPendingPlan(plan);
      setMessages((current) => [
        ...current,
        makeMessage("assistant", `${plan.summary}\n等待确认。`, {
          path: plan.path,
          latency,
          planId: plan.id,
        }),
      ]);
      setLogs((current) => [
        {
          id: crypto.randomUUID(),
          time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          level: "confirm",
          text: `Safety Gate 拦截「${plan.intent}」，需要确认。`,
        },
        ...current,
      ]);
      setProcessing(false);
      return;
    }

    applyPlan(plan, latency);
    setProcessing(false);
  }

  async function handleRealCommandResult(result) {
    const okCount = result.execution?.results?.filter((item) => item.ok && item.verification?.ok !== false).length ?? 0;
    const failCount = result.execution?.results?.filter((item) => !item.ok || item.verification?.ok === false).length ?? 0;
    const accepted = result.execution?.accepted ?? [];
    const friendlyText = conciseChatText(result.explanation?.userMessage);
    const logText =
      friendlyText
        ? friendlyText
        : result.status === "answered"
        ? result.plan?.stateQuery?.summary || result.plan?.summary || "状态已读取。"
        : result.status === "no_action"
          ? result.plan?.summary || "没有找到可执行动作。"
        : result.status === "executed"
            ? `真实设备已执行：${accepted.map((item) => `${item.thingName} ${item.capabilityName}`).join("；")}`
            : result.status === "dry_run"
              ? `已完成模拟校验，未控制真实设备：${result.plan?.summary ?? "计划可查看。"}`
            : result.status === "needs_clarification"
              ? result.plan?.summary || "目标或能力尚不明确，需要补充信息。"
            : result.status === "partial_failure"
              ? `真实设备部分执行：成功 ${okCount}，失败 ${failCount}`
              : result.status === "rejected"
                ? `真实设备计划被拒绝：${result.execution?.rejected?.map((item) => item.message).join("；")}`
                : result.plan?.summary ?? "真实设备计划已生成。";

    setLastPlan({
      id: result.commandId,
      kind: "real_hcm",
      path: "hcm-real",
      intent: result.plan?.intent ?? "real_hcm",
      confidence: result.plan?.confidence ?? 0.6,
      summary: result.plan?.summary ?? logText,
      resolution: result.resolution,
      explanation: result.explanation,
      steps: accepted.map((item) => ({
        id: `${item.thingId}:${item.capabilityId}`,
        deviceId: item.logicalAssetId ?? item.thingId,
        providerDeviceId: item.thingId,
        deviceName: item.thingName,
        capability: item.capabilityName,
        value: item.value,
        risk: "low",
        reason: item.service,
      })),
      commandResult: {
        commandId: result.commandId,
        status: result.status,
        path: "hcm-real",
        latencyMs: result.latencyMs,
        stages: [
          { name: "hcm_planner", latencyMs: result.latencyMs, mode: "real" },
          { name: "ha_executor", latencyMs: 0, status: result.status },
        ],
      },
    });
    setLogs((current) => [
      {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        level: result.status === "executed" || result.status === "answered" ? "success" : "info",
        text: logText,
      },
      ...current,
    ]);
    setMessages((current) => [
      ...current,
      makeMessage("assistant", logText, {
        path: "hcm-real",
        latency: result.latencyMs,
        planId: result.commandId,
      }),
    ]);
    refreshHcmHome();
    refreshIntelligence();
  }

  function applyPlan(plan, latency = 0) {
    const executed = executePlan(plan, devices);
    setDevices(executed.devices);
    setLogs((current) => [executed.log, ...current].slice(0, 40));
    setMessages((current) => [
      ...current,
      makeMessage("assistant", plan.steps.length > 0 ? executed.log.text : plan.summary, {
        path: plan.path,
        latency,
        planId: plan.id,
      }),
    ]);
  }

  function confirmPending() {
    if (!pendingPlan) return;
    const started = performance.now();
    const executed = executePlan(pendingPlan, devices);
    const latency = Math.round(performance.now() - started);
    setDevices(executed.devices);
    setLogs((current) => [
      {
        ...executed.log,
        level: "success",
        text: `用户确认后执行：${executed.log.text}`,
      },
      ...current,
    ]);
    setMessages((current) => [
      ...current,
      makeMessage("assistant", `已确认并执行。\n${executed.log.text}`, {
        path: pendingPlan.path,
        latency,
        planId: pendingPlan.id,
      }),
    ]);
    setPendingPlan(null);
  }

  function cancelPending() {
    if (!pendingPlan) return;
    setLogs((current) => [
      {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
        level: "cancel",
        text: `已取消计划「${pendingPlan.intent}」。`,
      },
      ...current,
    ]);
    setMessages((current) => [...current, makeMessage("assistant", "已取消这次计划。")]);
    setPendingPlan(null);
  }

  function resetDemo() {
    setDevices(structuredClone(initialDevices));
    setPendingPlan(null);
    setLastPlan(null);
    setLogs(createInitialLog());
    setMessages([
      makeMessage("assistant", "Harness House 本地模拟器已重置。", {
        path: "system",
        latency: 0,
      }),
    ]);
  }

  const handleSelectRoom = useCallback((roomId) => {
    setSelectedRoomId(roomId);
  }, []);

  const handleViewChange = useCallback((view) => {
    setActiveView(view);
    if (typeof window !== "undefined") {
      window.location.hash =
        view === APP_VIEWS.MAP_EDITOR ? "map-editor" : view === APP_VIEWS.HOME_MODEL ? "home-model" : "";
    }
  }, []);

  function toggleListening() {
    if (!speechInput.supported || processing) return;
    if (speechState.listening) {
      speechInput.stop();
      setSpeechState((current) => ({ ...current, listening: false }));
      return;
    }
    speechOutput.stop();
    setSpeechState((current) => ({ ...current, speaking: false, listening: true, error: null, confidence: 0 }));
    speechInput.start({
      onResult: (result) => {
        const assessment = assessSpeechTranscript(result);
        setInput(assessment.transcript);
        setSpeechState((current) => ({
          ...current,
          confidence: assessment.confidence,
          error: assessment.code === "low_confidence" ? "转写置信度较低，请确认文字后再发送" : null,
        }));
        if (assessment.ok) {
          speechInput.stop();
          setSpeechState((current) => ({ ...current, listening: false }));
          window.setTimeout(() => submitCommand(assessment.transcript, { source: "voice" }), 180);
        }
      },
      onError: (error) => setSpeechState((current) => ({ ...current, listening: false, error: error.message })),
      onEnd: () => setSpeechState((current) => ({ ...current, listening: false })),
    });
  }

  function toggleTts() {
    setSpeechState((current) => {
      const enabled = !current.ttsEnabled;
      if (!enabled) speechOutput.stop();
      return { ...current, ttsEnabled: enabled, speaking: enabled ? current.speaking : false };
    });
  }

  if (activeView === APP_VIEWS.MAP_EDITOR) {
    return (
      <main className="app map-editor-app">
        <MapEditorWorkspace
          model={spatialEditorModel}
          state={spatialEditorState}
          syncStatus={spatialSyncStatus}
          selectedRoomId={selectedRoomId}
          hcmStatus={hcmStatus}
          onStateChange={setSpatialEditorState}
          onSelectRoom={setSelectedRoomId}
          onBack={() => handleViewChange(APP_VIEWS.CONTROL)}
          onRefresh={refreshHcmHome}
        />
      </main>
    );
  }

  if (activeView === APP_VIEWS.HOME_MODEL) {
    return (
      <main className="app model-manager-app">
        <HomeModelWorkspace
          home={hcmHome}
          onboarding={onboardingPlan}
          status={hcmStatus}
          onRefresh={refreshHcmHome}
          onBack={() => handleViewChange(APP_VIEWS.CONTROL)}
          onOpenMap={() => handleViewChange(APP_VIEWS.MAP_EDITOR)}
          onApplyDefaultRun={applyDefaultRun}
          onHideThing={hideHcmThing}
          onRecordOnboardingBaseline={recordOnboardingBaseline}
          reviewActionId={reviewActionId}
          onboardingActionId={onboardingActionId}
          defaultRunSummary={defaultRunSummary}
        />
      </main>
    );
  }

  return (
    <main className="app control-app">
      <Header
        currentRoomId={currentRoomId}
        activeCount={activeDevices.length}
        llmStatus={llmStatus}
        runtimeStatus={runtimeStatus}
        sceneRooms={houseSceneModel.rooms}
        activeView={activeView}
        onViewChange={handleViewChange}
      />

      <section className="scene-panel" aria-label="三维房屋模拟器">
        <div className="scene-panel-toolbar">
          <button
            type="button"
            className="scene-refresh-btn"
            onClick={refreshHcmHome}
            disabled={hcmStatus?.state === "loading"}
            title="刷新设备状态"
          >
            <RefreshCw size={14} className={hcmStatus?.state === "loading" ? "spinning" : ""} />
            {hcmStatus?.state === "loading" ? "同步中…" : "刷新"}
          </button>
        </div>
        <ThreeHouse
          devices={devices}
          sceneModel={houseSceneModel}
          selectedRoomId={selectedRoomId}
          onSelectRoom={handleSelectRoom}
        />
      </section>

      <aside className="left-rail control-rail home-rail" aria-label="房屋与设备">
        <RailHeader
          eyebrow="Home"
          title={selectedRoomName}
          meta={`${selectedRoomName} · ${selectedRoomDevices.length} 个设备 · ${activeDevices.length} 个活跃`}
          icon={Home}
        />
        <RoomSelector rooms={houseSceneModel.rooms} selectedRoomId={selectedRoomId} onSelect={setSelectedRoomId} />
        <DeviceList
          devices={selectedRoomDevices}
          selectedDeviceId={selectedDeviceId}
          onSelectDevice={setSelectedDeviceId}
        />
        <DeviceCapabilityPanel
          device={selectedDevice}
          capabilityOverrides={capabilityOverrides}
          onToggleCapability={toggleCapability}
        />
        <SystemMetrics sceneModel={houseSceneModel} fallbackDevices={devices} />
      </aside>

      <aside className="right-rail control-rail ai-rail" aria-label="AI 对话与执行">
        <RailHeader
          eyebrow="Runtime"
          title="意图与执行"
          meta="Hermes · glm-5.2"
          icon={Bot}
        />
        <CommandConsole
          input={input}
          setInput={setInput}
          inputRef={inputRef}
          messages={messages}
          processing={processing}
          onSubmit={submitCommand}
          speechState={speechState}
          speechSupported={speechInput.supported}
          ttsSupported={speechOutput.supported}
          onToggleListening={toggleListening}
          onToggleTts={toggleTts}
          executionControl={{
            preference: executionPreference,
            effectiveMode: effectiveCommandMode,
            realAvailable: realExecutionAvailable,
            backendMode: runtimeStatus?.execution?.mode ?? "unknown",
          }}
          onExecutionPreferenceChange={setExecutionPreference}
        />
        <PendingPlan plan={pendingPlan} onConfirm={confirmPending} onCancel={cancelPending} />
        <PlanPreview plan={lastPlan} />
        <IntelligencePanel
          audit={commandAudit}
          memory={learningMemory}
          agents={agentSnapshot}
          actionId={intelligenceActionId}
          onRefresh={refreshIntelligence}
          onReplay={replayAuditEntry}
          onIgnoreCandidate={ignoreLearningCandidate}
          onDeleteCandidate={deleteLearningCandidateFromMemory}
          liveRoomName={getSceneRoomName(liveCurrentRoomId, houseSceneModel.rooms)}
          liveOccupiedRooms={liveOccupiedRooms.map((id) => getSceneRoomName(id, houseSceneModel.rooms))}
        />
      </aside>

      <div className="bottom-bar">
        <div className="example-strip" aria-label="示例命令">
          {examples.map((example) => (
            <button
              className="example-chip"
              key={example}
              type="button"
              onClick={() => submitCommand(example)}
              disabled={processing}
            >
              <Play size={14} />
              <span>{example}</span>
            </button>
          ))}
        </div>
        <button className="icon-command" type="button" onClick={resetDemo} title="重置本地模拟">
          <RotateCcw size={18} />
        </button>
      </div>
    </main>
  );
}

function RailHeader({ eyebrow, title, meta, icon: Icon }) {
  return (
    <div className="rail-header">
      <div className="rail-header-icon">
        <Icon size={15} />
      </div>
      <div>
        <span>{eyebrow}</span>
        <strong>{title}</strong>
      </div>
      <small>{meta}</small>
    </div>
  );
}

function Header({ currentRoomId, activeCount, llmStatus, runtimeStatus, sceneRooms, activeView, onViewChange }) {
  const executionMode = runtimeStatus?.execution;
  const releaseStatus = runtimeStatus?.release?.status ?? "unknown";
  const releaseLabel = formatReleaseStatus(releaseStatus);
  return (
    <header className="product-header">
      <div className="mark">
        <Home size={22} />
      </div>
      <div>
        <h1>Harness House</h1>
        <p>Local AI Home Runtime</p>
      </div>
      <div className={`status-pill execution-${executionMode?.mode ?? "unknown"}`}>
        <span className="live-dot" />
        {executionMode?.mode === "real" ? "Real" : "Dry-run"}
      </div>
      <div className="view-switch" role="group" aria-label="工作区">
        <button
          className={activeView === APP_VIEWS.CONTROL ? "selected" : ""}
          type="button"
          onClick={() => onViewChange(APP_VIEWS.CONTROL)}
          title="控制台"
        >
          <Home size={13} />
          控制
        </button>
        <button
          className={activeView === APP_VIEWS.HOME_MODEL ? "selected" : ""}
          type="button"
          onClick={() => onViewChange(APP_VIEWS.HOME_MODEL)}
          title="家庭语义模型"
        >
          <Network size={13} />
          模型
        </button>
        <button
          className={activeView === APP_VIEWS.MAP_EDITOR ? "selected" : ""}
          type="button"
          onClick={() => onViewChange(APP_VIEWS.MAP_EDITOR)}
          title="房屋结构编辑"
        >
          <MapIcon size={13} />
          地图
        </button>
      </div>
      <div className="header-facts">
        <Fact icon={Layers3} label="当前区域" value={getSceneRoomName(currentRoomId, sceneRooms)} />
        <Fact icon={Power} label="活跃设备" value={`${activeCount}`} />
        <Fact
          icon={Sparkles}
          label="控制大脑"
          value="Hermes · glm-5.2"
        />
        <Fact
          icon={ShieldCheck}
          label="发布门"
          value={releaseLabel}
        />
      </div>
    </header>
  );
}

function formatReleaseStatus(status) {
  if (status === "ready") return "可发布";
  if (status === "ready_with_warnings") return "有注意项";
  if (status === "blocked") return "已阻塞";
  return "检查中";
}

function formatSpatialSyncStatus(syncStatus) {
  if (syncStatus?.state === "saving") return "正在保存到本地服务";
  if (syncStatus?.state === "synced") return "已保存到本地服务，跨浏览器生效";
  if (syncStatus?.state === "error") return "保存到服务失败，仅本浏览器缓存";
  return "正在同步空间配置";
}

function RuntimeGuardPanel({ runtimeStatus }) {
  if (!runtimeStatus) {
    return (
      <section className="panel runtime-panel">
        <div className="panel-title">
          <ShieldCheck size={17} />
          <h2>Runtime Gate</h2>
        </div>
        <p className="hcm-note">正在读取运行安全状态...</p>
      </section>
    );
  }
  const execution = runtimeStatus.execution;
  const release = runtimeStatus.release;
  const checks = runtimeStatus.checks ?? [];
  const releaseLabel = formatReleaseStatus(release.status);
  return (
    <section className={`panel runtime-panel mode-${execution.mode}`}>
      <div className="panel-title">
        <ShieldCheck size={17} />
        <h2>Runtime Gate</h2>
        <span className={`runtime-status-badge status-${release.status}`}>{releaseLabel}</span>
      </div>
      <div className="runtime-mode">
        <strong>{execution.label}</strong>
        <span>{execution.description}</span>
      </div>
      <div className="runtime-checks">
        {checks.slice(0, 5).map((item) => (
          <div className={`runtime-check status-${item.status}`} key={item.id}>
            <span>{item.label}</span>
            <strong>{item.status === "pass" ? "通过" : item.status === "warning" ? "注意" : "阻塞"}</strong>
            <small>{item.message}</small>
          </div>
        ))}
      </div>
      {execution.mode !== "real" && <p className="runtime-hint">{execution.enableHint}</p>}
    </section>
  );
}

function MapEditorWorkspace({ model, state, syncStatus, selectedRoomId, hcmStatus, onStateChange, onSelectRoom, onBack, onRefresh }) {
  const editedRoomCount = model.rooms.filter((room) => room.spatialSource === "editor").length;
  return (
    <section className="map-workspace-shell">
      <header className="map-workspace-header">
        <div>
          <div className="map-workspace-title">
            <MapIcon size={20} />
            <h1>房屋结构管理</h1>
          </div>
          <p>参考图只做底图；绿色房间框和设备点才是会保存、会应用到控制台的生效户型结构。</p>
        </div>
        <div className="map-workspace-actions">
          <button type="button" onClick={onRefresh} title="刷新 HA 家庭模型">
            <RefreshCw size={14} />
            刷新设备
          </button>
          <button type="button" onClick={onBack} title="返回控制台">
            <Home size={14} />
            控制台
          </button>
        </div>
      </header>
      <div className="map-workspace-status">
        <span>参考底图：{state.floorPlanImageName || "未上传"}</span>
        <span>
          {state.floorPlanCoordinateMode === "image" && state.floorPlanImageAspectRatio ? "底图比例已锁定" : "正在校准底图比例"}
        </span>
        <span>生效结构：{model.rooms.length} 房间，{editedRoomCount} 个已校准</span>
        <strong>{formatSpatialSyncStatus(syncStatus)}</strong>
      </div>
      {hcmStatus?.error && <div className="map-workspace-error">{hcmStatus.error}</div>}
      <SpatialHomeEditor
        model={model}
        state={state}
        selectedRoomId={selectedRoomId}
        onStateChange={onStateChange}
        onSelectRoom={onSelectRoom}
        workspace
      />
    </section>
  );
}

function Fact({ icon: Icon, label, value }) {
  return (
    <div className="fact">
      <Icon size={16} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SystemMetrics({ sceneModel, fallbackDevices }) {
  const devices = useMemo(() => {
    if (sceneModel?.devices?.length > 0) return sceneModel.devices;
    return Object.values(fallbackDevices ?? {});
  }, [fallbackDevices, sceneModel?.devices]);
  const rooms = sceneModel?.rooms ?? [];
  const summary = useMemo(
    () => (sceneModel?.source === "hcm" ? summarizeSceneHome(devices, rooms) : summarizeHome(fallbackDevices)),
    [devices, fallbackDevices, rooms, sceneModel?.source],
  );
  const gasHeater = findSceneDevice(devices, ["gas_heater", "water_heater"], /燃气|热水器/);
  const feeder = findSceneDevice(devices, ["pet_feeder"], /猫粮|投喂|feeder/);
  const robot = findSceneDevice(devices, ["robot_vacuum"], /扫地|机器人|vacuum/);
  const frontDoor = findSceneDevice(devices, ["door_sensor"]);

  return (
    <section className="panel compact-panel">
      <div className="panel-title">
        <Activity size={17} />
        <h2>House State</h2>
      </div>
      <p className="state-summary">{summary}</p>
      <div className="metric-grid">
        <Metric label="燃气热水器" value={sceneDeviceStateLabel(gasHeater)} tone={gasHeater?.on ? "danger" : "muted"} />
        <Metric label="猫粮机" value={sceneDeviceStateLabel(feeder)} />
        <Metric label="扫地机器人" value={sceneDeviceStateLabel(robot)} tone={robot?.status === "error" ? "danger" : "normal"} />
        <Metric label="前门" value={sceneDeviceStateLabel(frontDoor)} />
      </div>
    </section>
  );
}

function summarizeSceneHome(devices = [], rooms = []) {
  const activeLights = devices.filter((device) => device.type === "light" && isActiveHomeDevice(device)).length;
  const activeAc = devices.filter((device) => device.type === "ac" && isActiveHomeDevice(device)).length;
  const activeFans = devices.filter((device) => device.type === "fan" && isActiveHomeDevice(device)).length;
  const occupiedRooms = rooms.filter((room) => room.presence).map((room) => room.name);
  const frontDoor = findSceneDevice(devices, ["door_sensor"], /入户|大门|门窗|front.*door/);
  return [
    `当前 ${activeLights} 盏灯开启`,
    `${activeAc} 台空调开启`,
    `${activeFans} 台风扇开启`,
    `人在区域：${occupiedRooms.length ? occupiedRooms.join("、") : "未知"}`,
    `入户门${frontDoor ? sceneDeviceStateLabel(frontDoor) : "未接入"}`,
  ].join("；") + "。";
}

function findSceneDevice(devices = [], types = [], namePattern = null) {
  const typeSet = new Set(types);
  const typeMatch = devices.find((device) => typeSet.has(device.type));
  if (typeMatch) return typeMatch;
  if (!namePattern) return null;
  return devices.find((device) => {
    const name = `${device.name ?? ""} ${device.id ?? ""}`.toLowerCase();
    return namePattern.test(name);
  });
}

function sceneDeviceStateLabel(device) {
  if (!device) return "未接入";
  if (device.online === false) return "离线";
  if (device.type === "pet_feeder" && device.portionsToday !== undefined) return `${device.portionsToday} 份`;
  if (device.type === "pet_feeder" && isCapabilityCountLabel(device.statusLabel)) return "已接入";
  if (device.statusLabel) return device.statusLabel;
  return deviceStateLabel(device);
}

function isCapabilityCountLabel(label) {
  return /^(可自动|自动|需确认|只读|protected)/.test(String(label ?? ""));
}

function Metric({ label, value, tone = "normal" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HomeModelWorkspace({
  home,
  onboarding,
  status,
  onRefresh,
  onBack,
  onOpenMap,
  onApplyDefaultRun,
  onHideThing,
  onRecordOnboardingBaseline,
  reviewActionId,
  onboardingActionId,
  defaultRunSummary,
}) {
  const [selectedThingId, setSelectedThingId] = useState(null);
  const [draft, setDraft] = useState({ name: "", spaceId: "", aliases: "" });
  const [savingThingId, setSavingThingId] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const selectedThing = useMemo(
    () => home?.things?.find((thing) => thing.id === selectedThingId) ?? home?.things?.[0] ?? null,
    [home, selectedThingId],
  );
  const roomNameById = useMemo(
    () => new Map((home?.spaces ?? []).map((space) => [space.id, space.name])),
    [home],
  );
  const roomSummaries = useMemo(() => {
    if (!home) return [];
    const counts = new Map((home.spaces ?? []).map((space) => [space.id, { ...space, count: 0, auto: 0 }]));
    for (const thing of home.things ?? []) {
      const current = counts.get(thing.spaceId) ?? { id: thing.spaceId, name: thing.spaceId || "未分区", count: 0, auto: 0 };
      current.count += 1;
      current.auto += thing.state?.autoExecutable ?? 0;
      counts.set(thing.spaceId, current);
    }
    return Array.from(counts.values())
      .filter((room) => room.count > 0)
      .sort((first, second) => second.count - first.count);
  }, [home]);
  const groupedThings = useMemo(() => {
    if (!home) return [];
    return [...home.things]
      .sort((first, second) => {
        const roomDelta = String(roomNameById.get(first.spaceId) ?? first.spaceId).localeCompare(
          String(roomNameById.get(second.spaceId) ?? second.spaceId),
          "zh-CN",
        );
        if (roomDelta !== 0) return roomDelta;
        return first.name.localeCompare(second.name, "zh-CN");
      });
  }, [home, roomNameById]);
  const defaultPolicy = defaultRunSummary ?? home?.defaultPolicy;

  useEffect(() => {
    if (!selectedThing) return;
    setDraft({
      name: selectedThing.name ?? "",
      spaceId: selectedThing.spaceId ?? "",
      aliases: (selectedThing.aliases ?? []).join("、"),
    });
    setSaveError(null);
  }, [selectedThing?.id]);

  async function saveThingOverlay() {
    if (!selectedThing || savingThingId) return;
    setSavingThingId(selectedThing.id);
    setSaveError(null);
    try {
      await updateHcmThingOverride({
        providerId: home?.provider?.id,
        thingId: selectedThing.id,
        patch: {
          name: draft.name,
          spaceId: draft.spaceId,
          aliases: draft.aliases
            .split(/[、,，\s]+/)
            .map((item) => item.trim())
            .filter(Boolean),
        },
      });
      await onRefresh();
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSavingThingId(null);
    }
  }

  return (
    <section className="model-workspace-shell">
      <header className="model-workspace-header">
        <div>
          <span>Home Model</span>
          <h1>家庭语义模型管理</h1>
          <p>管理房间、设备、别名、能力边界和接入建议；这里修改的是 Harness 本地语义层，不直接改 HA。</p>
        </div>
        <div className="model-workspace-actions">
          <button type="button" onClick={onRefresh}>
            <RefreshCw size={14} />
            同步
          </button>
          <button type="button" onClick={onOpenMap}>
            <MapIcon size={14} />
            户型
          </button>
          <button type="button" onClick={onBack}>
            <Home size={14} />
            控制台
          </button>
        </div>
      </header>

      {status.state === "loading" && <p className="hcm-note">正在同步真实设备能力...</p>}
      {status.state === "error" && <p className="hcm-error">{status.error}</p>}

      {home && (
        <div className="model-workspace-grid">
          <section className="model-section model-overview">
            <div className="model-section-title">
              <span>Overview</span>
              <strong>{home.stats.thingCount} 设备</strong>
            </div>
            <div className="model-overview-grid">
              <Metric label="房间" value={`${roomSummaries.length}`} />
              <Metric label="逻辑设备" value={`${home.controlGraph?.stats?.assetCount ?? 0}`} />
              <Metric label="可自动" value={`${home.stats.autoExecutableCapabilities}`} />
              <Metric label="待处理" value={`${home.capabilitySummary?.reviewSurfaceCount ?? 0}`} tone="danger" />
            </div>
            {defaultPolicy?.enabled && (
              <div className="default-run-summary">
                默认开放 <strong>{defaultPolicy.allowed}</strong>
                <span>保护 {defaultPolicy.protected}</span>
              </div>
            )}
          </section>

          <section className="model-section model-room-section">
            <div className="model-section-title">
              <span>Rooms</span>
              <strong>{roomSummaries.length}</strong>
            </div>
            <div className="model-room-list">
              {roomSummaries.map((room) => (
                <button
                  type="button"
                  key={room.id}
                  onClick={() => {
                    const firstThing = groupedThings.find((thing) => thing.spaceId === room.id);
                    if (firstThing) setSelectedThingId(firstThing.id);
                  }}
                >
                  <span>{room.name}</span>
                  <strong>{room.count}</strong>
                  <small>可自动 {room.auto}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="model-section model-device-section">
            <div className="model-section-title">
              <span>Devices</span>
              <strong>{groupedThings.length}</strong>
            </div>
            <div className="model-device-list">
              {groupedThings.map((thing) => (
                <button
                  className={thing.id === selectedThing?.id ? "selected" : ""}
                  type="button"
                  key={thing.id}
                  onClick={() => setSelectedThingId(thing.id)}
                >
                  <span>{roomNameById.get(thing.spaceId) ?? thing.spaceId ?? "未分区"}</span>
                  <strong>{thing.name}</strong>
                  <small>{thing.boundary?.label ?? thingStateBadge(thing)}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="model-section model-detail-section">
            <div className="model-section-title">
              <span>Device Detail</span>
              <strong>{selectedThing?.type ?? "未选择"}</strong>
            </div>
            {selectedThing ? (
              <div className="model-detail-form">
                {/* ── 编辑区 ── */}
                <div className="detail-edit-group">
                  <label>
                    <span>显示名称</span>
                    <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
                  </label>
                  <label>
                    <span>房间</span>
                    <select value={draft.spaceId} onChange={(event) => setDraft((current) => ({ ...current, spaceId: event.target.value }))}>
                      <option value="">未分区</option>
                      {(home.spaces ?? []).map((space) => (
                        <option value={space.id} key={space.id}>
                          {space.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>别名</span>
                    <input
                      value={draft.aliases}
                      onChange={(event) => setDraft((current) => ({ ...current, aliases: event.target.value }))}
                      placeholder="用顿号或逗号分隔"
                    />
                  </label>
                </div>

                {/* ── 设备来源信息 ── */}
                <div className="detail-source-info">
                  <div className="detail-source-row">
                    <span className="detail-label">来源</span>
                    <span className="detail-value">{selectedThing.provider?.name ?? selectedThing.provider?.id ?? "未知"}</span>
                  </div>
                  <div className="detail-source-row">
                    <span className="detail-label">设备ID</span>
                    <span className="detail-value mono">{selectedThing.id}</span>
                  </div>
                  <div className="detail-source-row">
                    <span className="detail-label">类型</span>
                    <span className="detail-value">{selectedThing.type}</span>
                  </div>
                  <div className="detail-source-row">
                    <span className="detail-label">在线状态</span>
                    <span className={`detail-value ${selectedThing.online === false ? "offline" : "online"}`}>
                      {selectedThing.online === false ? "离线" : "在线"}
                    </span>
                  </div>
                  <div className="detail-source-row">
                    <span className="detail-label">整体风险</span>
                    <span className={`detail-value risk-badge risk-${selectedThing.policy?.risk ?? "low"}`}>
                      {RISK_LABELS[selectedThing.policy?.risk ?? "low"] ?? selectedThing.policy?.risk}
                    </span>
                  </div>
                  {selectedThing.policy?.reason && (
                    <div className="detail-source-row">
                      <span className="detail-label">风险原因</span>
                      <span className="detail-value">{selectedThing.policy.reason}</span>
                    </div>
                  )}
                </div>

                {/* ── 能力列表 ── */}
                <div className="detail-capability-section">
                  <div className="detail-section-header">
                    <span>能力清单</span>
                    <strong>{selectedThing.capabilities?.length ?? 0} 项</strong>
                  </div>
                  <div className="detail-capability-list">
                    {(selectedThing.capabilities ?? []).map((cap) => {
                      const isBound = Boolean(cap.binding?.entityId);
                      const hasOverlay = Boolean(cap.policy?.overlayDecision);
                      return (
                        <div key={cap.id ?? cap.name} className={`detail-cap-row risk-${cap.policy?.risk ?? "low"} ${hasOverlay ? "has-overlay" : ""}`}>
                          <div className="detail-cap-header">
                            <span className="detail-cap-name">{cap.name}</span>
                            <span className={`detail-cap-risk risk-mini risk-${cap.policy?.risk ?? "low"}`}>
                              {RISK_LABELS[cap.policy?.risk ?? "low"] ?? cap.policy?.risk}
                            </span>
                          </div>
                          <div className="detail-cap-meta">
                            <span>{cap.kind ?? "unknown"}</span>
                            <span className={`policy-tag ${cap.policy?.autoExecutable ? "auto" : cap.policy?.confirmation === "always" ? "protected" : "review"}`}>
                              {cap.policy?.autoExecutable ? "可自动" : cap.policy?.confirmation === "always" ? "已保护" : "需审核"}
                            </span>
                            {isBound ? (
                              <span className="binding-info" title={cap.binding.entityId}>
                                {cap.binding.domain ?? ""} · {cap.binding.entityId ?? ""}
                              </span>
                            ) : (
                              <span className="binding-info unbound">未绑定</span>
                            )}
                          </div>
                          {hasOverlay && (
                            <div className="detail-cap-overlay">
                              <span>手动覆盖: {cap.policy.overlayDecision}</span>
                              {cap.policy.overlayUpdatedAt && <small>{new Date(cap.policy.overlayUpdatedAt).toLocaleString("zh-CN")}</small>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* ── 保存 ── */}
                {saveError && <p className="hcm-error">{saveError}</p>}
                <button className="model-save-button" type="button" disabled={Boolean(savingThingId)} onClick={saveThingOverlay}>
                  <Check size={14} />
                  保存本地语义
                </button>
              </div>
            ) : (
              <p className="hcm-note">暂无设备。</p>
            )}
          </section>

          <section className="model-section model-boundary-section">
            <CapabilityBoundarySummary summary={home.capabilitySummary} />
            <ControlGraphSummary graph={home.controlGraph} />
            <BindingReview
              review={home.review}
              reviewSurfaceCount={home.capabilitySummary?.reviewSurfaceCount}
              hiddenThingIds={home.overlay?.reviewHiddenThingIds}
              onHideThing={onHideThing}
              actionId={reviewActionId}
              things={home.things}
              roomNameById={roomNameById}
              onSelectThing={setSelectedThingId}
            />
          </section>

          <section className="model-section model-onboarding-section">
            <div className="model-section-title">
              <span>Onboarding</span>
              <strong>{onboarding?.plan?.summary?.candidateCount ?? 0}</strong>
            </div>
            <button className="model-open-button" type="button" onClick={onApplyDefaultRun} disabled={Boolean(reviewActionId)}>
              <Play size={14} />
              应用默认安全策略
            </button>
            <OnboardingPanel
              onboarding={onboarding}
              actionId={onboardingActionId}
              onRecordBaseline={onRecordOnboardingBaseline}
            />
          </section>
        </div>
      )}
    </section>
  );
}

function HcmCatalog({
  home,
  status,
  onRefresh,
  onApplyDefaultRun,
  onOpenModel,
  reviewActionId,
  defaultRunSummary,
}) {
  const areaCounts = useMemo(() => {
    if (!home) return [];
    const spaces = new Map(home.spaces.map((space) => [space.id, space.name]));
    const counts = {};
    for (const thing of home.things) {
      const name = spaces.get(thing.spaceId) || thing.spaceId;
      counts[name] = (counts[name] || 0) + 1;
    }
    return Object.entries(counts).sort(([, a], [, b]) => b - a);
  }, [home]);

  const visibleThings = useMemo(() => {
    if (!home) return [];
    return [...home.things]
      .sort((a, b) => (b.state.autoExecutable ?? 0) - (a.state.autoExecutable ?? 0))
      .slice(0, 6);
  }, [home]);
  const defaultPolicy = defaultRunSummary ?? home?.defaultPolicy;
  const issueCount = home?.capabilitySummary?.reviewSurfaceCount ?? home?.review?.recommendations?.totalDevices ?? 0;

  return (
    <section className="panel hcm-panel">
      <div className="panel-title">
        <Network size={17} />
        <h2>Home Model</h2>
        <button className="mini-icon-button" type="button" onClick={onRefresh} title="同步真实设备">
          <RefreshCw size={14} />
        </button>
        <button
          className="mini-icon-button"
          type="button"
          onClick={onApplyDefaultRun}
          disabled={Boolean(reviewActionId)}
          title="默认开放可执行能力"
        >
          <Play size={14} />
        </button>
      </div>

      {status.state === "loading" && <p className="hcm-note">正在同步真实设备能力...</p>}
      {status.state === "error" && <p className="hcm-error">{status.error}</p>}
      {home && (
        <>
          <div className="home-model-brief">
            <div>
              <strong>{home.stats.thingCount}</strong>
              <span>真实设备</span>
            </div>
            <div>
              <strong>{home.controlGraph?.stats?.assetCount ?? 0}</strong>
              <span>逻辑设备</span>
            </div>
            <div className={issueCount > 0 ? "attention" : ""}>
              <strong>{issueCount}</strong>
              <span>待处理</span>
            </div>
          </div>
          <div className="hcm-area-strip">
            {areaCounts.slice(0, 6).map(([area, count]) => (
              <span key={area}>
                {area} <strong>{count}</strong>
              </span>
            ))}
          </div>
          {home.overlay?.bindingOverrideCount > 0 && (
            <div className="overlay-summary">
              已审核 <strong>{home.overlay.bindingOverrideCount}</strong>
              {home.overlay.reviewHiddenThingCount > 0 && <span>隐藏建议 {home.overlay.reviewHiddenThingCount}</span>}
              {home.overlay.disabledThingCount > 0 && <span>禁用 {home.overlay.disabledThingCount}</span>}
            </div>
          )}
          {defaultPolicy?.enabled && (
            <div className="default-run-summary">
              默认开放 <strong>{defaultPolicy.allowed}</strong>
              <span>保护 {defaultPolicy.protected}</span>
            </div>
          )}
          <button className="model-open-button" type="button" onClick={onOpenModel}>
            <Network size={14} />
            管理家庭模型
          </button>
          <div className="hcm-thing-list">
            {visibleThings.map((thing) => (
              <div className={`hcm-thing risk-${thing.policy.risk}`} key={thing.id}>
                <span>{thing.type}</span>
                <strong>{thing.name}</strong>
                <small>
                  {thing.boundary?.label ?? thingStateBadge(thing)}
                </small>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ControlGraphSummary({ graph }) {
  if (!graph) return null;
  const stats = graph.stats ?? {};
  const candidates = graph.candidates ?? [];
  return (
    <div className="control-graph-summary">
      <div className="control-graph-header">
        <span>Control Graph</span>
        <strong>{stats.assetCount ?? 0} 个逻辑设备</strong>
      </div>
      <div className="control-graph-metrics">
        <span>面板 <strong>{stats.controllerCount ?? 0}</strong></span>
        <span>通道 <strong>{stats.endpointCount ?? 0}</strong></span>
        <span>已映射 <strong>{stats.boundCount ?? 0}</strong></span>
        <span>待确认 <strong>{(stats.reviewCount ?? 0) + (stats.unboundCount ?? 0)}</strong></span>
      </div>
      {candidates.length > 0 && (
        <div className="control-graph-candidates">
          {candidates.slice(0, 3).map((candidate) => (
            <div key={candidate.id}>
              <strong>{candidate.controllerName} · {channelName(candidate.channel)}</strong>
              <span>{candidate.suggestedAssetName || "未绑定设备"}</span>
              <small>{candidate.reason}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function channelName(channel) {
  if (channel === "left") return "左键";
  if (channel === "middle") return "中键";
  if (channel === "right") return "右键";
  return channel === "unknown" ? "未知通道" : channel;
}

function OnboardingPanel({ onboarding, actionId, onRecordBaseline }) {
  const plan = onboarding?.plan;
  if (!plan) return null;
  const candidates = plan.candidates ?? [];
  return (
    <div className="onboarding-panel">
      <div className="onboarding-header">
        <span>Onboarding</span>
        <strong>{plan.summary?.candidateCount ?? 0}</strong>
        <button type="button" disabled={Boolean(actionId)} onClick={onRecordBaseline} title="记录当前 HA 快照为接入基线">
          baseline
        </button>
      </div>
      <div className="onboarding-metrics">
        <span>
          auto <strong>{plan.summary?.allowAutoCandidates ?? 0}</strong>
        </span>
        <span>
          review <strong>{plan.summary?.reviewCount ?? 0}</strong>
        </span>
        <span>
          protect <strong>{plan.summary?.protectCount ?? 0}</strong>
        </span>
      </div>
      <small>{onboarding.hasBaseline ? "基于 provider diff" : "尚未记录 baseline，当前设备作为初始候选"}</small>
      <div className="onboarding-list">
        {candidates.slice(0, 3).map((candidate) => (
          <div className={`onboarding-item action-${candidate.proposedAction}`} key={candidate.id}>
            <span>{candidate.proposedAction}</span>
            <strong>{candidate.thingName}</strong>
            <small>{candidate.reason}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function CapabilityBoundarySummary({ summary }) {
  if (!summary) return null;
  const totals = summary.totals ?? {};
  const deviceStates = summary.deviceStates ?? {};
  return (
    <div className="capability-boundary-summary">
      <div className="boundary-header">
        <span>能力边界</span>
        <strong>{summary.reviewSurfaceCount ?? 0}</strong>
      </div>
      <div className="boundary-grid">
        <span>
          可自动 <strong>{totals.executable ?? 0}</strong>
        </span>
        <span>
          需确认 <strong>{totals.confirmable ?? 0}</strong>
        </span>
        <span>
          只读 <strong>{totals.readOnly ?? 0}</strong>
        </span>
        <span>
          保护 <strong>{(totals.protected ?? 0) + (totals.config ?? 0)}</strong>
        </span>
      </div>
      <small>
        设备：自动 {deviceStates.executable ?? 0} · 确认 {deviceStates.confirmable ?? 0} · 保护{" "}
        {deviceStates.protected ?? 0} · 只读 {deviceStates.read_only ?? 0}
      </small>
    </div>
  );
}

function executableCapabilityCount(thing) {
  return (thing.capabilities ?? []).filter((capability) => capability.kind === "control" || capability.kind === "action")
    .length;
}

function thingStateBadge(thing) {
  const autoExecutable = thing.state?.autoExecutable ?? 0;
  const controllable = executableCapabilityCount(thing);
  const readable = thing.state?.readable ?? 0;
  if (autoExecutable > 0 && controllable > 0 && autoExecutable === controllable) return "可自动控制";
  if (autoExecutable > 0 && controllable > 0) return `自动 ${autoExecutable}/${controllable}`;
  if (autoExecutable > 0) return `可自动 ${autoExecutable} 项`;
  if (controllable > 0) return `需确认 ${controllable} 项`;
  if (readable > 0) return `只读 ${readable} 项`;
  return thing.online === false ? "离线" : "受保护";
}

function getMergedRectBorders(rect, allRects) {
  const tol = 0.5;
  const rectRight = rect.left + rect.width;
  const rectBottom = rect.top + rect.height;
  const hRange = (r) => [r.left, r.left + r.width];
  const vRange = (r) => [r.top, r.top + r.height];
  const rangesOverlap = (a, b, t = tol) => a[0] < b[1] - t && a[1] > b[0] + t;

  const hasNeighbor = (side) => allRects.some((other) => {
    if (other === rect) return false;
    const oRight = other.left + other.width;
    const oBottom = other.top + other.height;
    switch (side) {
      case "right":
        return Math.abs(rectRight - other.left) < tol && rangesOverlap(vRange(rect), vRange(other));
      case "left":
        return Math.abs(rect.left - oRight) < tol && rangesOverlap(vRange(rect), vRange(other));
      case "bottom":
        return Math.abs(rectBottom - other.top) < tol && rangesOverlap(hRange(rect), hRange(other));
      case "top":
        return Math.abs(rect.top - oBottom) < tol && rangesOverlap(hRange(rect), hRange(other));
      default:
        return false;
    }
  });

  return {
    right: !hasNeighbor("right"),
    left: !hasNeighbor("left"),
    bottom: !hasNeighbor("bottom"),
    top: !hasNeighbor("top"),
  };
}

function SpatialHomeEditor({ model, state, selectedRoomId, onStateChange, onSelectRoom, workspace = false }) {
  const mapRef = useRef(null);
  const fileInputRef = useRef(null);
  const floorImageRef = useRef(null);
  const stateRef = useRef(state);
  const activeRoomEditRef = useRef(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [activeRoomEditKey, setActiveRoomEditKey] = useState(null);
  const [floorPlanDragActive, setFloorPlanDragActive] = useState(false);
  const [multiSelectIds, setMultiSelectIds] = useState([]);
  const selectedDevice = useMemo(
    () => (selectedDeviceId ? model.devices.find((device) => device.id === selectedDeviceId) ?? null : null),
    [model.devices, selectedDeviceId],
  );
  const selectedRoom = useMemo(
    () => model.rooms.find((room) => room.id === selectedRoomId) ?? null,
    [model.rooms, selectedRoomId],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (selectedDeviceId && !model.devices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(null);
    }
  }, [model.devices, selectedDeviceId]);

  const updateState = useCallback(
    (nextState) => {
      onStateChange(createSpatialEditorState(nextState));
    },
    [onStateChange],
  );

  useEffect(() => {
    const handlePointerMove = (event) => {
      const interaction = activeRoomEditRef.current;
      if (!interaction) return;
      event.preventDefault();
      const dx = ((event.clientX - interaction.clientX) / interaction.mapWidth) * 100;
      const dy = ((event.clientY - interaction.clientY) / interaction.mapHeight) * 100;
      if (interaction.groupRects && interaction.groupRects.length > 1) {
        const updates = interaction.mode === "resize"
          ? interaction.groupRects.map((entry) => ({
              roomId: entry.roomId,
              rect: clampRoomRectForMap({
                ...entry.rect,
                width: entry.rect.width + dx,
                height: entry.rect.height + dy,
              }),
            }))
          : interaction.groupRects.map((entry) => ({
              roomId: entry.roomId,
              rect: clampRoomRectForMap({
                ...entry.rect,
                left: entry.rect.left + dx,
                top: entry.rect.top + dy,
              }),
            }));
        updateState(updateSpatialRoomRects(stateRef.current, updates));
      } else {
        const start = interaction.rect;
        const nextRect =
          interaction.mode === "resize"
            ? clampRoomRectForMap({
                ...start,
                width: start.width + dx,
                height: start.height + dy,
              })
            : clampRoomRectForMap({
                ...start,
                left: start.left + dx,
                top: start.top + dy,
              });
        updateState(updateSpatialRoomRect(stateRef.current, interaction.roomId, nextRect));
      }
    };
    const handlePointerUp = () => {
      activeRoomEditRef.current = null;
      setActiveRoomEditKey(null);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [updateState]);

  const readFloorPlanFile = useCallback(
    (file) => {
      if (!isImageFile(file)) return;
      const reader = new FileReader();
      reader.onload = () => {
        const floorPlanImage = reader.result;
        const nextState = {
          ...state,
          floorPlanImage,
          floorPlanImageName: file.name,
          floorPlanImageSize: file.size,
          floorPlanCoordinateMode: "image",
          floorPlanImageUpdatedAt: new Date().toISOString(),
        };
        const image = new Image();
        image.onload = () => {
          updateState({
            ...nextState,
            floorPlanImageAspectRatio: image.naturalWidth / image.naturalHeight,
          });
        };
        image.onerror = () => updateState(nextState);
        image.src = floorPlanImage;
      };
      reader.readAsDataURL(file);
    },
    [state, updateState],
  );

  const handleFloorPlanUpload = useCallback(
    (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      readFloorPlanFile(file);
      event.target.value = "";
    },
    [readFloorPlanFile],
  );

  const applyFloorImageMetrics = useCallback(
    (image) => {
      const aspectRatio = image.naturalWidth / image.naturalHeight;
      if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
      if (state.floorPlanCoordinateMode !== "image") {
        const mapRect = mapRef.current?.getBoundingClientRect();
        updateState(migrateSpatialEditorStateToImageCoordinates(state, {
          containerWidth: mapRect?.width,
          containerHeight: mapRect?.height,
          imageAspectRatio: aspectRatio,
        }));
        return;
      }
      if (Math.abs((state.floorPlanImageAspectRatio ?? 0) - aspectRatio) < 0.0001) return;
      updateState({
        ...state,
        floorPlanImageAspectRatio: aspectRatio,
      });
    },
    [state, updateState],
  );

  const handleFloorImageLoad = useCallback(
    (event) => {
      applyFloorImageMetrics(event.currentTarget);
    },
    [applyFloorImageMetrics],
  );

  useEffect(() => {
    const image = floorImageRef.current;
    if (!state.floorPlanImage || !image?.complete) return;
    applyFloorImageMetrics(image);
  }, [
    applyFloorImageMetrics,
    state.floorPlanCoordinateMode,
    state.floorPlanImage,
    state.floorPlanImageAspectRatio,
  ]);

  const handleAddRoom = useCallback(() => {
    const nextIndex = state.customRooms.length + 1;
    const nextState = addSpatialRoom(state, {
      id: `custom_room_${Date.now().toString(36)}`,
      name: `新房间${nextIndex}`,
      mapRect: { left: 38 + ((nextIndex - 1) % 4) * 4, top: 34 + ((nextIndex - 1) % 4) * 4, width: 18, height: 14 },
    });
    updateState(nextState);
    const room = nextState.customRooms[nextState.customRooms.length - 1];
    if (room?.id) onSelectRoom(room.id);
  }, [onSelectRoom, state, updateState]);

  const handleRemoveRoom = useCallback(
    (roomId) => {
      updateState(removeSpatialRoom(state, roomId));
      if (selectedRoomId === roomId) onSelectRoom(model.rooms[0]?.id ?? null);
    },
    [model.rooms, onSelectRoom, selectedRoomId, state, updateState],
  );

  const handleRoomRectInput = useCallback(
    (roomId, key, value) => {
      const room = model.rooms.find((item) => item.id === roomId);
      if (!room?.mapRect) return;
      updateState(updateSpatialRoomRect(state, roomId, { ...room.mapRect, [key]: Number(value) }));
    },
    [model.rooms, state, updateState],
  );

  const handleRoomPointerDown = useCallback(
    (event, room, mode = "move") => {
      if (!workspace || event.button !== 0 || !room?.mapRect) return;
      const mapRect = mapRef.current?.getBoundingClientRect();
      if (!mapRect) return;
      event.preventDefault();
      event.stopPropagation();
      const groupRects = room.mergedCount && room.allMapRects?.length > 1
        ? room.allMapRects.map((r, i) => ({
            roomId: i === 0 ? room.id : (stateRef.current.roomGroups?.[room.id]?.[i - 1] ?? null),
            rect: clampRoomRectForMap(r),
          })).filter((entry) => entry.roomId)
        : [{ roomId: room.id, rect: clampRoomRectForMap(room.mapRect) }];
      activeRoomEditRef.current = {
        roomId: room.id,
        mode,
        clientX: event.clientX,
        clientY: event.clientY,
        mapWidth: Math.max(1, mapRect.width),
        mapHeight: Math.max(1, mapRect.height),
        rect: clampRoomRectForMap(room.mapRect),
        groupRects,
      };
      setActiveRoomEditKey(`${room.id}:${mode}`);
      onSelectRoom(room.id);
    },
    [onSelectRoom, workspace],
  );

  const handleDrop = useCallback(
    (event, roomId = null) => {
      event.preventDefault();
      setFloorPlanDragActive(false);
      const file = Array.from(event.dataTransfer.files ?? []).find(isImageFile);
      if (file) {
        readFloorPlanFile(file);
        return;
      }
      const deviceId = event.dataTransfer.getData("text/plain");
      const rect = mapRef.current?.getBoundingClientRect();
      if (!deviceId || !rect) return;
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      const targetRoomId = roomId || findSpatialRoomAtPoint(model.rooms, x, y)?.id || null;
      updateState(placeSpatialDevice(state, deviceId, { x, y, roomId: targetRoomId }));
      setSelectedDeviceId(deviceId);
      if (targetRoomId) onSelectRoom(targetRoomId);
    },
    [model.rooms, onSelectRoom, readFloorPlanFile, state, updateState],
  );

  const handleMapDragOver = useCallback((event) => {
    event.preventDefault();
    if (Array.from(event.dataTransfer.types ?? []).includes("Files")) {
      event.dataTransfer.dropEffect = "copy";
      setFloorPlanDragActive(true);
    } else {
      event.dataTransfer.dropEffect = "move";
    }
  }, []);

  const handleMapDragLeave = useCallback((event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFloorPlanDragActive(false);
  }, []);

  const handleDeviceDrag = useCallback((event, deviceId) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", deviceId);
  }, []);

  const handleSelectDevice = useCallback(
    (device) => {
      setSelectedDeviceId(device.id);
      if (device.assignedRoomId) onSelectRoom(device.assignedRoomId);
    },
    [onSelectRoom],
  );

  const handleAssignDevice = useCallback(
    (deviceId, roomId) => {
      updateState(assignSpatialDevice(state, deviceId, roomId || null));
      if (roomId) onSelectRoom(roomId);
    },
    [onSelectRoom, state, updateState],
  );

  const handleNamingMode = useCallback(
    (namingMode) => updateState({ ...state, namingMode }),
    [state, updateState],
  );

  const handleApplySuggestion = useCallback(
    (suggestion) => {
      updateState(applySpatialSuggestion(state, suggestion));
      setSelectedDeviceId(suggestion.deviceId);
      if (suggestion.roomId) onSelectRoom(suggestion.roomId);
    },
    [onSelectRoom, state, updateState],
  );

  const handleDismissSuggestion = useCallback(
    (suggestion) => {
      updateState(dismissSpatialSuggestion(state, suggestion.id));
    },
    [state, updateState],
  );

  const handleMergeRooms = useCallback(() => {
    if (multiSelectIds.length < 2) return;
    const [primaryId, ...rest] = multiSelectIds;
    updateState(mergeSpatialRooms(state, primaryId, rest));
    onSelectRoom(primaryId);
    setMultiSelectIds([]);
  }, [multiSelectIds, onSelectRoom, state, updateState]);

  const handleSplitRoom = useCallback(
    (roomId) => {
      updateState(splitSpatialRoom(state, roomId));
      setMultiSelectIds([]);
    },
    [state, updateState],
  );

  const handleRoomClick = useCallback(
    (roomId, event) => {
      if (event?.shiftKey || event?.metaKey || event?.ctrlKey) {
        setMultiSelectIds((prev) =>
          prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId]
        );
      } else {
        setMultiSelectIds([roomId]);
        onSelectRoom(roomId);
      }
    },
    [onSelectRoom],
  );

  const markers = useMemo(() => {
    const placed = model.devices
      .filter((device) => device.placement?.placed)
      .map((device) => ({ device, x: device.placement.x, y: device.placement.y, ghost: false }));
    if (!selectedDevice || selectedDevice.placement?.placed) return placed;
    const room = model.rooms.find((item) => item.id === selectedDevice.assignedRoomId);
    if (!room?.mapRect) return placed;
    return [
      ...placed,
      {
        device: selectedDevice,
        x: room.mapRect.centerX,
        y: room.mapRect.centerY,
        ghost: true,
      },
    ];
  }, [model.devices, model.rooms, selectedDevice]);

  const stats = model.stats ?? {};
  const floorPlanRatioLocked = Boolean(
    state.floorPlanImage && state.floorPlanCoordinateMode === "image" && state.floorPlanImageAspectRatio,
  );
  const mapStyle = floorPlanRatioLocked
    ? { "--floor-plan-aspect-ratio": String(state.floorPlanImageAspectRatio) }
    : undefined;

  return (
    <section className={workspace ? "panel spatial-editor workspace" : "panel spatial-editor"}>
      <div className="panel-title">
        <MapIcon size={17} />
        <h2>{workspace ? "房屋结构编辑器" : "Spatial Model"}</h2>
        {workspace && (
          <>
            <button className="mini-icon-button" type="button" onClick={handleAddRoom} title="新增矩形房间">
              <Plus size={13} />
            </button>
            {multiSelectIds.length >= 2 && (
              <button
                className="mini-icon-button merge-btn"
                type="button"
                onClick={handleMergeRooms}
                title={`聚合 ${multiSelectIds.length} 个房间`}
              >
                <Layers3 size={13} />
                <span>聚合</span>
              </button>
            )}
          </>
        )}
        <button
          className="mini-icon-button"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="上传户型图"
        >
          <Upload size={13} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        className="spatial-file-input"
        type="file"
        accept="image/*"
        onChange={handleFloorPlanUpload}
      />

      <div className="spatial-editor-body">
        <div className="spatial-map-column">
          <button className="spatial-upload-dropzone" type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload size={15} />
            <span>{state.floorPlanImage ? `参考底图：${state.floorPlanImageName || "已加载"}` : "拖拽或点击上传参考底图"}</span>
            <small>{state.floorPlanImage ? `${formatFileSize(state.floorPlanImageSize) || "当前会话"} · 不改写原图` : "支持 PNG / JPG / HEIC 浏览器可读格式"}</small>
          </button>
          <div
            ref={mapRef}
            className={[
              "spatial-map",
              state.floorPlanImage ? "has-floor-plan" : "",
              floorPlanRatioLocked ? "ratio-locked" : "",
              floorPlanDragActive ? "upload-active" : "",
            ].filter(Boolean).join(" ")}
            style={mapStyle}
            onDragOver={handleMapDragOver}
            onDragLeave={handleMapDragLeave}
            onDrop={(event) => handleDrop(event)}
          >
            {state.floorPlanImage ? (
              <img
                ref={floorImageRef}
                className="spatial-floor-image"
                src={state.floorPlanImage}
                alt="户型图"
                onLoad={handleFloorImageLoad}
              />
            ) : (
              <div className="spatial-map-empty">
                <MousePointer2 size={15} />
                <span>拖拽户型图或设备到这里</span>
              </div>
            )}
            {floorPlanDragActive && (
              <div className="spatial-upload-overlay">
                <Upload size={20} />
                <span>松开以上传为参考户型图</span>
              </div>
            )}
            {model.rooms.map((room) => {
              const mergedRects = room.mergedCount && room.allMapRects?.length > 1 ? room.allMapRects : null;
              return (
              <Fragment key={room.id}>
                {mergedRects && mergedRects.map((rect, i) => {
                  if (i === 0) return null;
                  const borders = getMergedRectBorders(rect, mergedRects);
                  return (
                    <div
                      className="spatial-room-zone merged-secondary"
                      key={`${room.id}-sec-${i}`}
                      style={{
                        left: `${rect.left}%`,
                        top: `${rect.top}%`,
                        width: `${rect.width}%`,
                        height: `${rect.height}%`,
                        borderLeftWidth: borders.left ? undefined : 0,
                        borderRightWidth: borders.right ? undefined : 0,
                        borderTopWidth: borders.top ? undefined : 0,
                        borderBottomWidth: borders.bottom ? undefined : 0,
                      }}
                    />
                  );
                })}
                <button
                  className={[
                    "spatial-room-zone",
                    room.id === selectedRoomId ? "selected" : "",
                    multiSelectIds.includes(room.id) ? "multi-selected" : "",
                    activeRoomEditKey?.startsWith(`${room.id}:`) ? "editing" : "",
                    room.spatialSource === "editor" ? "customized" : "",
                    room.mergedCount ? "merged" : "",
                  ].filter(Boolean).join(" ")}
                  type="button"
                  style={(() => {
                    if (!room.mapRect) return undefined;
                    if (mergedRects) {
                      const borders = getMergedRectBorders(room.mapRect, mergedRects);
                      return {
                        left: `${room.mapRect.left}%`,
                        top: `${room.mapRect.top}%`,
                        width: `${room.mapRect.width}%`,
                        height: `${room.mapRect.height}%`,
                        borderLeftWidth: borders.left ? undefined : 0,
                        borderRightWidth: borders.right ? undefined : 0,
                        borderTopWidth: borders.top ? undefined : 0,
                        borderBottomWidth: borders.bottom ? undefined : 0,
                      };
                    }
                    return {
                      left: `${room.mapRect.left}%`,
                      top: `${room.mapRect.top}%`,
                      width: `${room.mapRect.width}%`,
                      height: `${room.mapRect.height}%`,
                    };
                  })()}
                  onClick={(event) => handleRoomClick(room.id, event)}
                  onPointerDown={(event) => handleRoomPointerDown(event, room, "move")}
                  onDragOver={handleMapDragOver}
                  onDrop={(event) => handleDrop(event, room.id)}
                  title={room.editorName}
                >
                  <span>{room.editorName}{room.mergedCount ? ` · ${room.mergedCount}矩形` : ""}</span>
                  {workspace && (
                    <span
                      className="room-resize-handle"
                      onPointerDown={(event) => handleRoomPointerDown(event, room, "resize")}
                      title="缩放房间"
                    />
                  )}
                </button>
              </Fragment>
              );
            })}
            {markers.map(({ device, x, y, ghost }) => (
              <button
                className={[
                  "spatial-device-marker",
                  device.id === selectedDevice?.id ? "selected" : "",
                  ghost ? "ghost" : "",
                  `role-${device.role}`,
                ].filter(Boolean).join(" ")}
                key={`${device.id}:${ghost ? "ghost" : "placed"}`}
                type="button"
                draggable
                style={{ left: `${x}%`, top: `${y}%` }}
                onDragStart={(event) => handleDeviceDrag(event, device.id)}
                onClick={() => handleSelectDevice(device)}
                title={device.displayName}
              >
                <LocateFixed size={12} />
              </button>
            ))}
          </div>
        </div>

        <div className="spatial-side-column">
          <div className="spatial-stats">
            <span>
              已定位 <strong>{stats[SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED] ?? 0}</strong>
            </span>
            <span>
              待定位 <strong>{stats[SPATIAL_DEVICE_STATUS.ASSIGNED_UNPLACED] ?? 0}</strong>
            </span>
            <span>
              待归房 <strong>{stats[SPATIAL_DEVICE_STATUS.PLACED_UNASSIGNED] ?? 0}</strong>
            </span>
          </div>

          <SpatialRoomDetail
            room={selectedRoom}
            onRename={(roomId, value) => updateState(updateSpatialRoomName(state, roomId, value))}
            onRectChange={handleRoomRectInput}
            onSplit={handleSplitRoom}
            onRemove={handleRemoveRoom}
          />

          <SpatialSuggestions
            suggestions={model.suggestions}
            onApply={handleApplySuggestion}
            onDismiss={handleDismissSuggestion}
          />

          <div className="room-name-grid">
            {model.rooms.slice(0, workspace ? model.rooms.length : 6).map((room) => (
              <label key={room.id}>
                <span>{room.name}</span>
                <input
                  value={state.roomNames[room.id] ?? room.name}
                  onChange={(event) => updateState(updateSpatialRoomName(state, room.id, event.target.value))}
                />
              </label>
            ))}
          </div>

          <div className="naming-toggle" role="group" aria-label="设备命名规则">
            <button
              className={state.namingMode === NAMING_MODES.ROOM_DEFAULT ? "selected" : ""}
              type="button"
              onClick={() => handleNamingMode(NAMING_MODES.ROOM_DEFAULT)}
            >
              房间+默认名
            </button>
            <button
              className={state.namingMode === NAMING_MODES.ROOM_CUSTOM ? "selected" : ""}
              type="button"
              onClick={() => handleNamingMode(NAMING_MODES.ROOM_CUSTOM)}
            >
              房间+自定义名
            </button>
          </div>

          <SpatialDeviceLanes
            groups={model.groups}
            selectedDeviceId={selectedDevice?.id}
            onDragStart={handleDeviceDrag}
            onSelect={handleSelectDevice}
            limit={workspace ? 18 : 5}
          />

          <SpatialDeviceDetail
            device={selectedDevice}
            rooms={model.rooms}
            state={state}
            onAssign={handleAssignDevice}
            onRename={(deviceId, value) => updateState(updateSpatialDeviceName(state, deviceId, value))}
            onClearPlacement={(deviceId) => updateState(clearSpatialPlacement(state, deviceId))}
          />
        </div>
      </div>
    </section>
  );
}

function SpatialRoomDetail({ room, onRename, onRectChange, onSplit, onRemove }) {
  if (!room) return null;
  const rect = room.mapRect ?? { left: 0, top: 0, width: 10, height: 10 };
  return (
    <div className="spatial-room-detail">
      <div className="spatial-room-detail-header">
        <Home size={13} />
        <strong>{room.editorName}</strong>
        <span>{room.mergedCount ? `聚合 · ${room.mergedCount}矩形` : room.custom ? "自定义" : room.spatialSource === "editor" ? "已校准" : "系统"}</span>
      </div>
      <div className="spatial-detail-grid">
        <label>
          <span>房间名</span>
          <input value={room.editorName} onChange={(event) => onRename(room.id, event.target.value)} />
        </label>
        <label>
          <span>类型</span>
          <input value={room.type ?? "generic"} readOnly />
        </label>
      </div>
      <div className="spatial-rect-grid">
        {[
          ["left", "X"],
          ["top", "Y"],
          ["width", "W"],
          ["height", "H"],
        ].map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input
              type="number"
              min={key === "width" || key === "height" ? 4 : 0}
              max={100}
              step={0.5}
              value={rect[key]}
              onChange={(event) => onRectChange(room.id, key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="spatial-detail-actions">
        {room.mergedCount && (
          <button type="button" onClick={() => onSplit(room.id)}>
            <Layers3 size={12} />
            拆分
          </button>
        )}
        <button type="button" onClick={() => onRemove(room.id)} disabled={!room.custom}>
          <Trash2 size={12} />
          删除
        </button>
      </div>
      <div className="spatial-merge-hint">
        {room.mergedCount
          ? `聚合房间 · ${room.mergedCount} 个矩形 · 点击"拆分"恢复`
          : "提示：Shift+点击多个房间后可聚合"}
      </div>
    </div>
  );
}

function SpatialSuggestions({ suggestions = [], onApply, onDismiss }) {
  if (suggestions.length === 0) return null;
  return (
    <div className="spatial-suggestions">
      <div className="spatial-suggestions-title">
        <span>Suggestions</span>
        <strong>{suggestions.length}</strong>
      </div>
      {suggestions.slice(0, 3).map((suggestion) => (
        <div className="spatial-suggestion" key={suggestion.id}>
          <div>
            <strong>{suggestion.deviceName}</strong>
            <span>{suggestion.title}</span>
            <small>{suggestion.reason}</small>
          </div>
          <div className="spatial-suggestion-actions">
            <button type="button" onClick={() => onApply(suggestion)} title="接受建议">
              <Check size={12} />
            </button>
            <button type="button" onClick={() => onDismiss(suggestion)} title="忽略建议">
              <X size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SpatialDeviceLanes({ groups, selectedDeviceId, onDragStart, onSelect, limit = 5 }) {
  const lanes = [
    [SPATIAL_DEVICE_STATUS.ASSIGNED_PLACED, "已分配已放置"],
    [SPATIAL_DEVICE_STATUS.ASSIGNED_UNPLACED, "已分配待定位"],
    [SPATIAL_DEVICE_STATUS.PLACED_UNASSIGNED, "已放置待归房"],
    [SPATIAL_DEVICE_STATUS.UNORGANIZED, "未拖入未分配"],
  ];
  return (
    <div className="spatial-device-lanes">
      {lanes.map(([status, label]) => (
        <div className={`spatial-lane lane-${status}`} key={status}>
          <div className="spatial-lane-title">
            <span>{label}</span>
            <strong>{groups[status]?.length ?? 0}</strong>
          </div>
          <div className="spatial-device-chip-list">
            {(groups[status] ?? []).slice(0, limit).map((device) => (
              <button
                className={device.id === selectedDeviceId ? "spatial-device-chip selected" : "spatial-device-chip"}
                key={device.id}
                type="button"
                draggable
                onDragStart={(event) => onDragStart(event, device.id)}
                onClick={() => onSelect(device)}
                title={device.displayName}
              >
                <span>{device.displayName}</span>
                <small>{device.role === "physical_controller" ? "控制器" : device.type}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SpatialDeviceDetail({ device, rooms, state, onAssign, onRename, onClearPlacement }) {
  if (!device) return null;
  return (
    <div className="spatial-detail">
      <div className="spatial-detail-header">
        <Info size={13} />
        <strong>{device.displayName}</strong>
        <span>{device.role === "physical_controller" ? "物理控制器" : "逻辑设备"}</span>
      </div>
      <div className="spatial-detail-grid">
        <label>
          <span>房间</span>
          <select value={device.assignedRoomId ?? ""} onChange={(event) => onAssign(device.id, event.target.value)}>
            <option value="">未分配</option>
            {rooms.map((room) => (
              <option value={room.id} key={room.id}>
                {room.editorName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>自定义名</span>
          <input
            value={state.customDeviceNames[device.id] ?? ""}
            placeholder={device.name}
            onChange={(event) => onRename(device.id, event.target.value)}
          />
        </label>
      </div>
      <div className="spatial-detail-meta">
        <span>{device.type}</span>
        <span>{device.assignedRoomName ?? "未分配"}</span>
        <span>{device.statusLabel ?? (device.online === false ? "离线" : "在线")}</span>
      </div>
      <div className="spatial-detail-actions">
        <button type="button" onClick={() => onClearPlacement(device.id)} disabled={!device.placement?.placed}>
          <Trash2 size={12} />
          清除定位
        </button>
        <button type="button" onClick={() => onAssign(device.id, "")}>
          <Pencil size={12} />
          取消归房
        </button>
      </div>
    </div>
  );
}

function BindingReview({ review, reviewSurfaceCount, hiddenThingIds = [], onHideThing, actionId, things = [], roomNameById, onSelectThing }) {
  if (!review || review.total === 0) return null;
  const recommendations = {
    ...(review.recommendations ?? { totalDevices: 0, bySeverity: {}, devices: [] }),
    hiddenThingIds,
  };
  const severityItems = Object.entries(recommendations.bySeverity ?? {}).sort(
    ([first], [second]) => severityRank(second) - severityRank(first),
  );

  return (
    <div className="binding-review">
      <div className="review-header">
        <span>Review Queue</span>
        <strong>{reviewSurfaceCount ?? recommendations.totalDevices}</strong>
      </div>
      <div className="review-risk-strip">
        {severityItems.map(([severity, count]) => (
          <span className={`risk-chip severity-${severity}`} key={severity}>
            {severity} <strong>{count}</strong>
          </span>
        ))}
        <span className="risk-chip protected-total">
          protected <strong>{review.total}</strong>
        </span>
      </div>
      <div className="review-reasons">
        {(review.topReasons ?? []).slice(0, 3).map((item) => (
          <div className="review-reason" key={item.reason}>
            <span>{item.reason}</span>
            <strong>{item.count}</strong>
          </div>
        ))}
      </div>
      <AdjustmentRecommendations
        recommendations={recommendations}
        onHideThing={onHideThing}
        actionId={actionId}
        things={things}
        roomNameById={roomNameById}
        onSelectThing={onSelectThing}
      />
    </div>
  );
}

function severityRank(severity) {
  if (severity === "critical") return 3;
  if (severity === "high") return 2;
  if (severity === "medium") return 1;
  return 0;
}

function AdjustmentRecommendations({ recommendations, onHideThing, actionId, things = [], roomNameById, onSelectThing }) {
  const hiddenThingIds = new Set(recommendations?.hiddenThingIds ?? []);
  const devices = (recommendations?.devices ?? []).filter((device) => !hiddenThingIds.has(device.thingId));
  if (devices.length === 0) return null;

  const thingMap = new Map(things.map((t) => [t.id, t]));

  return (
    <div className="adjustment-recommendations">
      <div className="recommendation-header">
        <span>建议调整</span>
        <strong>{devices.length}</strong>
      </div>
      {devices.slice(0, 6).map((device) => {
        const thing = thingMap.get(device.thingId);
        const roomName = thing ? (roomNameById?.get(thing.spaceId) ?? thing.spaceId ?? "未分区") : "";
        return (
          <div
            className={`recommendation-item severity-${device.severity} ${onSelectThing ? "clickable" : ""}`}
            key={device.thingId || device.thingName}
            onClick={() => onSelectThing?.(device.thingId)}
            role={onSelectThing ? "button" : undefined}
            tabIndex={onSelectThing ? 0 : undefined}
          >
            <div className="rec-item-main">
              <span className="rec-item-name">{device.thingName}</span>
              <div className="rec-item-meta">
                {thing?.type && <span className="rec-item-type">{thing.type}</span>}
                {roomName && <span className="rec-item-room">{roomName}</span>}
                <span className="rec-item-count">{device.count} 项能力</span>
              </div>
              <small className="rec-item-action">{device.action}</small>
            </div>
            <button
              type="button"
              className="rec-hide-btn"
              disabled={Boolean(actionId)}
              onClick={(e) => { e.stopPropagation(); onHideThing(device.thingId); }}
              title="仅从建议调整清单隐藏，不影响地图和设备模型"
            >
              <X size={11} />
              隐藏
            </button>
          </div>
        );
      })}
    </div>
  );
}

function RoomSelector({ rooms: sceneRooms, selectedRoomId, onSelect }) {
  return (
    <section className="panel room-panel">
      <div className="panel-title">
        <Home size={17} />
        <h2>Rooms</h2>
      </div>
      <div className="room-grid">
        {sceneRooms.map((room) => (
          <button
            className={room.id === selectedRoomId ? "room-button selected" : "room-button"}
            key={room.id}
            type="button"
            onClick={() => onSelect(room.id)}
          >
            <span>{room.name}</span>
            <small>{room.deviceCount ? `${room.deviceCount} 设备` : room.presence ? "有人" : "待机"}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function DeviceList({ devices, selectedDeviceId, onSelectDevice }) {
  return (
    <section className="panel device-panel">
      <div className="panel-title">
        <Cpu size={17} />
        <h2>Devices</h2>
      </div>
      <div className="device-list">
        {devices.map((device) => (
          <DeviceRow
            device={device}
            key={device.id}
            selected={device.id === selectedDeviceId}
            onSelect={onSelectDevice}
          />
        ))}
      </div>
    </section>
  );
}

function DeviceRow({ device, selected, onSelect }) {
  const state = deviceStateLabel(device);
  return (
    <div
      className={`device-row risk-${device.risk} ${selected ? "selected" : ""}`}
      onClick={() => onSelect?.(device.id)}
      role="button"
      tabIndex={0}
    >
      <div className="device-type">{deviceTypeNames[device.type] ?? device.type}</div>
      <div className="device-name">{device.name}</div>
      <div className="device-state">{state}</div>
    </div>
  );
}

const CAPABILITY_LABELS = {
  turn_on: "开启",
  turn_off: "关闭",
  set_brightness: "调节亮度",
  set_color_temperature: "调节色温",
  set_temperature: "调节温度",
  set_speed: "调节风速",
  set_mode: "模式切换",
  set_position: "调节位置",
  set_volume: "调节音量",
  set_input: "输入源切换",
  start_robot: "启动清扫",
  dock_robot: "回充",
  start_cycle: "启动运行",
  stop_cycle: "停止运行",
  dispense_food: "投放食物",
  set_privacy_mode: "隐私模式",
};

const ENUM_LABELS = {
  cool: "制冷",
  heat: "制热",
  dry: "除湿",
  fan_only: "送风",
  hdmi1: "HDMI 1",
  hdmi2: "HDMI 2",
  tv: "电视",
  cast: "投屏",
};

const AC_MODE_LABELS = {
  cool: "制冷",
  heat: "制热",
  dry: "除湿",
  fan_only: "送风",
};

const RISK_LABELS = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  sensitive: "敏感",
};

const CONFIRMATION_LABELS = {
  never: "无需确认",
  sometimes: "偶尔确认",
  always: "每次确认",
};

function DeviceCapabilityPanel({ device, capabilityOverrides, onToggleCapability }) {
  if (!device) {
    return (
      <section className="panel capability-panel">
        <div className="panel-title">
          <ShieldCheck size={17} />
          <h2>能力边界</h2>
        </div>
        <p className="capability-hint">点击上方设备查看其能力边界</p>
      </section>
    );
  }

  const manifest = createDeviceManifest(device);
  const deviceKey = device.id;

  return (
    <section className="panel capability-panel">
      <div className="panel-title">
        <ShieldCheck size={17} />
        <h2>能力边界</h2>
      </div>
      <div className="capability-device-header">
        <strong>{device.name}</strong>
        <span className={`risk-tag risk-${manifest.risk}`}>{RISK_LABELS[manifest.risk] ?? manifest.risk}</span>
      </div>
      <div className="capability-list">
        {manifest.capabilities.map((cap) => {
          const overrideKey = `${deviceKey}:${cap.name}`;
          const disabled = Boolean(capabilityOverrides[overrideKey]);
          return (
            <div key={cap.name} className={`capability-row ${disabled ? "disabled" : ""}`}>
              <div className="capability-info">
                <span className="capability-name">{CAPABILITY_LABELS[cap.name] ?? cap.name}</span>
                <div className="capability-meta">
                  <span className={`risk-mini risk-${cap.risk}`}>{RISK_LABELS[cap.risk] ?? cap.risk}</span>
                  {cap.valueType === "number" && (
                    <span className="capability-range">
                      {cap.min}–{cap.max}{cap.unit}
                    </span>
                  )}
                  {cap.valueType === "enum" && (
                    <span className="capability-range">
                      {(cap.options ?? []).map((opt) => ENUM_LABELS[opt] ?? opt).join(" / ")}
                    </span>
                  )}
                  <span className="capability-confirm">{CONFIRMATION_LABELS[cap.confirmation] ?? cap.confirmation}</span>
                </div>
              </div>
              <button
                className={`capability-toggle ${disabled ? "off" : "on"}`}
                type="button"
                onClick={() => onToggleCapability(deviceKey, cap.name)}
                title={disabled ? "已禁止 · 点击恢复" : "可控 · 点击禁止"}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb" />
                </span>
                <span className="toggle-label">{disabled ? "禁止" : "可控"}</span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function deviceStateLabel(device) {
  if (device.statusLabel) return device.statusLabel;
  if (device.type === "light") return device.on ? `${device.brightness}%` : "关闭";
  if (device.type === "ac") return device.on ? `${device.temperature}°C · ${AC_MODE_LABELS[device.mode] ?? device.mode ?? "制冷"}` : "关闭";
  if (device.type === "fan") return device.on ? `${device.speed}档` : "关闭";
  if (device.type === "curtain") return `${device.position}%`;
  if (device.type === "tv") return device.on ? `开启 · ${device.channel ?? device.input ?? "HDMI 1"}` : "关闭";
  if (device.type === "robot_vacuum") return `${device.status} · ${device.battery}%`;
  if (device.type === "pet_feeder") return `${device.portionsToday}份 · ${device.lastFeed}`;
  if (device.type === "presence_sensor" || device.type === "motion_sensor") {
    return device.detected ? "有人" : "无人";
  }
  if (device.type === "door_sensor") return device.open ? "开启" : "关闭";
  if (device.type === "camera") return device.privacyMode ? "隐私" : device.on ? "开启" : "关闭";
  if (device.type === "gas_heater") return device.on ? `${device.temperature}°C` : "关闭";
  if (device.type === "washer" || device.type === "dryer") {
    return device.status === "running" ? `${device.minutesLeft}分钟` : device.status;
  }
  if (device.type === "drying_rack") return `${device.position}%`;
  if (device.type === "generic_sensor" || device.type === "generic_entity") {
    return [device.value, device.unit].filter(Boolean).join(" ") || "只读";
  }
  return "待机";
}

function CommandConsole({
  input,
  setInput,
  inputRef,
  messages,
  processing,
  onSubmit,
  speechState,
  speechSupported,
  ttsSupported,
  onToggleListening,
  onToggleTts,
  executionControl,
  onExecutionPreferenceChange,
}) {
  const realSelected = executionControl?.preference === COMMAND_EXECUTION_PREFERENCE.REAL;
  const realAvailable = Boolean(executionControl?.realAvailable);
  const effectiveReal = executionControl?.effectiveMode === COMMAND_EXECUTION_PREFERENCE.REAL;
  const messageListRef = useRef(null);
  let executionHint = "Hermes 规划 · 模拟执行";
  if (effectiveReal) {
    executionHint = "Hermes 规划 · 真实控制低风险设备";
  } else if (realSelected && !realAvailable) {
    executionHint = "后端未开启 Real，仍会模拟";
  } else if (realAvailable) {
    executionHint = "后端已允许 Real，本次仍模拟";
  }

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages, processing]);

  return (
    <section className="panel console-panel">
      <div className="panel-title">
        <Bot size={17} />
        <h2>Command</h2>
        {processing && <span className="working">Parsing</span>}
        <div className="speech-controls">
          <button
            className={`mini-icon-button ${speechState.listening ? "active" : ""}`}
            type="button"
            onClick={onToggleListening}
            disabled={!speechSupported || processing || speechState.speaking}
            title={speechSupported ? (speechState.listening ? "停止语音输入" : "开始语音输入") : "当前浏览器不支持语音输入"}
          >
            {speechState.listening ? <MicOff size={13} /> : <Mic size={13} />}
          </button>
          <button
            className={`mini-icon-button ${speechState.ttsEnabled ? "active" : ""}`}
            type="button"
            onClick={onToggleTts}
            disabled={!ttsSupported}
            title={ttsSupported ? (speechState.ttsEnabled ? "关闭语音播报" : "开启语音播报") : "当前浏览器不支持语音播报"}
          >
            {speechState.ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
          </button>
        </div>
      </div>
      <div className={`execution-control ${effectiveReal ? "mode-real" : "mode-dry"}`}>
        <div>
          <strong>本次执行</strong>
          <span>{executionHint}</span>
        </div>
        <div className="execution-segmented" role="group" aria-label="本次执行模式">
          <button
            className={executionControl?.preference !== COMMAND_EXECUTION_PREFERENCE.REAL ? "selected" : ""}
            type="button"
            onClick={() => onExecutionPreferenceChange(COMMAND_EXECUTION_PREFERENCE.DRY_RUN)}
            title="只做计划、模拟、审计，不控制真实设备"
          >
            模拟
          </button>
          <button
            className={realSelected ? "selected" : ""}
            type="button"
            onClick={() => onExecutionPreferenceChange(COMMAND_EXECUTION_PREFERENCE.REAL)}
            disabled={!realAvailable}
            title={realAvailable ? "允许通过安全链路后的低风险动作真实执行" : "需要先设置 HARNESS_EXECUTION_MODE=real 并重启服务"}
          >
            真实
          </button>
        </div>
      </div>
      <div className="message-list" aria-live="polite" ref={messageListRef}>
        {messages.slice(-8).map((message) => (
          <div className={`message ${message.role}`} key={message.id}>
            <div className="message-bubble">
              <p>{message.content}</p>
              <div className="message-meta">
                <span>{message.time}</span>
                {message.path && <span>{message.path}</span>}
                {typeof message.latency === "number" && (
                  <span className={`latency ${latencyClass(message.latency)}`}>{message.latency}ms</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {(speechState.listening || speechState.error) && (
        <div className={`speech-status ${speechState.error ? "error" : ""}`}>
          {speechState.error || `正在识别 · ${Math.round(speechState.confidence * 100)}%`}
        </div>
      )}
      <form
        className="command-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(input);
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="输入：关客厅灯 / 厨房有点闷 / 我要睡了"
          disabled={processing}
        />
        <button className="send-button" type="submit" disabled={processing || !input.trim()}>
          <Send size={18} />
        </button>
      </form>
    </section>
  );
}

function PendingPlan({ plan, onConfirm, onCancel }) {
  if (!plan) return null;

  return (
    <section className="panel confirm-panel">
      <div className="panel-title">
        <LockKeyhole size={17} />
        <h2>Confirm</h2>
      </div>
      <p>{plan.summary}</p>
      <div className="confirm-actions">
        <button className="confirm-button" type="button" onClick={onConfirm}>
          <Check size={16} />
          确认
        </button>
        <button className="cancel-button" type="button" onClick={onCancel}>
          <X size={16} />
          取消
        </button>
      </div>
    </section>
  );
}

function PlanPreview({ plan }) {
  if (!plan) return null;
  const explanationLines = plan.explanation?.summary?.split("\n").filter(Boolean) ?? [];

  return (
    <section className="panel plan-panel">
      <div className="panel-title">
        <ShieldCheck size={17} />
        <h2>Plan</h2>
        <span className={`path-badge ${plan.path === "fast" ? "fast" : "llm"}`}>
          {plan.path === "fast" ? "Fast Path" : plan.path === "llm-real" ? "LLM Real" : "LLM Sim"}
        </span>
      </div>
      <p className="plan-summary">{plan.summary}</p>
      {explanationLines.length > 0 && (
        <div className="intent-explanation">
          <div className="explanation-title">{plan.explanation.title ?? "Intent Explanation"}</div>
          {explanationLines.slice(0, 6).map((line) => (
            <div className="explanation-line" key={line}>
              {line}
            </div>
          ))}
        </div>
      )}
      <div className="step-list">
        {plan.steps.length === 0 ? (
          <div className="empty-step">No device action</div>
        ) : (
          plan.steps.map((step) => (
            <div className={`step risk-${step.risk}`} key={step.id}>
              <div>
                <strong>{step.deviceName}</strong>
                <span>{describeStep(step)}</span>
              </div>
              <small>{step.risk}</small>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function IntelligencePanel({ audit, memory, agents, actionId, onRefresh, onReplay, onIgnoreCandidate, onDeleteCandidate, liveRoomName, liveOccupiedRooms = [] }) {
  const candidates = memory?.topCandidates ?? [];
  const corrections = memory?.correctionCandidates ?? [];
  const context = agents?.agents?.context;
  const learning = agents?.agents?.learning;
  const mapping = agents?.agents?.mapping;
  const diagnostics = agents?.agents?.diagnostics;
  const testAgent = agents?.agents?.test;
  const insightItems = [
    {
      label: "人在区域",
      value: liveRoomName ?? "未知",
      meta: liveOccupiedRooms.length > 0
        ? `${liveOccupiedRooms.length} 个区域有人`
        : "暂无占用信号",
    },
    { label: "学习候选", value: `${learning?.candidates?.length ?? 0}`, meta: "仅建议" },
    { label: "映射建议", value: `${mapping?.candidates?.length ?? 0}`, meta: "待确认" },
    { label: "诊断发现", value: `${diagnostics?.findings?.length ?? 0}`, meta: "健康提示" },
  ];
  return (
    <section className="panel intelligence-panel">
      <div className="panel-title">
        <Bot size={17} />
        <h2>System Insights</h2>
        <button className="mini-icon-button" type="button" onClick={onRefresh} title="刷新审计和学习摘要">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="agent-mode">
        <span>后台分析</span>
        <strong>{agents?.summary?.actionRequired ? "需要关注" : "运行正常"}</strong>
      </div>
      {agents && (
        <div className="insight-grid">
          {insightItems.map((item) => (
            <div className="insight-card" key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.meta}</small>
            </div>
          ))}
        </div>
      )}
      <div className="learning-metrics">
        <Metric label="审计" value={`${audit.length}`} />
        <Metric label="候选" value={`${memory?.candidateCount ?? 0}`} />
        <Metric label="忽略" value={`${memory?.ignoredCount ?? 0}`} />
      </div>
      <details className="insight-details">
        <summary>查看后台详情</summary>
        {mapping?.candidates?.length > 0 && (
          <div className="agent-list">
            {mapping.candidates.slice(0, 2).map((candidate) => (
              <div className={`agent-item severity-${candidate.severity}`} key={candidate.thingId || candidate.thingName}>
                <span>{candidate.proposedAction}</span>
                <strong>{candidate.thingName}</strong>
                <small>{candidate.reason}</small>
              </div>
            ))}
          </div>
        )}
        {diagnostics?.findings?.length > 0 && (
          <div className="agent-list">
            {diagnostics.findings.slice(0, 2).map((finding) => (
              <div className={`agent-item severity-${finding.severity}`} key={finding.id}>
                <span>{finding.title}</span>
                <strong>{finding.message}</strong>
              </div>
            ))}
          </div>
        )}
        {testAgent?.testCases?.length > 0 && (
          <div className="agent-list">
            {testAgent.testCases.slice(0, 2).map((testCase) => (
              <div className="agent-item severity-low" key={testCase.id}>
                <span>{testCase.priority}</span>
                <strong>{testCase.input}</strong>
                <small>{testCase.type}</small>
              </div>
            ))}
          </div>
        )}
        <div className="learning-list">
          {candidates.length === 0 ? (
            <div className="learning-empty">暂无可处理学习候选</div>
          ) : (
            candidates.slice(0, 3).map((candidate) => (
              <div className="learning-candidate" key={candidate.id}>
                <div>
                  <span>{candidate.type}</span>
                  <strong>{candidate.input}</strong>
                  <small>
                    {candidate.count}x · {Math.round(candidate.confidence * 100)}%
                  </small>
                </div>
                <div className="candidate-actions">
                  <button
                    type="button"
                    disabled={Boolean(actionId)}
                    onClick={() => onIgnoreCandidate(candidate)}
                    title="忽略这个学习候选"
                  >
                    忽略
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(actionId)}
                    onClick={() => onDeleteCandidate(candidate)}
                    title="删除并阻止它从历史观察中立刻重建"
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        {corrections.length > 0 && (
          <div className="correction-list">
            <div className="correction-header">
              <span>需要纠错</span>
              <strong>{corrections.length}</strong>
            </div>
            {corrections.slice(0, 3).map((candidate) => (
              <div className="correction-candidate" key={candidate.id}>
                <span>{candidate.input}</span>
                <small>{candidate.reason}</small>
              </div>
            ))}
          </div>
        )}
        <div className="audit-mini-list">
          {audit.slice(0, 3).map((entry) => (
            <div className={`audit-mini-item ${entry.status}`} key={entry.commandId}>
              <div>
                <span>{entry.status}</span>
                <strong>{entry.input}</strong>
                <small>{entry.latencyMs}ms</small>
              </div>
              <button
                type="button"
                disabled={Boolean(actionId)}
                onClick={() => onReplay(entry)}
                title="以 dry-run 模式回放该命令"
              >
                <Play size={11} />
                回放
              </button>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function AutomationSuggestionsPanel({ data, actionId, onCapture, onSimulate, onReview }) {
  const suggestions = (data?.suggestions ?? []).filter((item) => item.status !== "ignored").slice(0, 4);
  const activeCount = suggestions.filter((suggestion) => suggestion.status !== "reviewed").length;
  return (
    <section className="panel automation-panel">
      <div className="panel-title">
        <Activity size={17} />
        <h2>Automation Lab</h2>
        <span className="shadow-badge">Shadow</span>
        <button
          className="mini-icon-button"
          type="button"
          onClick={onCapture}
          disabled={Boolean(actionId)}
          title="采集只读家庭事件快照"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="automation-intro">
        <strong>{activeCount > 0 ? `${activeCount} 条建议待看` : "暂无需要处理的自动化"}</strong>
        <span>这里只做影子观察和模拟，不会自动启用真实设备联动。</span>
      </div>
      <div className="automation-summary">
        <span>事件 <strong>{data?.eventCount ?? 0}</strong></span>
        <span>建议 <strong>{data?.suggestionCount ?? 0}</strong></span>
        <span>已看 <strong>{data?.reviewedCount ?? 0}</strong></span>
      </div>
      {suggestions.length === 0 ? (
        <p className="hcm-note">需要至少两次相似成功操作才会生成建议。</p>
      ) : (
        <details className="automation-details">
          <summary>查看建议与模拟</summary>
          <div className="automation-list">
            {suggestions.map((suggestion) => (
              <div className="automation-item" key={suggestion.id}>
                <div>
                  <strong>{suggestion.title}</strong>
                  <p>{suggestion.summary}</p>
                  <small>{Math.round(suggestion.confidence * 100)}% · {suggestion.status}</small>
                </div>
                <div className="automation-actions">
                  <button
                    className="mini-icon-button"
                    type="button"
                    onClick={() => onSimulate(suggestion)}
                    disabled={Boolean(actionId)}
                    title="仅模拟，不控制真实设备"
                  >
                    <Play size={13} />
                  </button>
                  <button
                    className="mini-icon-button"
                    type="button"
                    onClick={() => onReview(suggestion, "reviewed")}
                    disabled={Boolean(actionId) || suggestion.status === "reviewed"}
                    title="标记为已审核，不启用自动化"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    className="mini-icon-button"
                    type="button"
                    onClick={() => onReview(suggestion, "ignored")}
                    disabled={Boolean(actionId)}
                    title="忽略建议"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function SensorReadouts({ sceneModel, fallbackDevices }) {
  const sensors = useMemo(() => {
    const sceneSensors = (sceneModel?.devices ?? [])
      .filter(isSensorDevice)
      .sort(compareSensorReadouts);
    if (sceneModel?.source === "hcm" && sceneSensors.length > 0) return sceneSensors;
    return [
      fallbackDevices.entry_motion,
      fallbackDevices.kitchen_presence,
      fallbackDevices.study_presence,
      fallbackDevices.front_door,
    ].filter(Boolean);
  }, [fallbackDevices, sceneModel]);
  return (
    <section className="panel sensor-panel">
      <div className="panel-title">
        <Gauge size={17} />
        <h2>Sensors</h2>
      </div>
      <div className="sensor-grid">
        {sensors.map((sensor) => (
          <div className="sensor-card" key={sensor.id} aria-label={`${sensor.name}：${deviceStateLabel(sensor)}`}>
            <span>{sensor.name.replace("传感器", "")}</span>
            <strong>{deviceStateLabel(sensor)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function isSensorDevice(device) {
  return ["presence_sensor", "motion_sensor", "door_sensor"].includes(device.type);
}

function compareSensorReadouts(first, second) {
  const firstRoomRank = roomDisplayRank(first.roomId);
  const secondRoomRank = roomDisplayRank(second.roomId);
  return firstRoomRank - secondRoomRank || first.name.localeCompare(second.name, "zh-CN");
}

function roomDisplayRank(roomId) {
  const order = ["entry", "living", "dining", "kitchen", "study", "master", "second", "cat_room", "bath", "master_bath", "balcony"];
  const index = order.indexOf(roomId);
  return index === -1 ? 99 : index;
}

function AuditLog({ logs }) {
  return (
    <section className="panel audit-panel">
      <div className="panel-title">
        <Clock3 size={17} />
        <h2>Audit</h2>
      </div>
      <div className="audit-list">
        {logs.slice(0, 8).map((log) => (
          <div className={`audit-item ${log.level}`} key={log.id}>
            <span>{log.time}</span>
            <p>{log.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
