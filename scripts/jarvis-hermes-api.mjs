#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHermesApiManager } from "../src/hermesApiManager.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "status";

if (!["prepare", "ensure-service", "disable-service", "ensure", "status", "stop"].includes(command)) {
  console.error("Usage: node scripts/jarvis-hermes-api.mjs <prepare|ensure-service|disable-service|ensure|status|stop>");
  process.exitCode = 2;
} else {
  try {
    const manager = createHermesApiManager({ repoRoot });
    const method = command === "ensure-service"
      ? "ensureService"
      : command === "disable-service"
        ? "disableService"
        : command;
    const result = await manager[method]();
    console.log(JSON.stringify(result, null, 2));
    if (["failed", "refused", "degraded", "stale"].includes(result.status)) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Hermes API ${command} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
