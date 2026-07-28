import { describe, expect, it } from "vitest";
import {
  isExpectedXiaozhiCommand,
  validateXiaozhiJarvisConfig,
} from "../scripts/jarvis-xiaozhi-host.mjs";

describe("xiaozhiHostManager", () => {
  it("requires JarvisLLM, nointent, authentication, and a device allowlist", () => {
    expect(validateXiaozhiJarvisConfig({
      selected_module: { LLM: "JarvisLLM", Intent: "nointent" },
      server: {
        auth: {
          enabled: true,
          allowed_devices: ["device-a"],
        },
      },
    })).toMatchObject({
      ok: true,
      allowedDeviceCount: 1,
    });

    const rejected = validateXiaozhiJarvisConfig({
      selected_module: { LLM: "Other", Intent: "function_call" },
      server: { auth: { enabled: false, allowed_devices: [] } },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.failures).toHaveLength(4);
  });

  it("recognizes only the expected app.py process inside the configured root", () => {
    const root = "/opt/xiaozhi/main/xiaozhi-server";
    expect(isExpectedXiaozhiCommand(
      "/opt/xiaozhi/main/xiaozhi-server/.venv/bin/python app.py",
      { root },
    )).toBe(true);
    expect(isExpectedXiaozhiCommand(
      "/opt/other/.venv/bin/python app.py",
      { root },
    )).toBe(false);
    expect(isExpectedXiaozhiCommand(
      "/opt/xiaozhi/main/xiaozhi-server/.venv/bin/python worker.py",
      { root },
    )).toBe(false);
  });
});
