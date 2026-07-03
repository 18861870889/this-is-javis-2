import {
  assertAuthorizedProviderExecution,
  createProviderIdentity,
  defineProviderAdapter,
} from "./providerAdapterSdk.js";

export function createProviderAdapterTemplate({ provider, driver } = {}) {
  const identity = createProviderIdentity(provider);
  if (!driver || typeof driver !== "object") throw new Error("provider adapter driver is required");
  for (const method of ["discoverSnapshot", "discoverHcmHome", "compileAction", "simulate", "execute", "readState"]) {
    if (typeof driver[method] !== "function") throw new Error(`provider adapter driver.${method} is required`);
  }

  return defineProviderAdapter({
    id: identity.id,
    identity: async () => identity,
    getConnectionStatus: async () =>
      driver.getConnectionStatus?.() ?? { state: "configured", configured: true },
    discoverSnapshot: () => driver.discoverSnapshot(),
    discoverHcmHome: () => driver.discoverHcmHome(),
    compileAction: (action) => driver.compileAction(action),
    async simulate(command) {
      return { ...(await driver.simulate(command)), commandFingerprint: command.fingerprint };
    },
    readState: (targetId) => driver.readState(targetId),
    async execute(command, context) {
      assertAuthorizedProviderExecution(context, command);
      return driver.execute(command, context);
    },
    ...(typeof driver.subscribe === "function" ? { subscribe: (handler) => driver.subscribe(handler) } : {}),
  });
}
