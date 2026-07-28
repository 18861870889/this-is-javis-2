import { describe, expect, it } from "vitest";
import {
  cleanupRejectedContainerStart,
  containerSafeEnvironment,
  containerStartupPhases,
  evaluateContainerStartupGate,
  inspectRejectedContainerState,
  redactSensitiveText,
} from "../scripts/jarvis-container.mjs";

describe("container startup gate", () => {
  it("always preflights dry-run before a real container launch", () => {
    expect(containerStartupPhases("real")).toEqual(["dry_run", "real"]);
    expect(containerStartupPhases("dry_run")).toEqual(["dry_run"]);
  });

  it("allows real mode only when every runtime dependency is green", () => {
    const result = evaluateContainerStartupGate({
      mode: "real",
      readiness: readyRuntime(),
    });

    expect(result).toEqual({
      executionMode: "real",
      allowed: true,
      shouldStop: false,
      state: "ready",
      failedChecks: [],
    });
  });

  it("blocks and requires cleanup when real mode is degraded", () => {
    const readiness = readyRuntime();
    readiness.ready = false;
    readiness.dependencies.homeAssistant.reachable = false;
    readiness.dependencies.homeAssistant.errorCode = "connection_failed";

    const result = evaluateContainerStartupGate({
      mode: "real",
      readiness,
    });

    expect(result).toEqual({
      executionMode: "real",
      allowed: false,
      shouldStop: true,
      state: "blocked",
      failedChecks: ["homeAssistant"],
    });
  });

  it("does not trust a top-level ready flag when a required check is not green", () => {
    const readiness = readyRuntime();
    readiness.dependencies.hermes.reachable = false;

    expect(evaluateContainerStartupGate({
      mode: "real",
      readiness,
    })).toMatchObject({
      allowed: false,
      shouldStop: true,
      failedChecks: ["hermes"],
    });
  });

  it("allows degraded dry-run mode without requesting cleanup", () => {
    const result = evaluateContainerStartupGate({
      mode: "dry_run",
      readiness: {
        ready: false,
        storage: { writable: true },
        dependencies: {
          hermes: { configured: true, reachable: false },
          homeAssistant: { configured: false, reachable: false },
        },
      },
    });

    expect(result).toEqual({
      executionMode: "dry_run",
      allowed: true,
      shouldStop: false,
      state: "degraded",
      failedChecks: ["hermes", "homeAssistant"],
    });
  });

  it("does not carry readiness secrets into the gate result", () => {
    const readiness = readyRuntime();
    readiness.dependencies.hermes.apiKey = "must-not-leak";
    readiness.dependencies.homeAssistant.token = "must-not-leak";

    expect(JSON.stringify(evaluateContainerStartupGate({
      mode: "real",
      readiness,
    }))).not.toContain("must-not-leak");
  });

  it("stops a container after a failed real-mode start", async () => {
    let stopCount = 0;
    let inspectCount = 0;

    await expect(cleanupRejectedContainerStart({
      mode: "real",
      startAttempted: true,
      stopContainer: async () => {
        stopCount += 1;
      },
      inspectContainerState: async () => {
        inspectCount += 1;
        return { exists: false, running: false, state: "absent" };
      },
    })).resolves.toBe(true);
    expect(stopCount).toBe(1);
    expect(inspectCount).toBe(1);
  });

  it("rejects cleanup when a silently failed stop leaves the container running", async () => {
    await expect(cleanupRejectedContainerStart({
      mode: "real",
      startAttempted: true,
      stopContainer: async () => undefined,
      inspectContainerState: async () => ({
        exists: true,
        running: true,
        state: "running",
      }),
    })).rejects.toThrow(/still running after stop\/remove/i);
  });

  it("accepts a stop failure when inspection confirms the container was already absent", async () => {
    await expect(cleanupRejectedContainerStart({
      mode: "real",
      startAttempted: true,
      stopContainer: async () => {
        throw new Error("container not found");
      },
      inspectContainerState: async () => ({
        exists: false,
        running: false,
        state: "absent",
      }),
    })).resolves.toBe(true);
  });

  it("accepts cleanup only for an explicit stable non-running state", async () => {
    await expect(cleanupRejectedContainerStart({
      mode: "real",
      startAttempted: true,
      stopContainer: async () => undefined,
      inspectContainerState: async () => ({
        exists: true,
        running: false,
        state: "stopped",
      }),
    })).resolves.toBe(true);

    await expect(cleanupRejectedContainerStart({
      mode: "real",
      startAttempted: true,
      stopContainer: async () => undefined,
      inspectContainerState: async () => ({
        exists: true,
        running: false,
        state: "restarting",
      }),
    })).rejects.toThrow(/could not confirm an absent or non-running container/i);
  });

  it("rejects cleanup when post-stop state cannot be inspected", async () => {
    await expect(cleanupRejectedContainerStart({
      mode: "real",
      startAttempted: true,
      stopContainer: async () => undefined,
      inspectContainerState: async () => {
        throw new Error("inspection unavailable");
      },
    })).rejects.toThrow(/cleanup could not be verified.*inspection unavailable/i);
  });

  it("maps Apple Container inspection only to confirmed lifecycle states", () => {
    expect(inspectRejectedContainerState("apple", () => ({
      status: 0,
      stdout: JSON.stringify([{ status: { state: "stopped" } }]),
      stderr: "",
    }))).toEqual({
      exists: true,
      running: false,
      state: "stopped",
    });

    expect(() => inspectRejectedContainerState("apple", () => ({
      status: 0,
      stdout: JSON.stringify([{ status: { state: "unknown" } }]),
      stderr: "",
    }))).toThrow(/unconfirmed state: unknown/i);
  });

  it("reads exact Docker states and rejects transitional cleanup states", () => {
    const inspectExited = (executable, args) => {
      expect(executable).toBe("docker");
      if (args[0] === "compose") {
        return { status: 0, stdout: "container-a\ncontainer-b\n", stderr: "" };
      }
      expect(args).toEqual([
        "inspect",
        "--format",
        "{{.State.Status}}",
        "container-a",
        "container-b",
      ]);
      return { status: 0, stdout: "exited\ncreated\n", stderr: "" };
    };
    expect(inspectRejectedContainerState("docker", inspectExited)).toEqual({
      exists: true,
      running: false,
      state: "exited",
      states: ["exited", "created"],
    });

    const inspectRestarting = (_executable, args) => (
      args[0] === "compose"
        ? { status: 0, stdout: "container-a\n", stderr: "" }
        : { status: 0, stdout: "restarting\n", stderr: "" }
    );
    expect(() => inspectRejectedContainerState(
      "docker",
      inspectRestarting,
    )).toThrow(/unconfirmed state: restarting/i);
  });

  it("leaves a degraded dry-run container available for diagnosis", async () => {
    let stopCount = 0;

    await expect(cleanupRejectedContainerStart({
      mode: "dry_run",
      startAttempted: true,
      stopContainer: async () => {
        stopCount += 1;
      },
    })).resolves.toBe(false);
    expect(stopCount).toBe(0);
  });

  it("redacts credentials from container command failures", () => {
    const output = redactSensitiveText(
      "container run --env HERMES_API_KEY=secret-value "
      + "--env HA_TOKEN=another-secret Authorization: Bearer third-secret",
    );

    expect(output).toContain("HERMES_API_KEY=<redacted>");
    expect(output).toContain("HA_TOKEN=<redacted>");
    expect(output).toContain("Authorization: Bearer <redacted>");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("another-secret");
    expect(output).not.toContain("third-secret");
  });

  it("passes only an explicit non-secret configuration allowlist into containers", () => {
    const safe = containerSafeEnvironment({
      env: {
        HA_BASE_URL: "http://homeassistant.local:8123",
        HA_TOKEN: "must-not-enter-container-config",
        HERMES_API_KEY: "must-not-enter-container-config",
        XIAOZHI_MCP_ENDPOINT: "wss://example.test/?token=must-not-enter-container-config",
        JARVIS_STACKCHAN_DEVICE_ROOMS: '{"device-a":"second"}',
      },
      envFile: {},
    });

    expect(safe).toEqual({
      HA_BASE_URL: "http://homeassistant.local:8123",
      JARVIS_STACKCHAN_DEVICE_ROOMS: '{"device-a":"second"}',
    });
    expect(JSON.stringify(safe)).not.toContain("must-not-enter-container-config");
  });

  it("rejects newline injection in passthrough environment values", () => {
    expect(() => containerSafeEnvironment({
      env: {
        HA_BASE_URL: "http://homeassistant.local:8123\nHA_TOKEN=injected",
      },
      envFile: {},
    })).toThrow(/unsafe character/);
  });
});

function readyRuntime() {
  return {
    ready: true,
    storage: { writable: true },
    dependencies: {
      hermes: { configured: true, reachable: true, errorCode: null },
      homeAssistant: { configured: true, reachable: true, errorCode: null },
    },
  };
}
