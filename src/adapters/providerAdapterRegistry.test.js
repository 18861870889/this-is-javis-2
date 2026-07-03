import { describe, expect, it } from "vitest";
import { createProviderAdapterRegistry } from "./providerAdapterRegistry.js";
import { createProviderAdapterTemplate } from "./providerAdapterTemplate.js";
import { createProviderSnapshotEnvelope } from "./providerAdapterSdk.js";

function fixtureAdapter(id = "fixture") {
  return createProviderAdapterTemplate({
    provider: { id, name: "Fixture", version: "1", transport: "memory" },
    driver: {
      discoverSnapshot: async () => createProviderSnapshotEnvelope({
        provider: { id, name: "Fixture", version: "1", transport: "memory" },
      }),
      discoverHcmHome: async () => ({ version: "0.1", provider: { id, name: "Fixture" }, spaces: [], things: [] }),
      readState: async () => ({}),
      compileAction: async () => ({}),
      simulate: async () => ({ ok: true }),
      execute: async () => ({ status: "executed" }),
    },
  });
}

describe("provider adapter registry", () => {
  it("lists provider identities and connection state without provider secrets", async () => {
    const registry = createProviderAdapterRegistry([fixtureAdapter()]);

    expect(await registry.list()).toEqual([expect.objectContaining({
      contractVersion: "1.0",
      identity: { id: "fixture", name: "Fixture", version: "1", transport: "memory" },
      connection: { state: "configured", configured: true },
    })]);
  });

  it("rejects duplicate and unknown providers", () => {
    const adapter = fixtureAdapter();
    const registry = createProviderAdapterRegistry([adapter]);

    expect(() => registry.register(adapter)).toThrow("already registered");
    expect(() => registry.get("missing")).toThrow("not registered");
  });
});
