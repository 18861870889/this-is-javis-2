export const PROVIDER_ADAPTER_CONTRACT_VERSION = "1.0";
export const PROVIDER_SNAPSHOT_VERSION = "1.0";

const REQUIRED_METHODS = [
  "identity",
  "getConnectionStatus",
  "discoverSnapshot",
  "discoverHcmHome",
  "compileAction",
  "simulate",
  "execute",
  "readState",
];

export function defineProviderAdapter(adapter) {
  const result = validateProviderAdapter(adapter);
  if (!result.ok) throw new Error(`Invalid provider adapter: ${result.errors.join("; ")}`);
  return Object.freeze({
    contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
    ...adapter,
  });
}

export function validateProviderAdapter(adapter) {
  const errors = [];
  if (!adapter || typeof adapter !== "object") return { ok: false, errors: ["adapter must be an object"] };
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") errors.push(`${method} must be a function`);
  }
  if (adapter.subscribe !== undefined && typeof adapter.subscribe !== "function") {
    errors.push("subscribe must be a function when provided");
  }
  return { ok: errors.length === 0, errors };
}

export function createProviderIdentity({ id, name, version = "unknown", transport = "unknown" } = {}) {
  if (!isStableId(id)) throw new Error("provider identity id is required and must be stable");
  if (!name || typeof name !== "string") throw new Error("provider identity name is required");
  return { id, name, version, transport };
}

export function createProviderSnapshotEnvelope({
  provider,
  capturedAt = new Date().toISOString(),
  spaces = [],
  devices = [],
  entities = [],
  states = [],
  metadata = {},
} = {}) {
  const identity = createProviderIdentity(provider);
  const snapshot = {
    version: PROVIDER_SNAPSHOT_VERSION,
    provider: identity,
    capturedAt,
    spaces: normalizeRecords(spaces, "space"),
    devices: normalizeRecords(devices, "device"),
    entities: normalizeRecords(entities, "entity"),
    states: normalizeStates(states),
    metadata: sanitizeMetadata(metadata),
  };
  assertUniqueIds(snapshot.spaces, "space");
  assertUniqueIds(snapshot.devices, "device");
  assertUniqueIds(snapshot.entities, "entity");
  assertUniqueIds(snapshot.states, "state target");
  return snapshot;
}

export function createCapabilityEvidence({
  providerId,
  targetId,
  source = "provider_snapshot",
  capability,
  observations = {},
  commands = [],
  constraints = {},
  confidence = 0.5,
  observedAt,
} = {}) {
  if (!isStableId(providerId)) throw new Error("capability evidence providerId is required");
  if (!targetId || typeof targetId !== "string") throw new Error("capability evidence targetId is required");
  if (!capability || typeof capability !== "string") throw new Error("capability evidence capability is required");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("capability evidence confidence must be between 0 and 1");
  }
  return {
    version: PROVIDER_ADAPTER_CONTRACT_VERSION,
    providerId,
    targetId,
    source,
    capability,
    observations: sanitizeMetadata(observations),
    commands: Array.from(new Set(commands.filter((command) => typeof command === "string"))),
    constraints: sanitizeMetadata(constraints),
    confidence,
    observedAt,
  };
}

export function createProviderCommand({
  providerId,
  target,
  operation,
  payload = {},
  evidence,
  idempotencyKey,
} = {}) {
  if (!isStableId(providerId)) throw new Error("provider command providerId is required");
  if (!target?.id || !target?.type) throw new Error("provider command target id and type are required");
  if (!operation || typeof operation !== "string") throw new Error("provider command operation is required");
  const command = {
    version: PROVIDER_ADAPTER_CONTRACT_VERSION,
    providerId,
    target: { id: target.id, type: target.type },
    operation,
    payload: sanitizeMetadata(payload),
    evidence: evidence ?? null,
    idempotencyKey: idempotencyKey ?? null,
  };
  return { ...command, fingerprint: fingerprintProviderCommand(command) };
}

export function assertAuthorizedProviderExecution(context = {}, command) {
  if (context.authorized !== true) throw new Error("provider execution requires an authorized runtime context");
  if (context.simulation?.ok !== true) throw new Error("provider execution requires a successful simulation result");
  if (!command?.fingerprint || context.simulation.commandFingerprint !== command.fingerprint) {
    throw new Error("provider execution simulation does not match the command fingerprint");
  }
  if (!context.commandId || typeof context.commandId !== "string") {
    throw new Error("provider execution requires a commandId for audit");
  }
}

export async function runProviderAdapterContract(adapter, { sampleAction, sampleTargetId } = {}) {
  const checks = [];
  const shape = validateProviderAdapter(adapter);
  checks.push(check("contract_shape", shape.ok, shape.errors.join("; ")));
  if (!shape.ok) return contractResult(checks);

  const identity = await adapter.identity();
  checks.push(check("stable_identity", isStableId(identity?.id) && Boolean(identity?.name), "provider identity is invalid"));

  const status = await adapter.getConnectionStatus();
  checks.push(check("connection_status", typeof status?.state === "string", "connection status state is required"));

  const first = await adapter.discoverSnapshot();
  const second = await adapter.discoverSnapshot();
  checks.push(check("snapshot_schema", validateSnapshot(first).ok, validateSnapshot(first).errors.join("; ")));
  checks.push(check("stable_snapshot_ids", sameRecordIds(first, second), "snapshot identities changed without a provider change"));

  const home = await adapter.discoverHcmHome();
  checks.push(check(
    "hcm_mapping",
    home?.provider?.id === identity.id && Array.isArray(home?.spaces) && Array.isArray(home?.things),
    "discoverHcmHome must return HCM owned by the same provider",
  ));

  if (sampleTargetId) {
    const state = await adapter.readState(sampleTargetId);
    checks.push(check("read_state", state !== undefined && state !== null, "readState returned no state"));
  }

  if (sampleAction) {
    const command = await adapter.compileAction(sampleAction);
    checks.push(check("compile_action", Boolean(command?.providerId && command?.operation), "compileAction returned an invalid command"));
    const simulation = await adapter.simulate(command);
    checks.push(check(
      "simulation",
      typeof simulation?.ok === "boolean" && simulation.commandFingerprint === command.fingerprint,
      "simulate must return an explicit ok value bound to the command fingerprint",
    ));
  }

  return contractResult(checks);
}

export function fingerprintProviderCommand(command) {
  const text = JSON.stringify({
    version: command?.version,
    providerId: command?.providerId,
    target: command?.target,
    operation: command?.operation,
    payload: command?.payload,
    idempotencyKey: command?.idempotencyKey,
  });
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function diffProviderSnapshots(previous, next) {
  const firstValidation = validateSnapshot(previous);
  const nextValidation = validateSnapshot(next);
  if (!firstValidation.ok) throw new Error(`Invalid previous provider snapshot: ${firstValidation.errors.join("; ")}`);
  if (!nextValidation.ok) throw new Error(`Invalid next provider snapshot: ${nextValidation.errors.join("; ")}`);
  if (previous.provider.id !== next.provider.id) throw new Error("provider snapshot diff requires the same provider identity");

  const events = [];
  for (const collection of ["spaces", "devices", "entities", "states"]) {
    const idKey = collection === "states" ? "targetId" : "externalId";
    const before = new Map(previous[collection].map((record) => [record[idKey], record]));
    const after = new Map(next[collection].map((record) => [record[idKey], record]));
    for (const [id, record] of after) {
      if (!before.has(id)) {
        events.push({ type: `${singular(collection)}.added`, id, record });
      } else if (JSON.stringify(before.get(id)) !== JSON.stringify(record)) {
        events.push({ type: `${singular(collection)}.changed`, id, before: before.get(id), record });
      }
    }
    for (const [id, record] of before) {
      if (!after.has(id)) events.push({ type: `${singular(collection)}.removed`, id, record });
    }
  }

  return {
    version: PROVIDER_ADAPTER_CONTRACT_VERSION,
    providerId: next.provider.id,
    previousCapturedAt: previous.capturedAt,
    capturedAt: next.capturedAt,
    summary: events.reduce((summary, event) => {
      summary.total += 1;
      summary.byType[event.type] = (summary.byType[event.type] ?? 0) + 1;
      return summary;
    }, { total: 0, byType: {} }),
    events,
  };
}

export function validateSnapshot(snapshot) {
  const errors = [];
  if (snapshot?.version !== PROVIDER_SNAPSHOT_VERSION) errors.push("unsupported snapshot version");
  if (!isStableId(snapshot?.provider?.id)) errors.push("snapshot provider id is invalid");
  for (const key of ["spaces", "devices", "entities", "states"]) {
    if (!Array.isArray(snapshot?.[key])) errors.push(`${key} must be an array`);
  }
  if (errors.length === 0) {
    for (const [key, label] of [["spaces", "space"], ["devices", "device"], ["entities", "entity"], ["states", "state target"]]) {
      const ids = snapshot[key].map((record) => record.externalId ?? record.targetId);
      if (ids.some((id) => !id)) errors.push(`${label} id is required`);
      if (new Set(ids).size !== ids.length) errors.push(`${label} ids must be unique`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function normalizeRecords(records, kind) {
  return records.map((record) => {
    const externalId = record?.externalId ?? record?.id;
    if (!externalId || typeof externalId !== "string") throw new Error(`${kind} externalId is required`);
    return {
      externalId,
      name: record.name ?? externalId,
      deviceId: record.deviceId,
      spaceId: record.spaceId,
      type: record.type,
      disabled: Boolean(record.disabled),
      metadata: sanitizeMetadata(record.metadata ?? {}),
    };
  });
}

function normalizeStates(states) {
  return states.map((state) => {
    const targetId = state?.targetId ?? state?.externalId ?? state?.entityId;
    if (!targetId || typeof targetId !== "string") throw new Error("state targetId is required");
    return {
      targetId,
      value: state.value ?? state.state,
      online: state.online ?? !["unavailable", "unknown"].includes(state.value ?? state.state),
      attributes: sanitizeMetadata(state.attributes ?? {}),
      observedAt: state.observedAt,
    };
  });
}

function sanitizeMetadata(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => sanitizeMetadata(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|authorization|api[_-]?key/i.test(key)) continue;
    result[key] = sanitizeMetadata(item, depth + 1);
  }
  return result;
}

function assertUniqueIds(records, label) {
  const ids = records.map((record) => record.externalId ?? record.targetId);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ids must be unique`);
}

function sameRecordIds(first, second) {
  if (!first || !second) return false;
  return ["spaces", "devices", "entities", "states"].every((key) => {
    const ids = (snapshot) => snapshot[key].map((record) => record.externalId ?? record.targetId).sort().join("|");
    return ids(first) === ids(second);
  });
}

function isStableId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_.-]*$/i.test(value);
}

function check(name, ok, error = "") {
  return { name, ok: Boolean(ok), error: ok ? null : error };
}

function contractResult(checks) {
  return {
    ok: checks.every((item) => item.ok),
    contractVersion: PROVIDER_ADAPTER_CONTRACT_VERSION,
    checks,
  };
}

function singular(collection) {
  if (collection === "entities") return "entity";
  return collection.slice(0, -1);
}
