export const CAPABILITIES = {
  TURN_ON: "turn_on",
  TURN_OFF: "turn_off",
  SET_BRIGHTNESS: "set_brightness",
  SET_COLOR_TEMPERATURE: "set_color_temperature",
  SET_TEMPERATURE: "set_temperature",
  SET_SPEED: "set_speed",
  SET_MODE: "set_mode",
  SET_POSITION: "set_position",
  SET_VOLUME: "set_volume",
  SET_INPUT: "set_input",
  START_ROBOT: "start_robot",
  DOCK_ROBOT: "dock_robot",
  START_CYCLE: "start_cycle",
  STOP_CYCLE: "stop_cycle",
  DISPENSE_FOOD: "dispense_food",
  SET_PRIVACY_MODE: "set_privacy_mode",
};

export const RISK_CONFIRMATION = {
  low: "never",
  medium: "sometimes",
  high: "always",
  sensitive: "always",
};

const STATE_KEYS = [
  "on",
  "brightness",
  "colorTemperature",
  "temperature",
  "mode",
  "speed",
  "position",
  "volume",
  "input",
  "channel",
  "detected",
  "open",
  "status",
  "battery",
  "portionsToday",
  "lastFeed",
  "privacyMode",
  "minutesLeft",
  "value",
  "unit",
  "online",
];

const DEVICE_CAPABILITY_PROFILES = {
  light: [
    booleanCapability(CAPABILITIES.TURN_ON),
    booleanCapability(CAPABILITIES.TURN_OFF),
    numberCapability(CAPABILITIES.SET_BRIGHTNESS, 0, 100, "%"),
    numberCapability(CAPABILITIES.SET_COLOR_TEMPERATURE, 2700, 6500, "K"),
  ],
  switch: [booleanCapability(CAPABILITIES.TURN_ON), booleanCapability(CAPABILITIES.TURN_OFF)],
  ac: [
    booleanCapability(CAPABILITIES.TURN_ON),
    booleanCapability(CAPABILITIES.TURN_OFF),
    numberCapability(CAPABILITIES.SET_TEMPERATURE, 16, 30, "C"),
    numberCapability(CAPABILITIES.SET_SPEED, 0, 5, "level"),
    enumCapability(CAPABILITIES.SET_MODE, ["cool", "heat", "dry", "fan_only"], {
      risk: "low",
    }),
  ],
  fan: [
    booleanCapability(CAPABILITIES.TURN_ON),
    booleanCapability(CAPABILITIES.TURN_OFF),
    numberCapability(CAPABILITIES.SET_SPEED, 0, 3, "level"),
  ],
  curtain: [numberCapability(CAPABILITIES.SET_POSITION, 0, 100, "%")],
  tv: [
    booleanCapability(CAPABILITIES.TURN_ON),
    booleanCapability(CAPABILITIES.TURN_OFF),
    numberCapability(CAPABILITIES.SET_VOLUME, 0, 100, "%"),
    enumCapability(CAPABILITIES.SET_INPUT, ["hdmi1", "hdmi2", "tv", "cast"], {
      risk: "low",
    }),
  ],
  gas_heater: [
    booleanCapability(CAPABILITIES.TURN_ON, { risk: "high", confirmation: "always" }),
    booleanCapability(CAPABILITIES.TURN_OFF, { risk: "high", confirmation: "always" }),
    numberCapability(CAPABILITIES.SET_TEMPERATURE, 35, 50, "C", {
      risk: "high",
      confirmation: "always",
    }),
  ],
  pet_feeder: [numberCapability(CAPABILITIES.DISPENSE_FOOD, 1, 2, "portion", { risk: "medium" })],
  drying_rack: [numberCapability(CAPABILITIES.SET_POSITION, 0, 100, "%", { risk: "medium" })],
  robot_vacuum: [
    booleanCapability(CAPABILITIES.START_ROBOT, { risk: "medium" }),
    booleanCapability(CAPABILITIES.DOCK_ROBOT, { risk: "medium" }),
  ],
  washer: [
    booleanCapability(CAPABILITIES.START_CYCLE, { risk: "medium", confirmation: "always" }),
    booleanCapability(CAPABILITIES.STOP_CYCLE, { risk: "medium", confirmation: "always" }),
  ],
  dryer: [
    booleanCapability(CAPABILITIES.START_CYCLE, { risk: "medium", confirmation: "always" }),
    booleanCapability(CAPABILITIES.STOP_CYCLE, { risk: "medium", confirmation: "always" }),
  ],
  camera: [
    booleanCapability(CAPABILITIES.TURN_ON, { risk: "sensitive", confirmation: "always" }),
    booleanCapability(CAPABILITIES.TURN_OFF, { risk: "sensitive", confirmation: "always" }),
    booleanCapability(CAPABILITIES.SET_PRIVACY_MODE, { risk: "sensitive", confirmation: "always" }),
  ],
};

export function createDeviceManifest(device, source = "simulator") {
  const risk = device.risk ?? "low";
  const capabilities = (DEVICE_CAPABILITY_PROFILES[device.type] ?? []).map((capability) => ({
    ...capability,
    risk: capability.risk ?? risk,
    confirmation: capability.confirmation ?? RISK_CONFIRMATION[capability.risk ?? risk] ?? "never",
  }));

  return {
    id: device.id,
    name: device.name,
    roomId: device.roomId,
    type: device.type,
    source,
    risk,
    capabilities,
    state: pickDeviceState(device),
  };
}

export function createManifestRegistry(devices, source = "simulator") {
  return Object.fromEntries(
    Object.values(devices).map((device) => [device.id, createDeviceManifest(device, source)]),
  );
}

export function pickDeviceState(device) {
  const state = {};
  for (const key of STATE_KEYS) {
    if (key in device) state[key] = device[key];
  }
  state.online = device.online ?? true;
  return state;
}

export function summarizeManifestsForPlanner(devices) {
  return Object.values(devices).map((device) => {
    const manifest = createDeviceManifest(device);
    return {
      id: manifest.id,
      name: manifest.name,
      roomId: manifest.roomId,
      type: manifest.type,
      risk: manifest.risk,
      state: manifest.state,
      capabilities: manifest.capabilities.map((capability) => ({
        name: capability.name,
        valueType: capability.valueType,
        min: capability.min,
        max: capability.max,
        unit: capability.unit,
        risk: capability.risk,
        confirmation: capability.confirmation,
      })),
    };
  });
}

export function validateActionAgainstManifest(action, manifest) {
  if (!manifest) {
    return rejectAction(action, "unknown_device", `Unknown device ${action?.device_id ?? action?.deviceId}`);
  }

  const capabilityName = action.capability;
  const capability = manifest.capabilities.find((item) => item.name === capabilityName);
  if (!capability) {
    return rejectAction(action, "unsupported_capability", `${manifest.name} does not support ${capabilityName}`);
  }

  const value = normalizeCapabilityValue(action.value);
  const valueResult = validateCapabilityValue(value, capability);
  if (!valueResult.ok) {
    return rejectAction(action, valueResult.code, `${manifest.name} ${valueResult.message}`);
  }

  return {
    ok: true,
    action: {
      ...action,
      value,
      risk: capability.risk,
      confirmation: capability.confirmation,
    },
    capability,
    manifest,
  };
}

export function validatePlanSteps(steps, devices) {
  const manifests = createManifestRegistry(devices);
  const validSteps = [];
  const rejected = [];

  for (const step of steps) {
    const result = validateActionAgainstManifest(
      {
        device_id: step.deviceId,
        capability: step.capability,
        value: step.value,
      },
      manifests[step.deviceId],
    );

    if (!result.ok) {
      rejected.push({
        ...result,
        step,
      });
      continue;
    }

    validSteps.push({
      ...step,
      value: result.action.value,
      risk: result.action.risk,
      confirmation: result.action.confirmation,
    });
  }

  return { validSteps, rejected };
}

function validateCapabilityValue(value, capability) {
  if (capability.valueType === "boolean" && typeof value !== "boolean") {
    return { ok: false, code: "invalid_value_type", message: `${capability.name} expects boolean` };
  }

  if (capability.valueType === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return { ok: false, code: "invalid_value_type", message: `${capability.name} expects number` };
    }
    if (typeof capability.min === "number" && value < capability.min) {
      return { ok: false, code: "value_below_min", message: `${capability.name} below ${capability.min}` };
    }
    if (typeof capability.max === "number" && value > capability.max) {
      return { ok: false, code: "value_above_max", message: `${capability.name} above ${capability.max}` };
    }
  }

  return { ok: true };
}

function normalizeCapabilityValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function rejectAction(action, code, message) {
  return {
    ok: false,
    code,
    message,
    action,
  };
}

function booleanCapability(name, options = {}) {
  return {
    name,
    valueType: "boolean",
    ...options,
  };
}

function numberCapability(name, min, max, unit, options = {}) {
  return {
    name,
    valueType: "number",
    min,
    max,
    unit,
    ...options,
  };
}

function enumCapability(name, options, overrides = {}) {
  return {
    name,
    valueType: "enum",
    options,
    ...overrides,
  };
}
