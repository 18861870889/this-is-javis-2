import { CAPABILITY_KINDS, createHcmHome } from "../hcm.js";
import { createDeviceManifest, pickDeviceState, validateActionAgainstManifest } from "../deviceRuntime.js";
import {
  assertAuthorizedProviderExecution,
  createCapabilityEvidence,
  createProviderCommand,
  createProviderIdentity,
  createProviderSnapshotEnvelope,
  defineProviderAdapter,
} from "./providerAdapterSdk.js";

export const SIMULATOR_ADAPTER_ID = "simulator";

export function createSimulatorAdapter({ devices = {}, spaces = [] } = {}) {
  const store = structuredClone(devices);
  const identity = createProviderIdentity({
    id: SIMULATOR_ADAPTER_ID,
    name: "Harness Simulator",
    version: "v0.17",
    transport: "memory",
  });

  return defineProviderAdapter({
    id: SIMULATOR_ADAPTER_ID,
    identity: async () => identity,
    getConnectionStatus: async () => ({ state: "connected", configured: true }),
    discoverSnapshot: async () => simulatorSnapshot(store, spaces, identity),
    discoverHcmHome: async () => simulatorHcmHome(store, spaces, identity),
    readState: async (targetId) => {
      const device = store[targetId];
      if (!device) throw new Error(`Unknown simulator target ${targetId}`);
      return pickDeviceState(device);
    },
    compileAction: async (action) => {
      const deviceId = action.deviceId ?? action.thingId ?? action.device_id;
      const device = store[deviceId];
      const manifest = device ? createDeviceManifest(device, SIMULATOR_ADAPTER_ID) : null;
      const validation = validateActionAgainstManifest(
        { device_id: deviceId, capability: action.capabilityId ?? action.capability, value: action.value },
        manifest,
      );
      if (!validation.ok) throw new Error(validation.message);
      return createProviderCommand({
        providerId: SIMULATOR_ADAPTER_ID,
        target: { id: deviceId, type: "device" },
        operation: validation.capability.name,
        payload: { value: validation.action.value, deviceName: device.name },
        evidence: simulatorCapabilityEvidence(device, validation.capability),
        idempotencyKey: action.idempotencyKey,
      });
    },
    simulate: async (command) => simulateSimulatorCommand(command, store),
    execute: async (command, context) => {
      assertAuthorizedProviderExecution(context, command);
      const simulation = simulateSimulatorCommand(command, store);
      if (!simulation.ok) throw new Error(simulation.message);
      const device = store[command.target.id];
      const result = executeStep(
        {
          deviceId: device.id,
          deviceName: device.name,
          capability: command.operation,
          value: command.payload.value,
        },
        store,
      );
      return { ...result, providerId: SIMULATOR_ADAPTER_ID, state: pickDeviceState(device) };
    },
    executePlan,
    executeStep,
    tick,
    getDevices: () => structuredClone(store),
  });
}

export function simulatorSnapshot(devices, spaces, identity) {
  const manifests = Object.values(devices).map((device) => createDeviceManifest(device, SIMULATOR_ADAPTER_ID));
  return createProviderSnapshotEnvelope({
    provider: identity,
    spaces: spaces.map((space) => ({ externalId: space.id, name: space.name, type: space.type })),
    devices: manifests.map((manifest) => ({
      externalId: manifest.id,
      name: manifest.name,
      spaceId: manifest.roomId,
      type: manifest.type,
      metadata: { risk: manifest.risk },
    })),
    entities: manifests.flatMap((manifest) =>
      manifest.capabilities.map((capability) => ({
        externalId: `${manifest.id}:${capability.name}`,
        name: capability.name,
        deviceId: manifest.id,
        type: "capability",
        metadata: { valueType: capability.valueType, min: capability.min, max: capability.max, unit: capability.unit },
      })),
    ),
    states: manifests.map((manifest) => ({
      targetId: manifest.id,
      value: manifest.state,
      online: manifest.state.online,
      attributes: { type: manifest.type, risk: manifest.risk },
    })),
    metadata: { source: "in_memory_simulator" },
  });
}

function simulatorHcmHome(devices, spaces, identity) {
  const things = Object.values(devices).map((device) => {
    const manifest = createDeviceManifest(device, SIMULATOR_ADAPTER_ID);
    return {
      id: manifest.id,
      name: manifest.name,
      type: manifest.type,
      spaceId: manifest.roomId,
      online: manifest.state.online,
      provider: { id: SIMULATOR_ADAPTER_ID, deviceId: manifest.id },
      policy: { risk: manifest.risk, autoExecutable: manifest.risk === "low" },
      state: manifest.state,
      capabilities: manifest.capabilities.map((capability) => ({
        id: capability.name,
        name: capability.name,
        kind: CAPABILITY_KINDS.CONTROL,
        valueType: capability.valueType,
        unit: capability.unit,
        state: manifest.state,
        binding: { provider: SIMULATOR_ADAPTER_ID, deviceId: manifest.id, operation: capability.name },
        evidence: simulatorCapabilityEvidence(device, capability),
        policy: {
          risk: capability.risk,
          confirmation: capability.confirmation,
          autoExecutable: capability.risk === "low" && capability.confirmation === "never",
          reason: "Simulator manifest capability",
        },
      })),
    };
  });
  return createHcmHome({
    provider: identity,
    spaces: spaces.map((space) => ({ id: space.id, name: space.name, provider: { id: SIMULATOR_ADAPTER_ID, spaceId: space.id } })),
    things,
  });
}

function simulatorCapabilityEvidence(device, capability) {
  return createCapabilityEvidence({
    providerId: SIMULATOR_ADAPTER_ID,
    targetId: device.id,
    source: "device_manifest",
    capability: capability.name,
    observations: { deviceType: device.type, online: device.online ?? true },
    commands: [capability.name],
    constraints: { valueType: capability.valueType, min: capability.min, max: capability.max, unit: capability.unit },
    confidence: 1,
  });
}

function simulateSimulatorCommand(command, devices) {
  if (command?.providerId !== SIMULATOR_ADAPTER_ID) {
    return { ok: false, code: "wrong_provider", message: "Command is not for the simulator", commandFingerprint: command?.fingerprint };
  }
  const device = devices[command.target?.id];
  if (!device) return { ok: false, code: "unknown_target", message: `Unknown simulator target ${command.target?.id ?? ""}`, commandFingerprint: command.fingerprint };
  if (device.online === false) return { ok: false, code: "offline", message: `${device.name} is offline`, commandFingerprint: command.fingerprint };
  const validation = validateActionAgainstManifest(
    { device_id: device.id, capability: command.operation, value: command.payload?.value },
    createDeviceManifest(device, SIMULATOR_ADAPTER_ID),
  );
  return validation.ok
    ? { ok: true, mode: "simulation", providerId: SIMULATOR_ADAPTER_ID, targetId: device.id, operation: command.operation, commandFingerprint: command.fingerprint }
    : { ok: false, mode: "simulation", providerId: SIMULATOR_ADAPTER_ID, code: validation.code, message: validation.message, commandFingerprint: command.fingerprint };
}

export function executePlan(plan, devices) {
  const next = structuredClone(devices);
  const results = [];

  for (const step of plan.steps) {
    const result = executeStep(step, next);
    results.push(result);
  }

  return {
    devices: next,
    results,
    log: {
      id: crypto.randomUUID(),
      time: now(),
      level: plan.needsConfirmation ? "confirm" : "success",
      text:
        results.length > 0
          ? `执行计划「${plan.intent}」：${results.map((item) => item.text).join("；")}`
          : plan.summary,
    },
  };
}

export function executeStep(step, devices) {
  const device = devices[step.deviceId];
  if (!device) {
    return {
      step,
      status: "failed",
      text: `未找到设备 ${step.deviceName}`,
    };
  }

  applyStep(device, step);
  return {
    step,
    status: "executed",
    text: `${step.deviceName}: ${describeStep(step)}`,
  };
}

export function tick(devices) {
  const next = structuredClone(devices);
  for (const device of Object.values(next)) {
    if (["washer", "dryer"].includes(device.type) && device.status === "running") {
      device.minutesLeft = Math.max(0, device.minutesLeft - 1);
      if (device.minutesLeft === 0) device.status = "done";
    }
    if (device.type === "robot_vacuum" && device.status === "cleaning") {
      device.battery = Math.max(8, device.battery - 1);
      if (device.battery <= 12) device.status = "docked";
    }
  }
  return next;
}

export function describeStep(step) {
  switch (step.capability) {
    case "turn_on":
      return "打开";
    case "turn_off":
      return "关闭";
    case "set_brightness":
      return `亮度 ${step.value}%`;
    case "set_temperature":
      return `${step.value} 度`;
    case "set_speed":
      return `${step.value} 档`;
    case "set_position":
      return `开合 ${step.value}%`;
    case "start_robot":
      return "开始清扫";
    case "dock_robot":
      return "回充";
    case "start_cycle":
      return "开始运行";
    case "stop_cycle":
      return "停止运行";
    case "dispense_food":
      return `投喂 ${step.value} 份`;
    case "set_privacy_mode":
      return step.value ? "开启隐私模式" : "关闭隐私模式";
    default:
      return step.capability;
  }
}

function applyStep(device, step) {
  switch (step.capability) {
    case "turn_on":
      device.on = true;
      if (device.type === "fan") device.speed = Math.max(device.speed ?? 0, 1);
      if (device.type === "light") device.brightness = Math.max(device.brightness ?? 0, 60);
      break;
    case "turn_off":
      device.on = false;
      if (device.type === "fan") device.speed = 0;
      if (device.type === "light") device.brightness = 0;
      break;
    case "set_brightness":
      device.on = step.value > 0;
      device.brightness = step.value;
      break;
    case "set_temperature":
      device.on = true;
      device.temperature = step.value;
      break;
    case "set_speed":
      device.on = step.value > 0;
      device.speed = step.value;
      break;
    case "set_position":
      device.position = step.value;
      break;
    case "start_robot":
      device.status = "cleaning";
      break;
    case "dock_robot":
      device.status = "docked";
      break;
    case "start_cycle":
      device.status = "running";
      device.minutesLeft = device.type === "washer" ? 48 : 35;
      break;
    case "stop_cycle":
      device.status = "idle";
      device.minutesLeft = 0;
      break;
    case "dispense_food":
      device.portionsToday += step.value;
      device.lastFeed = now().slice(0, 5);
      break;
    case "set_privacy_mode":
      device.privacyMode = step.value;
      break;
    default:
      break;
  }
}

function now() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
