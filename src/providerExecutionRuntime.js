export async function simulateProviderExecutionPlan({ adapter, accepted = [], home } = {}) {
  if (!adapter) throw new Error("provider adapter is required");
  const checks = [];

  for (const item of accepted) {
    try {
      const command = await adapter.compileAction({
        deviceId: item.action?.targetId ?? item.action?.thingId,
        entityId: item.action?.entityId,
        thingId: item.thing?.id,
        capability: item.capability?.id,
        capabilityId: item.capability?.id,
        value: item.action?.value,
        serviceCall: item.serviceCall,
        evidence: item.capability?.evidence,
      });
      const simulation = await adapter.simulate(command, { home, item });
      checks.push({
        ...simulation,
        thingId: item.thing?.id,
        thingName: item.thing?.name,
        capabilityId: item.capability?.id,
        capabilityName: item.capability?.name,
        service: command.operation,
        command,
        action: item.action,
      });
    } catch (error) {
      checks.push({
        ok: false,
        code: "provider_compile_failed",
        message: error.message,
        thingId: item.thing?.id,
        thingName: item.thing?.name,
        capabilityId: item.capability?.id,
        capabilityName: item.capability?.name,
        action: item.action,
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    providerId: adapter.id,
    checks,
    rejected: checks.filter((check) => !check.ok).map((check) => ({
      ok: false,
      code: check.code,
      message: check.message,
      thingId: check.thingId,
      thingName: check.thingName,
      capabilityId: check.capabilityId,
      capabilityName: check.capabilityName,
      action: check.action,
      service: check.service,
    })),
  };
}

export async function executeSimulatedProviderPlan({ adapter, simulation, commandId } = {}) {
  if (!adapter) throw new Error("provider adapter is required");
  if (!commandId) throw new Error("commandId is required");
  const results = [];

  for (const check of simulation?.checks ?? []) {
    if (!check.ok || !check.command) continue;
    try {
      const result = await adapter.execute(check.command, {
        authorized: true,
        commandId,
        simulation: check,
      });
      results.push({
        ok: true,
        thingId: check.thingId,
        thingName: check.thingName,
        capabilityId: check.capabilityId,
        capabilityName: check.capabilityName,
        providerId: check.command.providerId,
        targetId: check.command.target?.id,
        service: check.command.operation,
        serviceData: check.command.payload,
        simulation: summarizeSimulation(check),
        result,
      });
    } catch (error) {
      results.push({
        ok: false,
        thingId: check.thingId,
        thingName: check.thingName,
        capabilityId: check.capabilityId,
        capabilityName: check.capabilityName,
        providerId: check.command.providerId,
        targetId: check.command.target?.id,
        service: check.command.operation,
        serviceData: check.command.payload,
        error: error.message,
      });
    }
  }
  return results;
}

export async function verifyProviderExecutionResults({ adapter, results = [], wait = defaultWait } = {}) {
  if (!adapter) throw new Error("provider adapter is required");
  const verified = [];
  for (const result of results) {
    const targetId = result.serviceData?.entity_id ?? result.targetId;
    if (!result.ok || !targetId) {
      verified.push({ ...result, verification: { ok: false, code: "execution_failed", message: result.error ?? "执行失败" } });
      continue;
    }
    const expected = expectedState(result.service);
    if (!expected) {
      verified.push({ ...result, verification: { ok: true, code: "not_verifiable", message: "该服务暂无通用状态断言" } });
      continue;
    }
    try {
      let state = await adapter.readState(targetId);
      if (!expected.includes(normalizeProviderState(state))) {
        await wait(150);
        state = await adapter.readState(targetId);
      }
      const actual = normalizeProviderState(state);
      const ok = expected.includes(actual);
      verified.push({
        ...result,
        verification: {
          ok,
          code: ok ? "state_converged" : "state_mismatch",
          expected,
          actual,
          targetId,
          message: ok ? "Provider 状态已收敛到目标值" : `Provider 回读状态 ${actual} 与目标不一致`,
        },
      });
    } catch (error) {
      verified.push({
        ...result,
        verification: {
          ok: false,
          code: "state_read_failed",
          expected,
          actual: "unknown",
          targetId,
          message: `设备可能已执行，但 Provider 状态回读失败：${error.message}`,
        },
      });
    }
  }
  return verified;
}

function summarizeSimulation(check) {
  return {
    ok: check.ok,
    code: check.code,
    message: check.message,
    commandFingerprint: check.commandFingerprint,
  };
}

function expectedState(service) {
  if (/\.turn_on$/.test(service)) return ["on", "playing"];
  if (/\.turn_off$/.test(service)) return ["off", "idle", "paused", "standby"];
  if (/\.on$/.test(service)) return ["on"];
  if (/\.off$/.test(service)) return ["off"];
  if (/\.open_cover$/.test(service)) return ["open", "opening"];
  if (/\.close_cover$/.test(service)) return ["closed", "closing"];
  return null;
}

function normalizeProviderState(state) {
  if (typeof state?.state === "string") return state.state;
  if (typeof state?.on === "boolean") return state.on ? "on" : "off";
  return "unknown";
}

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
