import { describe, expect, it, vi } from "vitest";
import {
  createCapabilityEvidence,
  createProviderCommand,
  createProviderSnapshotEnvelope,
  diffProviderSnapshots,
  runProviderAdapterContract,
  validateProviderAdapter,
} from "./providerAdapterSdk.js";
import { createProviderAdapterTemplate } from "./providerAdapterTemplate.js";

function createFixtureAdapter() {
  const execute = vi.fn(async () => ({ status: "executed" }));
  const snapshot = createProviderSnapshotEnvelope({
    provider: { id: "fixture", name: "Fixture Provider", version: "1", transport: "memory" },
    spaces: [{ externalId: "living", name: "客厅" }],
    devices: [{ externalId: "lamp-1", name: "测试灯", spaceId: "living", type: "light" }],
    entities: [{ externalId: "lamp-1:power", name: "开关", deviceId: "lamp-1", type: "switch" }],
    states: [{ targetId: "lamp-1", value: { on: false }, online: true }],
    metadata: { token: "must-not-leak", region: "local" },
  });
  return {
    execute,
    adapter: createProviderAdapterTemplate({
      provider: { id: "fixture", name: "Fixture Provider", version: "1", transport: "memory" },
      driver: {
        discoverSnapshot: async () => structuredClone(snapshot),
        discoverHcmHome: async () => ({
          version: "0.1",
          provider: { id: "fixture", name: "Fixture Provider" },
          spaces: [],
          things: [],
        }),
        readState: async () => ({ on: false }),
        compileAction: async (action) => createProviderCommand({
          providerId: "fixture",
          target: { id: action.deviceId, type: "device" },
          operation: action.capability,
          payload: { value: action.value },
        }),
        simulate: async () => ({ ok: true, mode: "simulation" }),
        execute,
      },
    }),
  };
}

describe("provider adapter sdk", () => {
  it("rejects adapters that do not implement the common contract", () => {
    const result = validateProviderAdapter({ identity() {} });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("discoverSnapshot must be a function");
    expect(result.errors).toContain("execute must be a function");
  });

  it("normalizes snapshots and removes secret metadata", () => {
    const snapshot = createProviderSnapshotEnvelope({
      provider: { id: "fixture", name: "Fixture", version: "1", transport: "memory" },
      devices: [{ externalId: "device-1", name: "Device", metadata: { apiKey: "secret", model: "A1" } }],
      states: [{ targetId: "device-1", value: "on", attributes: { password: "secret", signal: 90 } }],
      metadata: { authorization: "Bearer secret", site: "home" },
    });

    expect(snapshot.metadata).toEqual({ site: "home" });
    expect(snapshot.devices[0].metadata).toEqual({ model: "A1" });
    expect(snapshot.states[0].attributes).toEqual({ signal: 90 });
  });

  it("rejects duplicate provider identities in one snapshot", () => {
    expect(() => createProviderSnapshotEnvelope({
      provider: { id: "fixture", name: "Fixture", version: "1", transport: "memory" },
      devices: [{ externalId: "same" }, { externalId: "same" }],
    })).toThrow("device ids must be unique");
  });

  it("validates capability evidence confidence", () => {
    expect(createCapabilityEvidence({
      providerId: "fixture",
      targetId: "device-1",
      capability: "turn_on",
      confidence: 0.9,
    })).toMatchObject({ providerId: "fixture", targetId: "device-1", confidence: 0.9 });
    expect(() => createCapabilityEvidence({
      providerId: "fixture",
      targetId: "device-1",
      capability: "turn_on",
      confidence: 1.1,
    })).toThrow("between 0 and 1");
  });

  it("runs discovery and simulation contract checks without executing", async () => {
    const { adapter, execute } = createFixtureAdapter();
    const result = await runProviderAdapterContract(adapter, {
      sampleTargetId: "lamp-1",
      sampleAction: { deviceId: "lamp-1", capability: "turn_on", value: true },
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toContain("stable_snapshot_ids");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires authorization, simulation and audit identity before execution", async () => {
    const { adapter, execute } = createFixtureAdapter();
    const command = await adapter.compileAction({ deviceId: "lamp-1", capability: "turn_on", value: true });

    await expect(adapter.execute(command, {})).rejects.toThrow("authorized runtime context");
    await expect(adapter.execute(command, { authorized: true, commandId: "cmd-1", simulation: { ok: false } })).rejects.toThrow(
      "successful simulation",
    );
    await expect(adapter.execute(command, {
      authorized: true,
      commandId: "cmd-1",
      simulation: { ok: true, commandFingerprint: "different" },
    })).rejects.toThrow("does not match");
    const simulation = await adapter.simulate(command);
    await adapter.execute(command, { authorized: true, commandId: "cmd-1", simulation });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("diffs provider-neutral snapshots by stable identity", () => {
    const base = createProviderSnapshotEnvelope({
      provider: { id: "fixture", name: "Fixture", version: "1", transport: "memory" },
      devices: [{ externalId: "lamp-1", name: "旧名称", spaceId: "living" }],
      states: [{ targetId: "lamp-1", value: "off" }],
    });
    const next = createProviderSnapshotEnvelope({
      provider: { id: "fixture", name: "Fixture", version: "1", transport: "memory" },
      devices: [
        { externalId: "lamp-1", name: "新名称", spaceId: "study" },
        { externalId: "fan-1", name: "新风扇", spaceId: "study" },
      ],
      states: [{ targetId: "lamp-1", value: "on" }, { targetId: "fan-1", value: "off" }],
    });

    const diff = diffProviderSnapshots(base, next);

    expect(diff.summary.byType).toMatchObject({
      "device.changed": 1,
      "device.added": 1,
      "state.changed": 1,
      "state.added": 1,
    });
  });
});
