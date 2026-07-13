import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

const scenario = args.values.scenario || process.env.STACKCHAN_PHYSICAL_SESSION_SCENARIO || "home-state";
const timeoutMs = positiveInteger(args.values["timeout-ms"] || process.env.STACKCHAN_PHYSICAL_SESSION_TIMEOUT_MS, 180_000);
const timestamp = compactTimestamp(new Date());
const sessionRoot = resolvePath(args.values["session-root"] || process.env.STACKCHAN_PHYSICAL_SESSION_ROOT || "data/stackchan-physical-sessions");
const sessionDir = resolve(sessionRoot, `${timestamp}-${scenario}`);
const devicePort = args.values.port || process.env.STACKCHAN_PORT || findDevicePort();
const baud = positiveInteger(args.values.baud || process.env.STACKCHAN_SERIAL_BAUD, 115_200);
const idfExport = args.values["idf-export"] || process.env.IDF_EXPORT || findIdfExport();
const firmwareRoot = resolvePath(args.values["firmware-root"] || process.env.STACKCHAN_FIRMWARE_ROOT || "../stackchan-jarvis-firmware/firmware");
const requireTrigger = !args.flags.has("no-require-trigger") && process.env.STACKCHAN_PHYSICAL_SESSION_REQUIRE_TRIGGER !== "false";
const requireRealHa = args.flags.has("require-real-ha") || process.env.STACKCHAN_PHYSICAL_SESSION_REQUIRE_REAL_HA === "true";
const noSerial = args.flags.has("no-serial") || process.env.STACKCHAN_PHYSICAL_SESSION_NO_SERIAL === "true";
const watcherJson = args.flags.has("json") || process.env.STACKCHAN_PHYSICAL_SESSION_JSON === "true";
const dryRun = args.flags.has("dry-run") || process.env.STACKCHAN_PHYSICAL_SESSION_DRY_RUN === "true";
const pcFile = args.values["pc-file"] || process.env.STACKCHAN_VOICE_WATCH_PC_FILE || defaultPcFile(scenario, timestamp);
const expectText = args.values["expect-text"] || process.env.STACKCHAN_VOICE_WATCH_EXPECT_TEXT || defaultExpectText(scenario, pcFile);
const expectPcContent = args.values["expect-pc-content"] || process.env.STACKCHAN_VOICE_WATCH_EXPECT_PC_CONTENT || "helloworld";
const externalSerialLog = args.values["serial-log"] || process.env.STACKCHAN_VOICE_WATCH_SERIAL_LOG || "";

const children = new Set();

process.on("SIGINT", () => {
  stopChildren();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stopChildren();
  process.exit(143);
});

mkdirSync(sessionDir, { recursive: true });

const serialLog = externalSerialLog ? resolvePath(externalSerialLog) : resolve(sessionDir, "stackchan-serial.log");
const watcherLog = resolve(sessionDir, watcherJson ? "watcher.json" : "watcher.log");
const statusLog = resolve(sessionDir, "precheck.log");
const instructionsPath = resolve(sessionDir, "instructions.md");

const precheck = [
  ["jarvis stack status", spawnText("npm", ["run", "jarvis:stack:status"])],
  ["jarvis runtime status", await httpText("http://127.0.0.1:5183/api/runtime/status")],
  ["xiaozhi ota", await httpText("http://127.0.0.1:8003/xiaozhi/ota/")],
];

writeFileSync(statusLog, precheck.map(([label, output]) => `## ${label}\n${output.trim() || "(empty)"}\n`).join("\n"), "utf8");
writeFileSync(instructionsPath, buildInstructions(), "utf8");

printSessionHeader();

if (dryRun) {
  console.log("");
  console.log("Session dry-run complete. Watcher and serial capture were not started.");
  console.log(`Session artifacts: ${sessionDir}`);
  process.exit(0);
}

let serialProcess = null;
if (!noSerial && !externalSerialLog && existsSync(devicePort) && existsSync(idfExport)) {
  serialProcess = startSerialCapture(serialLog);
  await sleep(800);
} else if (!noSerial && externalSerialLog) {
  console.log(`Using existing serial log: ${serialLog}`);
} else if (!noSerial && devicePort && existsSync(devicePort) && !existsSync(idfExport)) {
  console.log("Serial capture skipped because ESP-IDF export.sh was not found. Set IDF_EXPORT explicitly.");
} else if (!noSerial) {
  console.log(`Serial capture skipped because no StackChan port was found. Set STACKCHAN_PORT explicitly.`);
} else {
  console.log("Serial capture disabled by --no-serial.");
}

const watcherArgs = buildWatcherArgs();
console.log("");
console.log(`Starting watcher: node ${watcherArgs.join(" ")}`);
console.log("");
const watcherExitCode = await runWatcher(watcherArgs, watcherLog);

stopChildren();
console.log("");
console.log(`Session artifacts: ${sessionDir}`);
console.log(`Instructions: ${instructionsPath}`);
console.log(`Watcher log: ${watcherLog}`);
if (!noSerial) console.log(`Serial log: ${serialLog}`);
process.exit(watcherExitCode);

function buildWatcherArgs() {
  const result = [
    "scripts/stackchan-voice-watch.mjs",
    `--scenario=${scenario}`,
    `--timeout-ms=${timeoutMs}`,
    `--expect-text=${expectText}`,
  ];
  if (requireTrigger) result.push("--require-trigger");
  if (requireRealHa) result.push("--require-real-ha");
  if (scenario === "pc" || scenario === "full") {
    result.push(`--pc-file=${pcFile}`);
    result.push(`--expect-pc-content=${expectPcContent}`);
  }
  if (!noSerial) result.push(`--serial-log=${serialLog}`);
  if (watcherJson) result.push("--json");
  return result;
}

function startSerialCapture(path) {
  console.log(`Capturing StackChan serial from ${devicePort} at ${baud} baud -> ${path}`);
  const stream = createWriteStream(path, { flags: "a" });
  stream.write(`\n# StackChan serial capture started ${new Date().toISOString()}\n`);
  const command = [
    `. ${shellQuote(idfExport)} >/tmp/jarvis-idf-export.log`,
    `python -m serial.tools.miniterm ${shellQuote(devicePort)} ${baud} --raw`,
  ].join(" && ");
  const child = spawn("zsh", ["-lc", command], {
    cwd: firmwareRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.on("data", (chunk) => stream.write(chunk));
  child.stderr.on("data", (chunk) => stream.write(chunk));
  child.on("close", (code, signal) => {
    stream.write(`\n# StackChan serial capture ended code=${code ?? ""} signal=${signal ?? ""} ${new Date().toISOString()}\n`);
    stream.end();
    children.delete(child);
    if (code && code !== 0) {
      console.log(`Serial capture exited early with code ${code}; watcher will continue with Xiaozhi/Jarvis logs.`);
    }
  });
  return child;
}

function runWatcher(watcherArgs, logPath) {
  return new Promise((resolveExit) => {
    const stream = createWriteStream(logPath, { flags: "a" });
    const child = spawn(process.execPath, watcherArgs, {
      cwd: repoRoot,
      stdio: ["inherit", "pipe", "pipe"],
    });
    children.add(child);
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      stream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stream.write(chunk);
    });
    child.on("close", (code) => {
      stream.end();
      children.delete(child);
      resolveExit(code ?? 1);
    });
  });
}

function printSessionHeader() {
  console.log("StackChan physical voice session");
  console.log(`Scenario: ${scenario}`);
  console.log(`Session dir: ${sessionDir}`);
  console.log(`Watcher timeout: ${timeoutMs}ms`);
  console.log(`Require trigger evidence: ${requireTrigger ? "yes" : "no"}`);
  console.log(`Require real HA: ${requireRealHa ? "yes" : "no"}`);
  console.log("");
  console.log("At StackChan:");
  for (const line of spokenPrompts()) console.log(`- ${line}`);
  console.log("");
  console.log("Precheck summary:");
  for (const [label, output] of precheck) {
    const firstLine = output.trim().split(/\r?\n/).find(Boolean) || "(empty)";
    console.log(`- ${label}: ${firstLine}`);
  }
}

function buildInstructions() {
  return [
    "# StackChan Physical Session",
    "",
    `- Created: ${new Date().toISOString()}`,
    `- Scenario: ${scenario}`,
    `- Timeout: ${timeoutMs}ms`,
    `- Require trigger evidence: ${requireTrigger}`,
    `- Require real HA: ${requireRealHa}`,
    `- Expected text: ${expectText}`,
    `- PC file: ${pcFile || "(none)"}`,
    "",
    "## Speak At StackChan",
    "",
    ...spokenPrompts().map((line) => `- ${line}`),
    "",
    "## Artifacts",
    "",
    `- Watcher log: ${watcherLog}`,
    `- Serial log: ${serialLog}`,
    `- Precheck log: ${statusLog}`,
    "",
  ].join("\n");
}

function spokenPrompts() {
  if (scenario === "pc") {
    return [
      `按住头，说“在电脑工作区新建 ${pcFile} 并写入 helloworld”，松开头提交。`,
      "StackChan 应播报文件创建结果。",
    ];
  }
  if (scenario === "ha-control") {
    return [
      "按住头，说“打开次卧吸顶灯”，松开头提交。",
      "StackChan 应播报执行结果。真实控制结束后，用窄命令恢复灯光。",
    ];
  }
  if (scenario === "agent") {
    return [
      "按住头，说“帮我总结今天要做什么”，松开头提交。",
      "StackChan 应播报 Hermes/Jarvis Agent 的自然语言回答。",
    ];
  }
  if (scenario === "full") {
    return [
      "按住头，说“次卧吸顶灯开着吗”，松开头提交。",
      `按住头，说“在电脑工作区新建 ${pcFile} 并写入 helloworld”，松开头提交。`,
      "如果已经切到 real-second 并明确要真实控制，再按住头说“打开次卧吸顶灯”，松开头提交。",
    ];
  }
  return [
    "按住头，说“次卧吸顶灯开着吗”，松开头提交。",
    "StackChan 应播报次卧灯光状态。",
  ];
}

function defaultExpectText(sessionScenario, filename) {
  if (sessionScenario === "pc") return "电脑工作区";
  if (sessionScenario === "ha-control") return "打开次卧吸顶灯";
  if (sessionScenario === "agent") return "总结";
  if (sessionScenario === "full") return "";
  return "次卧吸顶灯";
}

function defaultPcFile(sessionScenario, compactTime) {
  if (sessionScenario !== "pc" && sessionScenario !== "full") return "";
  return `stackchan-voice-${compactTime}.md`;
}

function spawnText(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return `${result.stdout || ""}${result.stderr || ""}` || `exit ${result.status ?? "unknown"}`;
}

async function httpText(url) {
  try {
    const response = await fetch(url);
    return await response.text();
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
}

function stopChildren() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Child may already be gone.
    }
  }
}

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const raw = item.slice(2);
    if (raw.includes("=")) {
      const [key, ...rest] = raw.split("=");
      values[key] = rest.join("=");
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[raw] = next;
      index += 1;
    } else {
      flags.add(raw);
    }
  }
  return { flags, values };
}

function resolvePath(path) {
  if (!path) return "";
  return path.startsWith("/") ? path : resolve(repoRoot, path);
}

function findDevicePort() {
  try {
    const candidate = readdirSync("/dev")
      .filter((name) => /^(cu\.usbmodem|ttyACM|ttyUSB)/.test(name))
      .sort()[0];
    return candidate ? resolve("/dev", candidate) : "";
  } catch {
    return "";
  }
}

function findIdfExport() {
  const espRoot = resolve(homedir(), "esp");
  try {
    return readdirSync(espRoot)
      .filter((name) => name.startsWith("esp-idf"))
      .map((name) => resolve(espRoot, name, "export.sh"))
      .filter(existsSync)
      .sort()
      .reverse()[0] || "";
  } catch {
    return "";
  }
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
