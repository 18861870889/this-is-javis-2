import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(repoRoot, "data/jarvis-stack.local");
const pidFile = resolve(runtimeDir, "pids.json");
const pidData = readJsonFile(pidFile) || {};
const args = parseArgs(process.argv.slice(2));

const replay = args.flags.has("replay");
const jsonOutput = args.flags.has("json");
const fresh = args.flags.has("fresh");
const scenario = args.values.scenario || process.env.STACKCHAN_VOICE_WATCH_SCENARIO || "full";
const timeoutMs = positiveInteger(args.values["timeout-ms"] || process.env.STACKCHAN_VOICE_WATCH_TIMEOUT_MS, 180_000);
const pollMs = positiveInteger(args.values["poll-ms"] || process.env.STACKCHAN_VOICE_WATCH_POLL_MS, 500);
const statusEveryMs = positiveInteger(args.values["status-ms"] || process.env.STACKCHAN_VOICE_WATCH_STATUS_MS, 10_000);
const contextBytes = fresh ? 0 : positiveInteger(args.values["context-bytes"] || process.env.STACKCHAN_VOICE_WATCH_CONTEXT_BYTES, 200_000);
const deviceId = args.values["device-id"] || process.env.STACKCHAN_VOICE_WATCH_DEVICE_ID || process.env.XIAOZHI_WS_SMOKE_DEVICE_ID || "80:45:6b:4d:da:d0";
const expectText = args.values["expect-text"] || process.env.STACKCHAN_VOICE_WATCH_EXPECT_TEXT || "";
const expectTextPattern = compilePattern(expectText);
const pcFile = args.values["pc-file"] || process.env.STACKCHAN_VOICE_WATCH_PC_FILE || "";
const expectPcContent = args.values["expect-pc-content"] || process.env.STACKCHAN_VOICE_WATCH_EXPECT_PC_CONTENT || "helloworld";
const requireRealHa = args.flags.has("require-real-ha") || process.env.STACKCHAN_VOICE_WATCH_REQUIRE_REAL_HA === "true";
const requireTrigger = args.flags.has("require-trigger") || process.env.STACKCHAN_VOICE_WATCH_REQUIRE_TRIGGER === "true";

const xiaozhiLog = resolvePath(args.values["xiaozhi-log"] || process.env.STACKCHAN_VOICE_WATCH_XIAOZHI_LOG || pidData.xiaozhi?.log || "data/jarvis-stack.local/xiaozhi.log");
const jarvisLog = resolvePath(args.values["jarvis-log"] || process.env.STACKCHAN_VOICE_WATCH_JARVIS_LOG || pidData.jarvis?.log || "data/jarvis-stack.local/jarvis.log");
const auditLog = resolvePath(args.values["audit-log"] || process.env.HARNESS_COMMAND_AUDIT_PATH || process.env.STACKCHAN_VOICE_WATCH_AUDIT_LOG || "data/command-audit.local.jsonl");
const pcWorkspace = resolvePath(args.values["pc-workspace"] || process.env.JARVIS_PC_WORKSPACE_ROOT || "data/pc-workspace.local");
const serialLog = args.values["serial-log"] || process.env.STACKCHAN_VOICE_WATCH_SERIAL_LOG || "";
const serialLogPath = serialLog ? resolvePath(serialLog) : "";

const stageDefs = [
  ["device_connected", "设备连接到本地 Xiaozhi"],
  ["hello_received", "Xiaozhi 收到设备 hello"],
  ["listen_started", "设备进入 listen start"],
  ["wake_word_or_touch", "唤醒词/触摸触发"],
  ["audio_frames", "音频帧进入 Xiaozhi"],
  ["vad_voice_started", "VAD voice started"],
  ["asr_started", "ASR started"],
  ["recognized_text", "识别文本"],
  ["llm_user_message", "大模型收到用户消息"],
  ["jarvis_hcm_result", "Jarvis/HCM 结果"],
  ["home_result", "HA 状态/控制结果"],
  ["pc_result", "PC 文件操作结果"],
  ["tts_sent", "TTS 已发送到设备"],
  ["tts_completed", "TTS 播报结束"],
];

const requiredByScenario = {
  voice: ["device_connected", "listen_started", "audio_frames", "vad_voice_started", "asr_started", "recognized_text", "llm_user_message", "tts_sent"],
  "home-state": ["device_connected", "listen_started", "audio_frames", "vad_voice_started", "asr_started", "recognized_text", "llm_user_message", "jarvis_hcm_result", "home_result", "tts_sent"],
  "ha-control": ["device_connected", "listen_started", "audio_frames", "vad_voice_started", "asr_started", "recognized_text", "llm_user_message", "jarvis_hcm_result", "home_result", "tts_sent"],
  pc: ["device_connected", "listen_started", "audio_frames", "vad_voice_started", "asr_started", "recognized_text", "llm_user_message", "pc_result", "tts_sent"],
  agent: ["device_connected", "listen_started", "audio_frames", "vad_voice_started", "asr_started", "recognized_text", "llm_user_message", "tts_sent"],
  full: ["device_connected", "listen_started", "audio_frames", "vad_voice_started", "asr_started", "recognized_text", "llm_user_message", "jarvis_hcm_result", "home_result", "pc_result", "tts_sent"],
};

if (!requiredByScenario[scenario]) {
  die(`Unknown scenario "${scenario}". Use one of: ${Object.keys(requiredByScenario).join(", ")}`);
}
const requiredStages = buildRequiredStages(scenario, { requireTrigger });

class VoiceAcceptanceObserver {
  constructor(config) {
    this.config = config;
    this.stages = new Map(stageDefs.map(([id, label]) => [id, {
      id,
      label,
      status: "pending",
      at: null,
      detail: "",
      source: "",
      inferred: false,
    }]));
    this.events = [];
    this.warnings = [];
    this.failures = [];
    this.maxAudioFrames = 0;
    this.latestRecognizedText = "";
    this.latestLlmText = "";
    this.latestTtsText = "";
    this.latestAuditInput = "";
    this.pcSnapshot = snapshotPcWorkspace(config.paths.pcWorkspace);
  }

  async run() {
    this.printHeader();
    this.checkInputs();

    if (this.config.replay) {
      this.parseWholeFile(this.config.paths.xiaozhiLog, "xiaozhi");
      this.parseWholeFile(this.config.paths.jarvisLog, "jarvis");
      this.parseWholeFile(this.config.paths.auditLog, "audit");
      if (this.config.paths.serialLog) this.parseWholeFile(this.config.paths.serialLog, "serial");
      this.pollPcWorkspace();
      this.printSummary({ timedOut: false, replay: true });
      process.exit(this.anyStagePassed() ? 0 : 2);
    }

    this.parseContext();
    const cursors = [
      new FileCursor(this.config.paths.xiaozhiLog, "xiaozhi"),
      new FileCursor(this.config.paths.jarvisLog, "jarvis"),
      new FileCursor(this.config.paths.auditLog, "audit"),
      ...(this.config.paths.serialLog ? [new FileCursor(this.config.paths.serialLog, "serial")] : []),
    ];

    this.printPrompt();
    const deadline = Date.now() + this.config.timeoutMs;
    let nextStatusAt = Date.now() + this.config.statusEveryMs;

    while (Date.now() < deadline) {
      for (const cursor of cursors) {
        for (const line of cursor.readNewLines()) this.handleLine(line, cursor.source, { context: false });
      }
      this.pollPcWorkspace();

      if (this.allRequiredPassed()) {
        this.printSummary({ timedOut: false, replay: false });
        process.exit(0);
      }

      if (Date.now() >= nextStatusAt) {
        this.printProgress();
        nextStatusAt = Date.now() + this.config.statusEveryMs;
      }
      await sleep(this.config.pollMs);
    }

    this.printSummary({ timedOut: true, replay: false });
    process.exit(this.allRequiredPassed() ? 0 : 2);
  }

  printHeader() {
    if (this.config.jsonOutput) return;
    console.log("StackChan physical voice acceptance watcher");
    console.log(`Scenario: ${this.config.scenario}`);
    console.log(`Device ID: ${this.config.deviceId}`);
    console.log(`Xiaozhi log: ${this.config.paths.xiaozhiLog}`);
    console.log(`Jarvis audit: ${this.config.paths.auditLog}`);
    console.log(`PC workspace: ${this.config.paths.pcWorkspace}`);
    if (this.config.paths.serialLog) console.log(`Serial log: ${this.config.paths.serialLog}`);
    if (this.config.expectText) console.log(`Expected text pattern: ${this.config.expectText}`);
    if (this.config.pcFile) console.log(`Expected PC file: ${this.config.pcFile}`);
    if (this.config.requireRealHa) console.log("HA real-control requirement: enabled");
    if (this.config.requireTrigger) console.log("Wake/touch trigger evidence requirement: enabled");
    if (this.config.replay) console.log("Mode: replay parser check. This is not physical acceptance.");
    console.log("");
  }

  checkInputs() {
    for (const [label, path] of Object.entries({
      "Xiaozhi log": this.config.paths.xiaozhiLog,
      "Jarvis log": this.config.paths.jarvisLog,
      "Audit log": this.config.paths.auditLog,
    })) {
      if (!existsSync(path)) this.warn(`${label} not found yet: ${path}`);
    }
    if (!existsSync(this.config.paths.pcWorkspace)) this.warn(`PC workspace not found yet: ${this.config.paths.pcWorkspace}`);
  }

  parseContext() {
    if (!this.config.contextBytes) return;
    for (const [path, source] of [
      [this.config.paths.xiaozhiLog, "xiaozhi"],
      [this.config.paths.jarvisLog, "jarvis"],
      [this.config.paths.auditLog, "audit"],
      [this.config.paths.serialLog, "serial"],
    ]) {
      if (!path || !existsSync(path)) continue;
      for (const line of readTailLines(path, this.config.contextBytes)) {
        this.handleLine(line, source, { context: true });
      }
    }
  }

  parseWholeFile(path, source) {
    if (!path || !existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (line.trim()) this.handleLine(line, source, { context: false });
    }
  }

  handleLine(line, source, { context }) {
    const safeLine = redact(line);
    if (source === "audit") {
      if (!context) this.handleAuditLine(safeLine);
      return;
    }
    if (source === "serial") {
      this.handleSerialLine(safeLine, { context });
      return;
    }
    if (source === "xiaozhi") {
      this.handleXiaozhiLine(safeLine, { context });
    }
  }

  handleSerialLine(line, { context }) {
    if (/wake word|唤醒词|xiao hei|小黑/i.test(line)) {
      this.pass("wake_word_or_touch", "serial detected wake-word related line", { source: "serial", context });
    }
    if (/head touch starts xiaozhi manual listening/i.test(line)) {
      this.pass("wake_word_or_touch", "head touch started manual listening", { source: "serial", context });
    }
    if (/head touch stops xiaozhi manual listening/i.test(line)) {
      this.pass("wake_word_or_touch", "head touch stopped manual listening", { source: "serial", context });
    }
    if (/head touch toggles xiaozhi chat|touch toggles/i.test(line)) {
      this.pass("wake_word_or_touch", "head touch toggled Xiaozhi chat", { source: "serial", context });
    }
  }

  handleXiaozhiLine(line, { context }) {
    if (/conn - Headers/.test(line)) {
      const lineDeviceId = extractDeviceId(line);
      if (!this.config.deviceId || !lineDeviceId || lineDeviceId === this.config.deviceId) {
        const ip = extractConnectionIp(line);
        const detail = `${lineDeviceId || "unknown device"}${ip ? ` from ${ip}` : ""}${context ? " (recent context)" : ""}`;
        this.pass("device_connected", detail, { source: "xiaozhi", context });
      }
      return;
    }

    if (/收到hello消息/.test(line)) {
      this.pass("hello_received", `hello received${context ? " (recent context)" : ""}`, { source: "xiaozhi", context });
      return;
    }

    if (context) return;

    if (/收到listen消息/.test(line) && /"state"\s*:\s*"start"/.test(line)) {
      const mode = matchGroup(line, /"mode"\s*:\s*"([^"]+)"/);
      this.pass("device_connected", "inferred from live listen start", {
        source: "xiaozhi",
        inferred: true,
      });
      this.pass("listen_started", `listen start${mode ? `, mode=${mode}` : ""}`, { source: "xiaozhi" });
      if (mode === "manual") {
        this.pass("wake_word_or_touch", "manual listen start observed", { source: "xiaozhi", inferred: true });
      } else if (mode === "auto") {
        this.pass("wake_word_or_touch", "auto listen start observed", { source: "xiaozhi", inferred: true });
      }
      return;
    }

    const audioFrames = matchGroup(line, /Jarvis audio diag: received\s+(\d+)\s+audio frames/);
    if (audioFrames) {
      this.maxAudioFrames = Math.max(this.maxAudioFrames, Number(audioFrames));
      this.pass("audio_frames", `${this.maxAudioFrames} frames observed`, { source: "xiaozhi", update: true });
      return;
    }

    if (/Jarvis audio diag: VAD voice started/.test(line)) {
      const frames = matchGroup(line, /after\s+(\d+)\s+frames/);
      this.pass("vad_voice_started", `voice started${frames ? ` after ${frames} frames` : ""}`, { source: "xiaozhi" });
      return;
    }

    if (/Jarvis audio diag: VAD voice stop/.test(line)) {
      const buffered = matchGroup(line, /buffered=(\d+)\s+frames/);
      this.pass("asr_started", `inferred after VAD stop${buffered ? `, buffered=${buffered} frames` : ""}`, {
        source: "xiaozhi",
        inferred: true,
      });
      return;
    }

    const asrText = matchGroup(line, /语音识别耗时:\s*[^|]+\|\s*结果:\s*(.+)$/);
    if (asrText) {
      this.pass("asr_started", "ASR result line observed", { source: "xiaozhi" });
      this.markRecognizedText(asrText, { source: "xiaozhi" });
      return;
    }

    const llmText = matchGroup(line, /大模型收到用户消息:\s*(.+)$/);
    if (llmText) {
      if (isIdleClosingPrompt(llmText)) {
        this.warn(`Xiaozhi idle closing prompt observed, ignored as user speech: ${shorten(llmText)}`);
        return;
      }
      if (!this.markRecognizedText(llmText, { source: "xiaozhi", inferred: true })) return;
      this.latestLlmText = llmText.trim();
      this.pass("llm_user_message", shorten(llmText), { source: "xiaozhi" });
      return;
    }

    const firstTts = matchGroup(line, /发送第一段语音:\s*(.+)$/) || matchGroup(line, /发送音频消息:\s*SentenceType\.FIRST,\s*(.+)$/);
    if (firstTts) {
      if (!this.config.expectTextPattern || this.stages.get("tts_sent")?.status !== "pass") {
        this.latestTtsText = firstTts.trim();
      }
      this.markPcResultFromText(firstTts, { source: "xiaozhi" });
      this.pass("tts_sent", shorten(firstTts), { source: "xiaozhi" });
      return;
    }

    if (/发送音频消息:\s*SentenceType\.LAST/.test(line)) {
      this.pass("tts_completed", "last TTS audio marker sent", { source: "xiaozhi" });
      return;
    }
  }

  handleAuditLine(line) {
    if (!line.trim().startsWith("{")) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (!this.auditMatchesExpectedText(entry)) return;

    this.latestAuditInput = entry.input || "";
    const intentType = entry.plan?.intentType || entry.plan?.kind || "unknown";
    const detail = `${entry.status || "unknown"} ${intentType}: ${shorten(entry.input || "")}${entry.latencyMs ? ` (${entry.latencyMs}ms)` : ""}`;
    if (["error", "rejected", "integration_unavailable", "brain_timeout", "brain_unavailable"].includes(entry.status)) {
      this.fail("jarvis_hcm_result", detail);
    } else {
      this.pass("jarvis_hcm_result", detail, { source: "audit" });
    }

    const services = entry.execution?.services || [];
    if (entry.plan?.stateQuery) {
      const message = entry.explanation?.userMessage || entry.plan?.stateQuery?.summary || entry.plan?.summary || entry.input;
      this.pass("home_result", `state query answered: ${shorten(message)}`, { source: "audit" });
      return;
    }

    if (services.length > 0) {
      const service = services[0];
      const entity = service.serviceData?.entity_id || service.entityId || service.thingName || "";
      const realExecuted = entry.status === "executed" && entry.dryRun === false;
      const dryRun = entry.status === "dry_run" || entry.dryRun === true;
      const mode = realExecuted ? "real HA executed" : dryRun ? "dry-run planned" : entry.status || "unknown";
      const serviceDetail = `${mode}: ${service.service || "service"} ${entity}`.trim();
      if (this.config.requireRealHa && !realExecuted) {
        this.fail("home_result", `expected real HA execution, got ${serviceDetail}`);
      } else {
        this.pass("home_result", serviceDetail, { source: "audit" });
      }
    }
  }

  auditMatchesExpectedText(entry) {
    if (!this.config.expectTextPattern) return true;
    const input = String(entry.input || "");
    return this.config.expectTextPattern.test(input);
  }

  markRecognizedText(text, { source, inferred = false }) {
    const value = String(text || "").trim();
    if (!value) return;
    if (isIdleClosingPrompt(value)) return;
    if (this.config.expectTextPattern && !this.config.expectTextPattern.test(value)) {
      this.warn(`Recognized text did not match expected pattern: ${shorten(value)}`);
      return false;
    }
    this.latestRecognizedText = value;
    this.inferVoicePipelineFromRecognizedText({ source });
    this.pass("recognized_text", shorten(value), { source, inferred });
    return true;
  }

  inferVoicePipelineFromRecognizedText({ source }) {
    if (source !== "xiaozhi") return;
    if (this.stages.get("listen_started")?.status !== "pass") return;
    this.pass("audio_frames", "inferred from recognized Xiaozhi speech text", {
      source: "xiaozhi",
      inferred: true,
    });
    this.pass("vad_voice_started", "inferred from recognized Xiaozhi speech text", {
      source: "xiaozhi",
      inferred: true,
    });
    this.pass("asr_started", "inferred from recognized Xiaozhi speech text", {
      source: "xiaozhi",
      inferred: true,
    });
  }

  pollPcWorkspace() {
    if (!existsSync(this.config.paths.pcWorkspace)) return;
    const next = snapshotPcWorkspace(this.config.paths.pcWorkspace);
    for (const [filename, info] of next.entries()) {
      const previous = this.pcSnapshot.get(filename);
      if (previous && previous.signature === info.signature) continue;
      if (this.config.pcFile && basename(this.config.pcFile) !== filename) continue;
      let content = "";
      try {
        content = readFileSync(resolve(this.config.paths.pcWorkspace, filename), "utf8");
      } catch {
        // A file can be observed between create and close; wait for the next poll.
        continue;
      }
      if (this.config.expectPcContent && !content.includes(this.config.expectPcContent)) {
        this.fail("pc_result", `${filename} was changed but does not contain ${this.config.expectPcContent}`);
        continue;
      }
      this.pass("pc_result", `${filename} (${info.size} bytes) contains ${this.config.expectPcContent}`, { source: "pc-workspace" });
    }
    this.pcSnapshot = next;
  }

  markPcResultFromText(text, { source }) {
    const filename = matchGroup(text, /电脑工作区里的\s+([^\s，。]+\.md)/i);
    if (!filename) return;
    if (this.config.pcFile && basename(this.config.pcFile) !== filename) return;
    const filePath = resolve(this.config.paths.pcWorkspace, filename);
    if (!existsSync(filePath)) {
      this.pass("pc_result", `${filename} was announced by TTS`, { source, inferred: true });
      return;
    }
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      this.pass("pc_result", `${filename} was announced by TTS`, { source, inferred: true });
      return;
    }
    if (this.config.expectPcContent && !content.includes(this.config.expectPcContent)) {
      this.fail("pc_result", `${filename} exists but does not contain ${this.config.expectPcContent}`);
      return;
    }
    this.pass("pc_result", `${filename} exists and contains ${this.config.expectPcContent}`, { source });
  }

  pass(id, detail, { source = "", inferred = false, update = false, context = false } = {}) {
    const stage = this.stages.get(id);
    if (!stage) return;
    const isAlreadyPassed = stage.status === "pass";
    if (isAlreadyPassed && !update) return;
    stage.status = "pass";
    stage.at = stage.at || new Date().toISOString();
    stage.detail = detail;
    stage.source = source;
    stage.inferred = Boolean(inferred);
    if (!isAlreadyPassed) {
      this.events.push({ id, detail, source, inferred, context, at: stage.at });
      this.printEvent("PASS", stage, detail, { inferred, context });
    }
  }

  fail(id, detail) {
    const stage = this.stages.get(id);
    if (!stage) return;
    stage.status = "fail";
    stage.at = new Date().toISOString();
    stage.detail = detail;
    this.failures.push(`${stage.label}: ${detail}`);
    this.printEvent("FAIL", stage, detail);
  }

  warn(message) {
    this.warnings.push(message);
    if (!this.config.jsonOutput) console.log(`[WARN] ${message}`);
  }

  printEvent(prefix, stage, detail, { inferred = false, context = false } = {}) {
    if (this.config.jsonOutput) return;
    const suffix = `${inferred ? " (inferred)" : ""}${context ? " (context)" : ""}`;
    console.log(`[${prefix}] ${stage.label}: ${detail}${suffix}`);
  }

  printPrompt() {
    if (this.config.jsonOutput) return;
    console.log("Watcher is live. Start the physical test now.");
    if (this.config.scenario === "voice") {
      console.log("Manual path: hold StackChan head, say: 次卧吸顶灯开着吗, then release.");
      console.log("Wake-word path: say 小黑, then say: 次卧吸顶灯开着吗.");
    } else if (this.config.scenario === "home-state") {
      console.log("Manual path: hold StackChan head, say: 次卧吸顶灯开着吗, then release.");
      console.log("Wake-word path: say 小黑, then say: 次卧吸顶灯开着吗.");
    } else if (this.config.scenario === "ha-control") {
      console.log("Manual path: hold StackChan head, say: 打开次卧吸顶灯, then release.");
      console.log("Wake-word path: say 小黑, then say: 打开次卧吸顶灯.");
    } else if (this.config.scenario === "pc") {
      const filename = this.config.pcFile || "stackchan-voice-final.md";
      console.log(`Manual path: hold StackChan head, say: 在电脑工作区新建 ${filename} 并写入 helloworld, then release.`);
      console.log(`Wake-word path: say 小黑, then say: 在电脑工作区新建 ${filename} 并写入 helloworld.`);
    } else if (this.config.scenario === "agent") {
      console.log("Manual path: hold StackChan head, say: 帮我总结今天要做什么, then release.");
      console.log("Wake-word path: say 小黑, then say: 帮我总结今天要做什么.");
    } else {
      console.log("Suggested order:");
      console.log("1. Hold StackChan head, say: 次卧吸顶灯开着吗, then release.");
      console.log("2. Hold StackChan head, say: 在电脑工作区新建 stackchan-voice-final.md 并写入 helloworld, then release.");
      console.log("3. If real HA is intentionally enabled: hold head, say: 打开次卧吸顶灯, then release.");
      console.log("4. To verify wake word separately: say 小黑, then say: 次卧吸顶灯开着吗.");
    }
    if (this.config.requireTrigger) {
      console.log("Trigger evidence is required. For wake-word proof, pass --serial-log with StackChan serial output.");
    }
    console.log("");
  }

  printProgress() {
    if (this.config.jsonOutput) return;
    const pending = this.pendingRequiredStages();
    if (pending.length) {
      console.log(`[WAIT] Pending required stages: ${pending.map((stage) => stage.label).join(", ")}`);
    }
  }

  printSummary({ timedOut, replay }) {
    const required = new Set(this.config.requiredStages);
    const summary = {
      ok: this.allRequiredPassed(),
      timedOut,
      replay,
      scenario: this.config.scenario,
      requiredStages: this.config.requiredStages,
      pendingRequiredStages: this.pendingRequiredStages().map((stage) => stage.id),
      warnings: this.warnings,
      failures: this.failures,
      stages: Array.from(this.stages.values()).map((stage) => ({
        ...stage,
        required: required.has(stage.id),
      })),
      latest: {
        recognizedText: this.latestRecognizedText,
        llmText: this.latestLlmText,
        ttsText: this.latestTtsText,
        auditInput: this.latestAuditInput,
        maxAudioFrames: this.maxAudioFrames,
      },
    };

    if (this.config.jsonOutput) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("");
    console.log(replay ? "Replay parser summary" : "Physical voice acceptance summary");
    console.log(`Result: ${summary.ok ? "PASS" : timedOut ? "INCOMPLETE" : "PARTIAL"}`);
    console.log("");
    for (const stage of summary.stages) {
      const marker = stage.status === "pass" ? "PASS" : stage.status === "fail" ? "FAIL" : stage.required ? "PENDING" : "SKIP";
      const inferred = stage.inferred ? " inferred" : "";
      const requiredText = stage.required ? " required" : "";
      const detail = stage.detail ? ` - ${stage.detail}` : "";
      console.log(`${marker.padEnd(7)} ${stage.label}${requiredText}${inferred}${detail}`);
    }
    if (this.warnings.length) {
      console.log("");
      console.log("Warnings:");
      for (const warning of this.warnings) console.log(`- ${warning}`);
    }
    if (this.failures.length) {
      console.log("");
      console.log("Failures:");
      for (const failure of this.failures) console.log(`- ${failure}`);
    }
  }

  allRequiredPassed() {
    return this.config.requiredStages.every((id) => this.stages.get(id)?.status === "pass");
  }

  pendingRequiredStages() {
    return this.config.requiredStages
      .map((id) => this.stages.get(id))
      .filter((stage) => stage?.status !== "pass");
  }

  anyStagePassed() {
    return Array.from(this.stages.values()).some((stage) => stage.status === "pass");
  }
}

class FileCursor {
  constructor(path, source) {
    this.path = path;
    this.source = source;
    this.offset = existsSync(path) ? statSync(path).size : 0;
    this.partial = "";
  }

  readNewLines() {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return [];
    const buffer = readFileSync(this.path).subarray(this.offset, size);
    this.offset = size;
    const text = this.partial + buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop() || "";
    return lines.filter((line) => line.trim());
  }
}

function snapshotPcWorkspace(path) {
  const result = new Map();
  if (!existsSync(path)) return result;
  for (const filename of readdirSync(path)) {
    if (extname(filename).toLowerCase() !== ".md") continue;
    const filePath = resolve(path, filename);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      result.set(filename, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        signature: `${stat.size}:${stat.mtimeMs}`,
      });
    } catch {
      // Ignore files that disappear during polling.
    }
  }
  return result;
}

function readTailLines(path, bytes) {
  const buffer = readFileSync(path);
  const start = Math.max(0, buffer.length - bytes);
  return buffer.subarray(start).toString("utf8").split(/\r?\n/).filter((line) => line.trim());
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
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

function buildRequiredStages(scenarioName, { requireTrigger: triggerRequired }) {
  const base = [...requiredByScenario[scenarioName]];
  if (triggerRequired && !base.includes("wake_word_or_touch")) base.splice(1, 0, "wake_word_or_touch");
  return base;
}

function resolvePath(path) {
  if (!path) return "";
  return path.startsWith("/") ? path : resolve(repoRoot, path);
}

function compilePattern(value) {
  if (!value) return null;
  if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
    const last = value.lastIndexOf("/");
    return new RegExp(value.slice(1, last), value.slice(last + 1));
  }
  return new RegExp(escapeRegExp(value));
}

function extractDeviceId(line) {
  return matchGroup(line, /['"]device-id['"]\s*:\s*['"]([^'"]+)['"]/) || matchGroup(line, /device-id['"]?\s*[:=]\s*['"]?([0-9a-f:.-]+)/i);
}

function extractConnectionIp(line) {
  return matchGroup(line, /INFO-([0-9.]+)\s+conn\s+-\s+Headers/);
}

function matchGroup(value, pattern) {
  const match = String(value || "").match(pattern);
  return match ? match[1] : "";
}

function isIdleClosingPrompt(text) {
  return /时间过得真快|结束这场对话|依依不舍/.test(String(text || ""));
}

function redact(value) {
  return String(value || "")
    .replace(/token=([^&\s'"]+)/gi, "token=REDACTED")
    .replace(/(authorization['"]?\s*[:=]\s*['"]?)([^,'"\s}]+)/gi, "$1REDACTED")
    .replace(/(api[_-]?key['"]?\s*[:=]\s*['"]?)([^,'"\s}]+)/gi, "$1REDACTED");
}

function shorten(value, max = 120) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function die(message) {
  console.error(message);
  process.exit(1);
}

const observer = new VoiceAcceptanceObserver({
  replay,
  jsonOutput,
  scenario,
  requiredStages,
  timeoutMs,
  pollMs,
  statusEveryMs,
  contextBytes,
  deviceId,
  expectTextPattern,
  expectText,
  pcFile,
  expectPcContent,
  requireRealHa,
  requireTrigger,
  paths: { xiaozhiLog, jarvisLog, auditLog, pcWorkspace, serialLog: serialLogPath },
});

await observer.run();
