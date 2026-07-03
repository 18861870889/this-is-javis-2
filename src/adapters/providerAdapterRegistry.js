import { validateProviderAdapter } from "./providerAdapterSdk.js";

export function createProviderAdapterRegistry(initialAdapters = []) {
  const adapters = new Map();

  const registry = {
    register(adapter) {
      const validation = validateProviderAdapter(adapter);
      if (!validation.ok) throw new Error(`Cannot register provider adapter: ${validation.errors.join("; ")}`);
      if (!adapter.id || typeof adapter.id !== "string") throw new Error("provider adapter id is required");
      if (adapters.has(adapter.id)) throw new Error(`provider adapter ${adapter.id} is already registered`);
      adapters.set(adapter.id, adapter);
      return adapter;
    },
    get(providerId) {
      const adapter = adapters.get(providerId);
      if (!adapter) throw new Error(`provider adapter ${providerId} is not registered`);
      return adapter;
    },
    has(providerId) {
      return adapters.has(providerId);
    },
    async list() {
      return Promise.all(Array.from(adapters.values()).map(async (adapter) => ({
        contractVersion: adapter.contractVersion,
        identity: await adapter.identity(),
        connection: await adapter.getConnectionStatus(),
      })));
    },
    async discoverHcmHome(providerId) {
      return registry.get(providerId).discoverHcmHome();
    },
  };

  for (const adapter of initialAdapters) registry.register(adapter);
  return Object.freeze(registry);
}
