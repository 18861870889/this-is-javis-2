import { describe, expect, it } from "vitest";
import { createSimulatorAdapter, executePlan, executeStep, tick } from "./simulatorAdapter.js";
import { initialDevices, parseCommand, rooms } from "../simulator.js";
import { runProviderAdapterContract } from "./providerAdapterSdk.js";

describe("simulator adapter", () => {
  it("executes a validated plan against in-memory devices", () => {
    const devices = structuredClone(initialDevices);
    const plan = parseCommand("关客厅灯", devices, {
      currentRoomId: "living",
      selectedRoomId: "living",
    });

    const result = executePlan(plan, devices);

    expect(result.devices.living_light.on).toBe(false);
    expect(result.devices.living_light.brightness).toBe(0);
    expect(result.results).toEqual([
      expect.objectContaining({
        status: "executed",
        text: "客厅主灯: 关闭",
      }),
    ]);
  });

  it("returns a failed step result when a device is missing", () => {
    const result = executeStep(
      {
        deviceId: "missing_device",
        deviceName: "不存在的设备",
        capability: "turn_on",
        value: true,
      },
      structuredClone(initialDevices),
    );

    expect(result).toMatchObject({
      status: "failed",
      text: "未找到设备 不存在的设备",
    });
  });

  it("ticks long-running appliances and robot state", () => {
    const devices = structuredClone(initialDevices);
    devices.washer.status = "running";
    devices.washer.minutesLeft = 1;
    devices.robot.status = "cleaning";
    devices.robot.battery = 12;

    const next = tick(devices);

    expect(next.washer.status).toBe("done");
    expect(next.washer.minutesLeft).toBe(0);
    expect(next.robot.status).toBe("docked");
    expect(next.robot.battery).toBe(11);
  });

  it("passes the provider adapter contract without executing during the harness", async () => {
    const adapter = createSimulatorAdapter({ devices: initialDevices, spaces: rooms });
    const result = await runProviderAdapterContract(adapter, {
      sampleTargetId: "living_light",
      sampleAction: { deviceId: "living_light", capability: "turn_off", value: false },
    });

    expect(result.ok).toBe(true);
    expect((await adapter.readState("living_light")).on).toBe(true);
  });

  it("simulates before authorized execution and updates only its private store", async () => {
    const adapter = createSimulatorAdapter({ devices: initialDevices, spaces: rooms });
    const command = await adapter.compileAction({ deviceId: "living_light", capability: "turn_off", value: false });
    const simulation = await adapter.simulate(command);

    expect(simulation.ok).toBe(true);
    await expect(adapter.execute(command, { authorized: true, commandId: "cmd-1", simulation: { ok: false } })).rejects.toThrow(
      "successful simulation",
    );
    await adapter.execute(command, { authorized: true, commandId: "cmd-1", simulation });
    expect((await adapter.readState("living_light")).on).toBe(false);
    expect(initialDevices.living_light.on).toBe(true);
  });

  it("rejects offline devices and out-of-range actions in simulation or compilation", async () => {
    const devices = structuredClone(initialDevices);
    devices.living_light.online = false;
    const adapter = createSimulatorAdapter({ devices, spaces: rooms });
    const command = await adapter.compileAction({ deviceId: "living_light", capability: "turn_off", value: false });

    expect(await adapter.simulate(command)).toMatchObject({ ok: false, code: "offline" });
    await expect(adapter.compileAction({ deviceId: "living_light", capability: "set_brightness", value: 180 })).rejects.toThrow(
      "above 100",
    );
  });
});
