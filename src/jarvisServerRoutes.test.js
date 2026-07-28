import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";

const REPO_ROOT = process.cwd();
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const cleanupTasks = [];

afterEach(async () => {
  while (cleanupTasks.length) {
    const cleanup = cleanupTasks.pop();
    await cleanup();
  }
});

describe("Jarvis server voice routes", () => {
  it("serves the built frontend in production while preserving API 404 responses", async () => {
    const tempDir = createTempDir();
    const staticRoot = join(tempDir, "dist");
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Jarvis container frontend</title>", "utf8");
    const harness = await startHarness({
      tempDir,
      env: {
        NODE_ENV: "production",
        JARVIS_STATIC_ROOT: staticRoot,
        JARVIS_FRONTEND_RATE_LIMIT_PER_MINUTE: "2",
      },
    });

    const frontend = await fetch(`${harness.url}/`);
    const frontendText = await frontend.text();
    const missingApi = await fetch(`${harness.url}/api/does-not-exist`, {
      headers: { Accept: "application/json" },
    });
    const missingApiText = await missingApi.text();
    const runtimeStatus = await fetch(`${harness.url}/api/runtime/status`);
    const runtimePayload = await runtimeStatus.json();
    const spaFallbackOne = await fetch(`${harness.url}/workspace/one`, {
      headers: { Accept: "text/html" },
    });
    const spaFallbackTwo = await fetch(`${harness.url}/workspace/two`, {
      headers: { Accept: "text/html" },
    });
    const rateLimitedFallback = await fetch(`${harness.url}/workspace/three`, {
      headers: { Accept: "text/html" },
    });

    expect(frontend.status).toBe(200);
    expect(frontend.headers.get("content-type")).toContain("text/html");
    expect(frontend.headers.get("cache-control")).toContain("no-cache");
    expect(frontendText).toContain("Jarvis container frontend");
    expect(missingApi.status).toBe(404);
    expect(missingApiText).not.toContain("Jarvis container frontend");
    expect(runtimeStatus.status).toBe(200);
    expect(runtimePayload.storage).toEqual({ writable: true });
    expect(spaFallbackOne.status).toBe(200);
    expect(spaFallbackTwo.status).toBe(200);
    expect(rateLimitedFallback.status).toBe(429);
    expect(rateLimitedFallback.headers.get("ratelimit")).toBeTruthy();
  }, 30000);

  it("handles a StackChan fast-path utterance without OPENAI_API_KEY and dedupes repeated wake sessions", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant();
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const first = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      trigger: "wake_word",
      wakeSessionId: "wake-shared-1",
      text: "打开书房射灯",
      dryRun: true,
    });
    const duplicate = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-living",
      roomId: "living",
      trigger: "wake_word",
      wakeSessionId: "wake-shared-1",
      text: "打开书房射灯。",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const deliveryEntries = readJsonl(harness.paths.deliveryAuditPath);
    const stageNames = auditEntries[0].stages.map((stage) => stage.name);

    expect(first).toMatchObject({
      route: "hcm_fast_path",
      routeReason: "simple_power_command",
      duplicate: false,
      handledByDeviceId: "stackchan-study",
      speak: true,
    });
    expect(["dry_run", "executed", "needs_confirmation", "needs_clarification", "rejected", "no_action"]).toContain(first.status);
    expect(stageNames).toContain("brain_home_intent");
    expect(stageNames).not.toContain("llm_planner");
    expect(duplicate).toMatchObject({
      route: "duplicate_ignored",
      duplicate: true,
      handledByDeviceId: "stackchan-study",
      speak: false,
    });
    expect(readJsonl(harness.paths.commandAuditPath)).toHaveLength(1);
    expect(deliveryEntries).toHaveLength(1);
    expect(deliveryEntries[0]).toMatchObject({
      source: "voice_bridge",
      origin: {
        ingress: "wake_word",
        sourceDeviceId: "stackchan-study",
        roomId: "study",
      },
      status: "dispatched",
      channelResults: [expect.objectContaining({
        channel: "voice",
        status: "dispatched",
        reason: "returned_to_ingress",
      })],
    });
  }, 30000);

  it("exposes a safe MCP tool that routes into the Jarvis voice bridge", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant();
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      stackchanDeviceRooms: { "stackchan-mcp": "study" },
      env: { JARVIS_MCP_ALLOWED_ROOM_IDS: "study" },
    });

    const initialized = await postJson(`${harness.url}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const tools = await postJson(`${harness.url}/mcp`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const call = await postJson(`${harness.url}/mcp`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jarvis_home_command",
        arguments: {
          wakeSessionId: "mcp-wake-1",
          text: "打开书房射灯",
          dryRun: false,
        },
      },
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(initialized.result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: "home-assistant" },
    });
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "home_assistant_control",
      "jarvis_home_command",
      "turn_on_home_device",
      "turn_off_home_device",
      "get_home_device_state",
      "computer_create_markdown_file",
    ]));
    expect(tools.result.tools[0].inputSchema).toMatchObject({ required: ["text"] });
    expect(tools.result.tools.find((tool) => tool.name === "home_assistant_control")?.description).toContain("书房射灯");
    expect(call).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [expect.objectContaining({ type: "text" })],
        structuredContent: {
          route: "hcm_fast_path",
          routeReason: "simple_power_command",
          status: "dry_run",
          duplicate: false,
          mcp: {
            dryRunForced: true,
            allowReal: false,
          },
        },
        isError: true,
      },
    });
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      input: "打开书房射灯",
      status: "dry_run",
    });
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("exposes a safe MCP computer tool scoped to the local PC workspace", async () => {
    const tempDir = createTempDir();
    const harness = await startHarness({ tempDir });

    const call = await postJson(`${harness.url}/mcp`, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "computer_create_markdown_file",
        arguments: {
          filename: "voice-note",
          content: "helloworld",
        },
      },
    });
    const targetPath = join(harness.paths.pcWorkspaceRoot, "voice-note.md");

    expect(call).toMatchObject({
      jsonrpc: "2.0",
      id: 21,
      result: {
        content: [expect.objectContaining({ type: "text", text: expect.stringContaining("voice-note.md") })],
        structuredContent: {
          status: "completed",
          operation: "computer_create_markdown_file",
          filename: "voice-note.md",
          bytes: 10,
          delivery: expect.objectContaining({
            status: "dispatched",
            channelResults: expect.arrayContaining([
              expect.objectContaining({ channel: "voice", status: "dispatched" }),
              expect.objectContaining({ channel: "wechat", status: "skipped" }),
            ]),
          }),
        },
        isError: false,
      },
    });
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf8")).toBe("helloworld");
  }, 30000);

  it("provides an OpenAI-compatible Xiaozhi brain endpoint for HCM and PC actions", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      env: {
        JARVIS_XIAOZHI_DEVICE_ID: "stackchan-second",
        JARVIS_XIAOZHI_ROOM_ID: "second",
        JARVIS_ALLOWED_ACTION_ROOM_IDS: "second",
      },
    });

    const homeReply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "打开次卧吸顶灯" }],
    });
    const pcReply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "在电脑上新建一个md文件并写入helloworld" }],
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const deliveryEntries = readJsonl(harness.paths.deliveryAuditPath);
    const markdownPath = join(harness.paths.pcWorkspaceRoot, "hello.md");

    expect(homeReply).toMatchObject({
      object: "chat.completion",
      choices: [expect.objectContaining({
        message: expect.objectContaining({
          role: "assistant",
          content: expect.any(String),
        }),
        finish_reason: "stop",
      })],
    });
    expect(homeReply.choices[0].message.content).toMatch(/次卧吸顶灯|dry-run|预览|打开/);
    expect(auditEntries.find((entry) => entry.input === "打开次卧吸顶灯")).toMatchObject({
      status: "dry_run",
    });
    expect(ha.serviceCalls).toHaveLength(0);
    expect(pcReply.choices[0].message.content).toContain("hello.md");
    expect(existsSync(markdownPath)).toBe(true);
    expect(readFileSync(markdownPath, "utf8")).toBe("helloworld");
    expect(deliveryEntries.some((entry) => entry.source === "voice_bridge")).toBe(true);
    expect(deliveryEntries.some((entry) => entry.source === "pc_markdown_file")).toBe(true);
  }, 30000);

  it("uses authenticated Xiaozhi request identity before environment fallbacks", async () => {
    const tempDir = createTempDir();
    const harness = await startHarness({
      tempDir,
      env: {
        JARVIS_XIAOZHI_DEVICE_ID: "fallback-device",
        JARVIS_XIAOZHI_ROOM_ID: "fallback-room",
        JARVIS_STACKCHAN_DEVICE_ROOMS: '{"request-device":"second"}',
      },
    });

    await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "在电脑上新建一个md文件并写入helloworld" }],
    }, {
      "X-Device-Id": "request-device",
      "X-Room-Id": "untrusted-room-fallback",
      "X-Session-Id": "request-session",
    });
    const deliveryEntries = readJsonl(harness.paths.deliveryAuditPath);
    const pcDelivery = deliveryEntries.find((entry) => entry.source === "pc_markdown_file");

    expect(pcDelivery?.origin).toMatchObject({
      sourceDeviceId: "request-device",
      roomId: "second",
      wakeSessionId: "request-session",
    });
  }, 30000);

  it("keeps Xiaozhi conversation focus for short ASR-corrected light follow-ups", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createStudyAndSecondLightGraph());
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      env: {
        JARVIS_XIAOZHI_DEVICE_ID: "stackchan-second",
        JARVIS_XIAOZHI_ROOM_ID: "second",
      },
    });

    await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "打开书房吊灯" }],
    });
    const followUp = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "放吊灯" }],
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const followUpAudit = auditEntries.find((entry) => entry.input === "关吊灯");

    expect(followUp.choices[0].message.content).toContain("书房吊灯");
    expect(followUpAudit).toMatchObject({
      status: "dry_run",
      conversation: {
        focusedTargets: [expect.objectContaining({ name: "书房吊灯", roomId: "study" })],
      },
    });
    expect(JSON.stringify(followUpAudit?.execution?.services ?? [])).toContain("书房吊灯");
    expect(JSON.stringify(followUpAudit?.execution?.services ?? [])).not.toContain("次卧吸顶灯");
  }, 30000);

  it("routes StackChan PC file requests to the local agent task instead of Hermes timeout", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("迟到的 Hermes 回答", { delayMs: 200 });
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url, hermesTimeoutMs: 50 });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "pc-file-voice-1",
      trigger: "xiaozhi_llm",
      text: "帮我新建一个小黑文文件并写入helloworld",
    });
    const targetPath = join(harness.paths.pcWorkspaceRoot, "小黑文.md");

    expect(result).toMatchObject({
      route: "agent_task",
      routeReason: "pc_markdown_file",
      status: "completed",
      speak: true,
    });
    expect(result.replyText).toContain("小黑文.md");
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf8")).toBe("helloworld");
    expect(hermes.calls).toHaveLength(0);
  }, 30000);

  it("delegates PC file work to Hermes when the container task mode is enabled", async () => {
    const tempDir = createTempDir();
    const paths = harnessPaths(tempDir);
    writeFileSync(paths.contextMemoryPath, `${JSON.stringify({
      recentPcFiles: [{
        filename: "old.md",
        path: join(paths.pcWorkspaceRoot, "old.md"),
        workspaceRoot: paths.pcWorkspaceRoot,
      }],
    })}\n`);
    const hermes = await startMockHermes("已通过 Hermes 在电脑上创建 bridge-check.md。");
    const harness = await startHarness({
      tempDir,
      hermesBaseUrl: hermes.url,
      env: {
        JARVIS_PC_TASK_MODE: "hermes",
      },
    });

    const reply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "在电脑工作区新建 bridge-check.md 并写入 helloworld" }],
    });

    expect(reply.choices[0].message.content).toContain("Hermes");
    expect(hermes.calls).toHaveLength(1);
    expect(existsSync(join(harness.paths.pcWorkspaceRoot, "bridge-check.md"))).toBe(false);
  }, 30000);

  it("answers follow-up questions about the last created PC file from persistent context", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("Hermes should not answer file context.");
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url });

    const created = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "帮我新建一个小黑文件，并且写入hello word。" }],
    });
    const location = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "刚才的文件的目录是哪个？" }],
    });
    const context = await getJson(`${harness.url}/api/jarvis/context`);

    expect(created.choices[0].message.content).toContain("小黑.md");
    expect(location.choices[0].message.content).toContain("小黑.md");
    expect(location.choices[0].message.content).toContain(harness.paths.pcWorkspaceRoot);
    expect(existsSync(join(harness.paths.pcWorkspaceRoot, "小黑.md"))).toBe(true);
    expect(existsSync(join(harness.paths.pcWorkspaceRoot, "的小黑.md"))).toBe(false);
    expect(context).toMatchObject({
      recentPcFileCount: 1,
      latestPcFile: expect.objectContaining({ filename: "小黑.md" }),
    });
    expect(hermes.calls).toHaveLength(0);
  }, 30000);

  it("starts long Hermes agent tasks asynchronously and exposes task status", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("记账 app 已生成了基础页面和数据结构。");
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url });

    const reply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "帮我写一个记账 app" }],
    });
    const completed = await waitForTaskStatus(harness.url, "completed");
    const statusReply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "刚才那个 app 做到哪了" }],
    });

    expect(reply.choices[0].message.content).toContain("开始处理");
    expect(completed.resultSummary).toContain("记账 app");
    expect(statusReply.choices[0].message.content).toContain("已经完成");
    expect(hermes.calls).toHaveLength(1);
  }, 30000);

  it("runs a configured real subagent process and delivers the successful result", async () => {
    const tempDir = createTempDir();
    const subagentScript = join(tempDir, "subagent-ok.mjs");
    writeFileSync(subagentScript, `
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(body);
  console.log(JSON.stringify({
    status: "completed",
    resultSummary: "subagent 已完成 " + input.text,
    artifacts: [{ type: "text", name: "result", path: "/tmp/subagent-result.txt" }]
  }));
});
`);
    const harness = await startHarness({
      tempDir,
      env: {
        JARVIS_SUBAGENT_COMMAND: process.execPath,
        JARVIS_SUBAGENT_ARGS: JSON.stringify([subagentScript]),
        JARVIS_LONG_TASK_HERMES_TIMEOUT_MS: "5000",
      },
    });

    const reply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "帮我写一个记账 app" }],
    });
    const completed = await waitForTaskStatus(harness.url, "completed");
    const deliveryEntries = readJsonl(harness.paths.deliveryAuditPath).filter((entry) => entry.source === "task_runtime");
    const taskEntries = readJsonl(harness.paths.taskAuditPath);

    expect(reply.choices[0].message.content).toContain("开始处理");
    expect(completed).toMatchObject({
      status: "completed",
      subagent: expect.objectContaining({ enabled: true, status: "completed", runner: process.execPath }),
    });
    expect(completed.resultSummary).toContain("subagent 已完成");
    expect(deliveryEntries).toContainEqual(expect.objectContaining({
      taskId: completed.taskId,
      voiceSummary: expect.stringContaining("任务完成了"),
      status: "pending",
      channelResults: expect.arrayContaining([
        expect.objectContaining({ channel: "voice", status: "pending" }),
      ]),
    }));
    expect(taskEntries.map((entry) => entry.event)).toEqual(expect.arrayContaining(["created", "updated"]));
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("routes configured subagent failures back to task status and high-priority delivery", async () => {
    const tempDir = createTempDir();
    const subagentScript = join(tempDir, "subagent-fail.mjs");
    writeFileSync(subagentScript, `
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ status: "failed", error: "subagent deliberate failure" }));
  process.exit(2);
});
`);
    const harness = await startHarness({
      tempDir,
      env: {
        JARVIS_SUBAGENT_COMMAND: process.execPath,
        JARVIS_SUBAGENT_ARGS: JSON.stringify([subagentScript]),
        JARVIS_LONG_TASK_HERMES_TIMEOUT_MS: "5000",
      },
    });

    await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "帮我写一个记账 app" }],
    });
    const failed = await waitForTaskStatus(harness.url, "failed");
    const statusReply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "刚才那个 app 做到哪了" }],
    });
    const deliveryEntries = readJsonl(harness.paths.deliveryAuditPath).filter((entry) => entry.source === "task_runtime");

    expect(failed).toMatchObject({
      status: "failed",
      error: expect.stringContaining("subagent deliberate failure"),
      subagent: expect.objectContaining({ enabled: true, status: "failed", exitCode: 2 }),
    });
    expect(statusReply.choices[0].message.content).toContain("失败了");
    expect(deliveryEntries).toContainEqual(expect.objectContaining({
      taskId: failed.taskId,
      priority: "high",
      voiceSummary: expect.stringContaining("任务没有完成"),
    }));
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("can use Hermes HomeIntent drafts with full HCM context before HCM safety execution", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const hermes = await startMockHermes(JSON.stringify({
      intent_type: "device_control",
      intent: "打开主卧主灯",
      confidence: 0.96,
      summary: "打开主卧主灯。",
      needs_confirmation: false,
      actions: [{
        target: "主卧主灯",
        room_id: "master",
        capability: "power",
        value: true,
        reason: "Hermes 根据 HCM 上下文识别到主卧主灯",
      }],
    }));
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      hermesBaseUrl: hermes.url,
      env: {
        JARVIS_HOME_INTENT_PLANNER: "hermes",
      },
    });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "hermes-home-intent-1",
      text: "帮我打开主卧灯",
      dryRun: true,
    });
    const audit = readJsonl(harness.paths.commandAuditPath).find((entry) => entry.input === "帮我打开主卧灯");

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
    });
    expect(hermes.calls).toHaveLength(1);
    expect(JSON.stringify(hermes.calls[0])).toContain("hcm_context");
    expect(JSON.stringify(hermes.calls[0])).toContain("HOME_INTENT_PLANNER_V1");
    expect(audit.stages).toContainEqual(expect.objectContaining({
      name: "planner_external",
      summary: expect.objectContaining({ source: "hermes_home_intent" }),
    }));
    expect(audit.execution.services).toContainEqual(
      expect.objectContaining({
        logicalRoomId: "master",
        serviceData: { entity_id: "light.master_light" },
      }),
    );
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("routes novel home language through Hermes Brain and HCM instead of generic chat", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const hermes = await startMockHermes((body) => {
      const systemPrompt = body.messages[0].content;
      if (systemPrompt.includes("统一入口意图分类器")) {
        return JSON.stringify({
          type: "home_intent",
          confidence: 0.97,
          reason: "用户希望调节当前房间照明",
        });
      }
      return JSON.stringify({
        intent_type: "device_control",
        intent: "打开次卧吸顶灯",
        confidence: 0.96,
        summary: "打开次卧吸顶灯。",
        needs_confirmation: false,
        actions: [{
          target: "次卧吸顶灯",
          room_id: "second",
          capability: "power",
          value: true,
          reason: "根据完整 HCM 上下文选中当前房间主照明",
        }],
      });
    });
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      hermesBaseUrl: hermes.url,
      env: {
        JARVIS_BRAIN_INTENT_CLASSIFIER: "hermes",
        JARVIS_BRAIN_INTENT_REQUIRED: "true",
        JARVIS_HOME_INTENT_PLANNER: "hermes",
        JARVIS_HOME_INTENT_REQUIRED: "true",
      },
    });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "hermes-unified-intent-1",
      text: "这屋有点暗，给点光",
      dryRun: true,
    });
    const [classificationCall, planningCall] = hermes.calls;
    const audit = readJsonl(harness.paths.commandAuditPath)[0];

    expect(result).toMatchObject({
      route: "hcm_slow_path",
      status: "needs_clarification",
    });
    expect(hermes.calls).toHaveLength(2);
    expect(classificationCall.messages[0].content).toContain("统一入口意图分类器");
    expect(classificationCall.messages.at(-1).content).toContain(
      JSON.stringify("这屋有点暗，给点光"),
    );
    expect(classificationCall.messages.at(-1).content).toContain(
      "[JARVIS_INTERNAL_INTENT_CLASSIFIER]",
    );
    expect(JSON.stringify(planningCall)).toContain("hcm_context");
    expect(JSON.stringify(planningCall)).toContain("HOME_INTENT_PLANNER_V1");
    expect(audit.stages).toContainEqual(expect.objectContaining({
      name: "planner_external",
      summary: expect.objectContaining({ source: "hermes_home_intent" }),
    }));
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("fails closed when the container requires Hermes HomeIntent and planning is unavailable", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const hermes = await startMockHermes("not valid planner json");
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      hermesBaseUrl: hermes.url,
      env: {
        JARVIS_HOME_INTENT_PLANNER: "hermes",
        JARVIS_HOME_INTENT_REQUIRED: "true",
      },
    });

    const reply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "打开次卧吸顶灯" }],
    });

    expect(reply.choices[0].message.content).toContain("为了安全我没有执行");
    expect(ha.serviceCalls).toHaveLength(0);
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("records successful Hermes HomeIntent plans and reuses the semantic planning cache", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const hermes = await startMockHermes((body) => {
      const input = JSON.parse(body.messages.at(-1).content).input;
      const value = !/关|关闭|关掉/.test(input);
      return JSON.stringify({
        intent_type: "device_control",
        intent: input,
        confidence: 0.95,
        summary: input,
        needs_confirmation: false,
        actions: [{
          target: "主卧主灯",
          room_id: "master",
          capability: "power",
          value,
          reason: "Hermes semantic plan",
        }],
      });
    });
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url, hermesBaseUrl: hermes.url });

    const first = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "semantic-cache-1",
      text: "帮我打开主卧灯",
      dryRun: true,
    });
    const second = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "semantic-cache-2",
      text: "帮我打开主卧灯",
      dryRun: true,
    });
    await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "semantic-cache-3",
      text: "帮我关闭主卧灯",
      dryRun: true,
    });
    const cache = await getJson(`${harness.url}/api/jarvis/semantic-cache`);
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const secondAudit = auditEntries.find((entry) => entry.commandId === second.commandId);

    expect(first).toMatchObject({ status: "dry_run" });
    expect(second).toMatchObject({ status: "dry_run" });
    expect(hermes.calls).toHaveLength(2);
    expect(secondAudit.stages).toContainEqual(expect.objectContaining({
      name: "planner_external",
      summary: expect.objectContaining({ source: "semantic_planning_cache" }),
    }));
    expect(cache).toMatchObject({
      activeEntryCount: expect.any(Number),
      hitCount: 1,
      missCount: 2,
      cacheExecutionCount: 1,
      cacheFailureCount: 0,
    });
    const cacheRecord = JSON.parse(readFileSync(harness.paths.semanticPlanningCachePath, "utf8"));
    expect(cacheRecord.entries[0].markdownPath).toMatch(/semantic_.*\.md$/);
    expect(existsSync(cacheRecord.entries[0].markdownPath)).toBe(true);
  }, 30000);

  it("rejects voice ingress outside configured room and text guards", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      env: {
        JARVIS_INGRESS_ALLOWED_ROOM_IDS: "second",
        JARVIS_INGRESS_REQUIRE_TEXT_PATTERN: "次卧",
      },
    });

    const rejected = await fetch(`${harness.url}/v1/utterance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "stackchan-study",
        roomId: "study",
        wakeSessionId: "ingress-blocked-1",
        text: "打开书房射灯",
        dryRun: true,
      }),
    });
    const accepted = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "ingress-allowed-1",
      text: "吸顶灯开着吗？",
      dryRun: true,
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: expect.stringContaining("Jarvis ingress rejected roomId"),
    });
    expect(accepted).toMatchObject({
      route: "hcm_fast_path",
      routeReason: "read_only_home_state_query",
    });
    expect(accepted.replyText).toContain("次卧吸顶灯");
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("answers explicit room device state as a single target instead of a room light aggregate", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createSecondRoomMultiLightGraph());
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "wake-second-ceiling-state-1",
      text: "次卧吸顶灯开着吗？",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      routeReason: "read_only_home_state_query",
      status: "answered",
      speak: true,
    });
    expect(result.replyText).toContain("次卧吸顶灯");
    expect(result.replyText).not.toContain("次卧入户射灯");
    expect(auditEntries[0].stages.map((stage) => stage.name)).toContain("brain_home_intent");
    expect(auditEntries[0].plan).toMatchObject({
      kind: "hcm_state_query",
      stateQuery: expect.objectContaining({
        thingName: "次卧吸顶灯",
      }),
    });
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("controls second-bedroom entry spotlight from polite speech without policy rejection", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createSecondRoomMultiLightGraph());
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "living",
      wakeSessionId: "wake-second-entry-spot-1",
      text: "帮我打开次卧入户射灯。",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
      speak: true,
    });
    expect(result.replyText).toContain("次卧入户射灯");
    expect(auditEntries[0].plan).toMatchObject({
      actionCount: 1,
      resolution: {
        targetStatus: "resolved",
        capabilityStatus: "resolved",
      },
    });
    expect(auditEntries[0].execution.services).toContainEqual(
      expect.objectContaining({
        thingName: "次卧入户射灯",
        value: true,
        serviceData: { entity_id: "light.second_entry_spot" },
      }),
    );
    expect(auditEntries[0].execution.rejected ?? []).toEqual([]);
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("handles household lighting synonyms and room category groups", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const masterSpots = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "wake-master-spots-1",
      text: "帮我打开主卧射灯。",
      dryRun: true,
    });
    const secondCeiling = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "wake-second-chandelier-1",
      text: "打开次卧吊灯。",
      dryRun: true,
    });
    const masterCeiling = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "wake-master-chandelier-1",
      text: "打开主卧吊灯。",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const masterAudit = auditEntries.find((entry) => entry.input === "帮我打开主卧射灯。");
    const secondAudit = auditEntries.find((entry) => entry.input === "打开次卧吊灯。");
    const masterCeilingAudit = auditEntries.find((entry) => entry.input === "打开主卧吊灯。");

    expect(masterSpots).toMatchObject({ route: "hcm_fast_path", status: "dry_run" });
    expect(masterAudit.execution.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ thingName: "主卧左射灯", serviceData: { entity_id: "light.master_left_spot" } }),
      expect.objectContaining({ thingName: "主卧右射灯", serviceData: { entity_id: "light.master_right_spot" } }),
    ]));

    expect(secondCeiling).toMatchObject({ route: "hcm_fast_path", status: "dry_run" });
    expect(secondAudit.execution.services).toContainEqual(
      expect.objectContaining({ thingName: "次卧吸顶灯", serviceData: { entity_id: "light.second_light" } }),
    );
    expect(masterCeiling).toMatchObject({ route: "hcm_fast_path", status: "dry_run" });
    expect(masterCeilingAudit.execution.services).toContainEqual(
      expect.objectContaining({ thingName: "主卧主灯", serviceData: { entity_id: "light.master_light" } }),
    );
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("rejects controls whose resolved entity is outside the stage whitelist", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      env: {
        JARVIS_ALLOWED_ENTITY_IDS: "light.second_light",
      },
    });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-master",
      roomId: "master",
      wakeSessionId: "entity-scope-block-1",
      text: "打开主卧主灯",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      status: "rejected",
    });
    expect(auditEntries[0].execution.services).toEqual([]);
    expect(auditEntries[0].stages).toContainEqual(
      expect.objectContaining({
        name: "entity_scope_gate",
        summary: expect.objectContaining({ rejected: 1, scopeEnabled: true }),
      }),
    );
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("keeps Stage-1 real control scoped by resolved action room without narrowing HCM to entity whitelists", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      env: {
        JARVIS_ALLOWED_ACTION_ROOM_IDS: "second",
      },
    });

    const rejected = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "room-scope-block-1",
      text: "打开主卧主灯",
      dryRun: true,
    });
    const accepted = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "room-scope-allow-1",
      text: "打开次卧吸顶灯",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const rejectedAudit = auditEntries.find((entry) => entry.input === "打开主卧主灯");
    const acceptedAudit = auditEntries.find((entry) => entry.input === "打开次卧吸顶灯");

    expect(rejected).toMatchObject({
      route: "hcm_fast_path",
      status: "rejected",
    });
    expect(rejectedAudit.execution.services).toEqual([]);
    expect(rejectedAudit.execution.rejected).toContainEqual(
      expect.objectContaining({
        code: "action_room_outside_stage_scope",
        roomIds: ["master"],
        allowedRoomIds: ["second"],
      }),
    );
    expect(rejectedAudit.stages).toContainEqual(
      expect.objectContaining({
        name: "action_room_scope_gate",
        summary: expect.objectContaining({ rejected: 1, scopeEnabled: true, allowedRooms: ["second"] }),
      }),
    );

    expect(accepted).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
    });
    expect(acceptedAudit.execution.services).toContainEqual(
      expect.objectContaining({
        logicalRoomId: "second",
        serviceData: { entity_id: "light.second_light" },
      }),
    );
    expect(acceptedAudit.stages).toContainEqual(
      expect.objectContaining({
        name: "action_room_scope_gate",
        summary: expect.objectContaining({ accepted: 1, rejected: 0, scopeEnabled: true, allowedRooms: ["second"] }),
      }),
    );
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("uses map-confirmed hallway semantics for HCM home, MCP context, and voice control", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createEntryHallGraph());
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });
    seedHallSpatialFile(harness.paths);

    const home = await getJson(`${harness.url}/api/hcm/home`);
    const tools = await postJson(`${harness.url}/mcp`, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
      params: {},
    });
    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "spatial-hall-voice-1",
      text: "关过道射灯",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const audit = auditEntries.find((entry) => entry.input === "关过道射灯");

    expect(home.spatialSemantic).toMatchObject({
      applied: true,
      assignedAssetCount: 4,
    });
    expect(home.spaces).toContainEqual(expect.objectContaining({ id: "custom_hall", name: "过道" }));
    expect(home.controlGraph.assets).toContainEqual(expect.objectContaining({
      id: "asset_entry_过道射灯1",
      name: "过道射灯1",
      spaceId: "custom_hall",
      roomName: "过道",
      baseSpaceId: "entry",
    }));
    expect(home.controlGraph.assets).toContainEqual(expect.objectContaining({
      id: "asset_entry_入户灯",
      spaceId: "entry",
      roomName: "入户",
    }));

    const toolText = JSON.stringify(tools.result.tools);
    expect(toolText).toContain("过道射灯1（过道");
    expect(toolText).toContain("过道射灯2（过道");

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
    });
    expect(audit.stages).toContainEqual(expect.objectContaining({
      name: "semantic_overlay",
      summary: expect.objectContaining({ spatial: true, spatialAssets: 4 }),
    }));
    expect(audit.execution.services.map((service) => service.logicalRoomId)).toEqual(["custom_hall", "custom_hall"]);
    expect(audit.execution.services.map((service) => service.thingName).sort()).toEqual(["过道射灯1", "过道射灯2"]);
    expect(audit.execution.rejected).toEqual([]);
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("allows whole-home low-risk targets when no Stage-1 room scope is configured", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const master = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "whole-home-master-1",
      text: "打开主卧主灯",
      dryRun: true,
    });
    const second = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "whole-home-second-1",
      text: "打开次卧吸顶灯",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);
    const masterAudit = auditEntries.find((entry) => entry.input === "打开主卧主灯");
    const secondAudit = auditEntries.find((entry) => entry.input === "打开次卧吸顶灯");

    expect(master).toMatchObject({ route: "hcm_fast_path", status: "dry_run" });
    expect(second).toMatchObject({ route: "hcm_fast_path", status: "dry_run" });
    expect(masterAudit.execution.services).toContainEqual(
      expect.objectContaining({
        logicalRoomId: "master",
        serviceData: { entity_id: "light.master_light" },
      }),
    );
    expect(secondAudit.execution.services).toContainEqual(
      expect.objectContaining({
        logicalRoomId: "second",
        serviceData: { entity_id: "light.second_light" },
      }),
    );
    expect(JSON.stringify(masterAudit.stages)).not.toContain("action_room_outside_stage_scope");
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("answers state questions through the HCM read-only path when Home Assistant is configured", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant();
    const hermes = await startMockHermes("Hermes should not answer this.");
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url, hermesBaseUrl: hermes.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "wake-state-hcm-1",
      text: "书房射灯开着吗",
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      routeReason: "read_only_home_state_query",
      status: "answered",
      speak: true,
    });
    expect(result.replyText).toContain("书房射灯");
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].plan).toMatchObject({
      kind: "hcm_state_query",
      intentType: "state_query",
    });
    expect(auditEntries[0].plan.actions ?? []).toEqual([]);
    expect(auditEntries[0].execution).toMatchObject({ status: "answered" });
    expect(auditEntries[0].execution.accepted ?? []).toEqual([]);
    expect(ha.serviceCalls).toHaveLength(0);
    expect(hermes.calls).toHaveLength(0);
  }, 30000);

  it("falls back to Hermes for state questions when Home Assistant is not configured", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("书房射灯现在是开的。");
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "wake-state-1",
      text: "书房射灯开着吗",
    });

    expect(result).toMatchObject({
      route: "hermes_slow_path",
      routeReason: "home_state_or_inventory_query",
      status: "answered",
      commandId: null,
      replyText: "书房射灯现在是开的。",
      speak: true,
    });
    expect(hermes.calls).toHaveLength(1);
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("returns a speakable failure instead of claiming state or control when configured HA is unreachable", async () => {
    const tempDir = createTempDir();
    const unavailablePort = await getFreePort();
    const harness = await startHarness({
      tempDir,
      haBaseUrl: `http://127.0.0.1:${unavailablePort}`,
    });

    const reply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "次卧吸顶灯开着吗" }],
    });

    expect(reply.choices[0].message.content).toContain("Home Assistant 现在连接不上");
    expect(reply.choices[0].message.content).toContain("没有读取或控制");
  }, 30000);

  it("returns a speakable timeout fallback when Hermes is too slow", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("迟到的回答", { delayMs: 200 });
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url, hermesTimeoutMs: 50 });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      wakeSessionId: "wake-timeout-1",
      text: "帮我总结今天要做什么",
    });

    expect(result).toMatchObject({
      route: "hermes_slow_path",
      status: "brain_timeout",
      speak: true,
      replyText: expect.stringContaining("响应超时"),
    });
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("routes Xiaozhi non-home agent tasks directly to Hermes", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("今天先处理 Jarvis 实物链路测试。");
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url });

    const reply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "帮我总结今天要做什么" }],
    });

    expect(reply.choices[0].message.content).toBe("今天先处理 Jarvis 实物链路测试。");
    expect(hermes.calls).toHaveLength(1);
    expect(hermes.calls[0].messages.at(-1)).toMatchObject({
      role: "user",
      content: "帮我总结今天要做什么",
    });
    expect(readJsonl(harness.paths.deliveryAuditPath)).toContainEqual(expect.objectContaining({
      source: "hermes_agent",
      status: "dispatched",
      voiceMode: "inline",
    }));
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("returns a Xiaozhi speakable fallback when Hermes agent tasks time out", async () => {
    const tempDir = createTempDir();
    const hermes = await startMockHermes("迟到的 Xiaozhi 回答", { delayMs: 200 });
    const harness = await startHarness({ tempDir, hermesBaseUrl: hermes.url, hermesTimeoutMs: 50 });

    const reply = await postJson(`${harness.url}/v1/chat/completions`, {
      model: "jarvis",
      messages: [{ role: "user", content: "帮我总结今天要做什么" }],
    });

    expect(reply.choices[0].message.content).toContain("响应超时");
    expect(existsSync(harness.paths.commandAuditPath)).toBe(false);
  }, 30000);

  it("applies spoken learning feedback from the voice utterance endpoint", async () => {
    const tempDir = createTempDir();
    const paths = harnessPaths(tempDir);
    seedLearningFeedbackFiles(paths);
    const harness = await startHarness({ tempDir });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      wakeSessionId: "wake-feedback-1",
      text: "可以",
    });
    const memory = JSON.parse(readFileSync(paths.learningMemoryPath, "utf8"));

    expect(result).toMatchObject({
      route: "learning_feedback",
      status: "feedback_applied",
      feedback: {
        appliedTo: "semantic",
        feedback: "accept",
      },
    });
    expect(memory.candidates[0]).toMatchObject({
      id: "candidate_study_light",
      status: "accepted",
      application: {
        mode: "semantic",
        sourceCommandId: "cmd-study-light",
      },
    });
  }, 30000);

  it("binds bare spoken feedback to the pending Jarvis prompt", async () => {
    const tempDir = createTempDir();
    const paths = harnessPaths(tempDir);
    seedPendingPromptLearningFiles(paths);
    const ha = await startMockHomeAssistant();
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const command = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      roomId: "study",
      wakeSessionId: "wake-prompt-1",
      text: "打开书房射灯",
      dryRun: true,
    });
    const feedback = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-study",
      wakeSessionId: "wake-prompt-2",
      text: "可以",
    });
    const memory = JSON.parse(readFileSync(paths.learningMemoryPath, "utf8"));
    const promptQueue = JSON.parse(readFileSync(paths.pendingPromptQueuePath, "utf8"));

    expect(command.learnedSuggestion).toMatchObject({
      candidateId: "candidate_打开书房射灯",
      pendingPromptId: expect.stringMatching(/^pending_/),
    });
    expect(feedback).toMatchObject({
      route: "learning_feedback",
      status: "feedback_applied",
      feedback: {
        appliedTo: "semantic",
        pendingPromptId: command.learnedSuggestion.pendingPromptId,
      },
    });
    expect(memory.candidates[0]).toMatchObject({
      id: "candidate_打开书房射灯",
      status: "accepted",
    });
    expect(promptQueue.prompts[0]).toMatchObject({
      id: command.learnedSuggestion.pendingPromptId,
      status: "accepted",
      feedback: "accept",
      deviceId: "stackchan-study",
      roomId: "study",
    });
  }, 30000);

  it("applies room priority for StackChan commands", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createBedroomGraph());
    const harness = await startHarness({
      tempDir,
      haBaseUrl: ha.url,
      stackchanDeviceRooms: { "stackchan-second": "second" },
    });

    const ambiguous = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-hall",
      wakeSessionId: "wake-bedroom-ambiguous",
      text: "卧室灯关一下",
      dryRun: true,
    });
    const livingBedroom = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-living",
      roomId: "living",
      wakeSessionId: "wake-bedroom-living",
      text: "卧室灯关一下",
      dryRun: true,
    });
    const scoped = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      wakeSessionId: "wake-bedroom-second",
      text: "灯关一下",
      dryRun: true,
    });
    const explicit = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-second",
      roomId: "second",
      wakeSessionId: "wake-bedroom-explicit",
      text: "关主卧灯",
      dryRun: true,
    });

    expect(ambiguous).toMatchObject({
      route: "hcm_fast_path",
      status: "needs_clarification",
      speak: true,
    });
    expect(livingBedroom).toMatchObject({
      route: "hcm_fast_path",
      status: "needs_clarification",
      speak: true,
    });
    expect(scoped).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
      speak: true,
    });
    expect(explicit).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
      speak: true,
    });
    expect(explicit.roomId).toBe("second");

    const explicitAudit = readJsonl(harness.paths.commandAuditPath).find((entry) => entry.input === "关主卧灯");
    expect(explicitAudit?.plan?.actionCount).toBe(1);
    expect(JSON.stringify(explicitAudit?.execution?.services ?? [])).toContain("master");
    expect(JSON.stringify(explicitAudit?.execution?.services ?? [])).not.toContain("second");
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);

  it("routes low-risk non-light devices through HCM policy", async () => {
    const tempDir = createTempDir();
    const ha = await startMockHomeAssistant(createFanGraph());
    const harness = await startHarness({ tempDir, haBaseUrl: ha.url });

    const result = await postJson(`${harness.url}/v1/utterance`, {
      deviceId: "stackchan-living",
      roomId: "living",
      wakeSessionId: "wake-fan-1",
      text: "打开客厅风扇",
      dryRun: true,
    });
    const auditEntries = readJsonl(harness.paths.commandAuditPath);

    expect(result).toMatchObject({
      route: "hcm_fast_path",
      status: "dry_run",
      speak: true,
    });
    expect(auditEntries[0].plan.actionCount).toBe(1);
    expect(JSON.stringify(auditEntries[0].execution.services)).toContain("fan");
    expect(auditEntries[0].stages.map((stage) => stage.name)).toContain("policy_gate");
    expect(ha.serviceCalls).toHaveLength(0);
  }, 30000);
});

async function startHarness({ tempDir, haBaseUrl = "", hermesBaseUrl = "", hermesTimeoutMs = 3500, stackchanDeviceRooms = null, env = {} }) {
  const port = await getFreePort();
  const paths = harnessPaths(tempDir);
  const output = [];
  const child = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      OPENAI_API_KEY: "",
      HA_BASE_URL: haBaseUrl,
      HA_TOKEN: haBaseUrl ? "test-token" : "",
      HOME_ASSISTANT_URL: "",
      HOME_ASSISTANT_TOKEN: "",
      HERMES_API_BASE_URL: hermesBaseUrl,
      HERMES_API_URL: "",
      HERMES_API_KEY: "",
      HERMES_API_TRANSPORT: "api",
      HERMES_API_TIMEOUT_MS: String(hermesTimeoutMs),
      JARVIS_BRAIN_INTENT_CLASSIFIER: "",
      JARVIS_BRAIN_INTENT_REQUIRED: "false",
      JARVIS_BRAIN_INTENT_TIMEOUT_MS: "20000",
      HERMES_CLI_PYTHON: "",
      JARVIS_SUBAGENT_COMMAND: "",
      JARVIS_SUBAGENT_ARGS: "",
      JARVIS_SUBAGENT_CWD: "",
      HARNESS_EXECUTION_MODE: "dry_run",
      HARNESS_HCM_OVERLAY_PATH: paths.hcmOverlayPath,
      HARNESS_COMMAND_AUDIT_PATH: paths.commandAuditPath,
      HARNESS_LEARNING_MEMORY_PATH: paths.learningMemoryPath,
      HARNESS_PROVIDER_SNAPSHOT_PATH: paths.providerSnapshotPath,
      HARNESS_AUTOMATION_MEMORY_PATH: paths.automationMemoryPath,
      HARNESS_SPATIAL_EDITOR_PATH: paths.spatialEditorPath,
      JARVIS_PENDING_PROMPT_QUEUE_PATH: paths.pendingPromptQueuePath,
      JARVIS_DELIVERY_AUDIT_PATH: paths.deliveryAuditPath,
      JARVIS_TASK_AUDIT_PATH: paths.taskAuditPath,
      JARVIS_PC_WORKSPACE_ROOT: paths.pcWorkspaceRoot,
      JARVIS_CONTEXT_MEMORY_PATH: paths.contextMemoryPath,
      JARVIS_SEMANTIC_CACHE_PATH: paths.semanticPlanningCachePath,
      JARVIS_OBSIDIAN_SEMANTIC_DIR: paths.semanticPlanningObsidianDir,
      JARVIS_UTTERANCE_DEDUPE_WINDOW_MS: "3000",
      JARVIS_STACKCHAN_DEVICE_ROOMS: stackchanDeviceRooms ? JSON.stringify(stackchanDeviceRooms) : "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  cleanupTasks.push(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  });
  await waitForHttp(`http://127.0.0.1:${port}/api/runtime/status`, () => output.join(""));
  return { url: `http://127.0.0.1:${port}`, paths, output };
}

async function startMockHomeAssistant(graph = createStudyLightGraph()) {
  const serviceCalls = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/states") {
      sendJson(response, graph.states);
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/api/services/")) {
      const body = await readBody(request);
      serviceCalls.push({ url: request.url, body: body ? JSON.parse(body) : null });
      sendJson(response, [{
        entity_id: "light.study_spotlight",
        state: "on",
        attributes: { friendly_name: "书房射灯", supported_features: 0 },
      }]);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (request.url !== "/api/websocket") {
      socket.destroy();
      return;
    }
    acceptWebSocket(request, socket);
    sendWs(socket, { type: "auth_required" });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let frame;
      while ((frame = readWsFrame(buffer))) {
        buffer = frame.remaining;
        const message = JSON.parse(frame.text);
        if (message.type === "auth") {
          sendWs(socket, { type: "auth_ok" });
          continue;
        }
        if (!message.id) continue;
        sendWs(socket, {
          id: message.id,
          type: "result",
          success: true,
          result: registryResult(graph, message.type),
        });
      }
    });
  });
  await listen(server);
  cleanupTasks.push(() => closeServer(server, sockets));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, serviceCalls };
}

async function startMockHermes(replyText, { delayMs = 0, statusCode = 200 } = {}) {
  const calls = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = JSON.parse(await readBody(request));
      calls.push(body);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (statusCode !== 200) {
        response.statusCode = statusCode;
        response.end("hermes failed");
        return;
      }
      const content = typeof replyText === "function" ? replyText(body) : replyText;
      sendJson(response, { choices: [{ message: { content } }] });
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listen(server);
  cleanupTasks.push(() => closeServer(server, sockets));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, calls };
}

function createStudyLightGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [{ area_id: "study", name: "书房" }],
    devices: [{
      id: "study-light",
      name: "书房射灯",
      area_id: "study",
      manufacturer: "Fixture",
      model: "Light 1",
      identifiers: [["xiaomi_home", "study-light"]],
    }],
    entities: [{
      entity_id: "light.study_spotlight",
      device_id: "study-light",
      platform: "xiaomi_home",
      original_name: "射灯",
    }],
    states: [{
      entity_id: "light.study_spotlight",
      state: "off",
      attributes: { friendly_name: "书房射灯", brightness: 0, supported_features: 0 },
    }],
  };
}

function createStudyAndSecondLightGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [
      { area_id: "study", name: "书房" },
      { area_id: "second", name: "次卧" },
    ],
    devices: [
      { id: "study-chandelier", name: "书房吊灯", area_id: "study", manufacturer: "Fixture", model: "Light" },
      { id: "second-ceiling", name: "次卧吸顶灯", area_id: "second", manufacturer: "Fixture", model: "Light" },
    ],
    entities: [
      { entity_id: "light.study_chandelier", device_id: "study-chandelier", platform: "xiaomi_home", original_name: "吊灯" },
      { entity_id: "light.second_ceiling", device_id: "second-ceiling", platform: "xiaomi_home", original_name: "吸顶灯" },
    ],
    states: [
      { entity_id: "light.study_chandelier", state: "off", attributes: { friendly_name: "书房吊灯", supported_features: 0 } },
      { entity_id: "light.second_ceiling", state: "on", attributes: { friendly_name: "次卧吸顶灯", supported_features: 0 } },
    ],
  };
}

function createBedroomGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [
      { area_id: "master", name: "主卧" },
      { area_id: "second", name: "次卧" },
    ],
    devices: [
      { id: "master-light", name: "主卧主灯", area_id: "master", manufacturer: "Fixture", model: "Light" },
      { id: "master-left-spot", name: "主卧左射灯", area_id: "master", manufacturer: "Fixture", model: "Light" },
      { id: "master-right-spot", name: "主卧右射灯", area_id: "master", manufacturer: "Fixture", model: "Light" },
      { id: "second-light", name: "次卧吸顶灯", area_id: "second", manufacturer: "Fixture", model: "Light" },
    ],
    entities: [
      { entity_id: "light.master_light", device_id: "master-light", platform: "xiaomi_home", original_name: "主灯" },
      { entity_id: "light.master_left_spot", device_id: "master-left-spot", platform: "xiaomi_home", original_name: "左射灯" },
      { entity_id: "light.master_right_spot", device_id: "master-right-spot", platform: "xiaomi_home", original_name: "右射灯" },
      { entity_id: "light.second_light", device_id: "second-light", platform: "xiaomi_home", original_name: "吸顶灯" },
    ],
    states: [
      { entity_id: "light.master_light", state: "on", attributes: { friendly_name: "主卧主灯", supported_features: 0 } },
      { entity_id: "light.master_left_spot", state: "off", attributes: { friendly_name: "主卧左射灯", supported_features: 0 } },
      { entity_id: "light.master_right_spot", state: "off", attributes: { friendly_name: "主卧右射灯", supported_features: 0 } },
      { entity_id: "light.second_light", state: "on", attributes: { friendly_name: "次卧吸顶灯", supported_features: 0 } },
    ],
  };
}

function createSecondRoomMultiLightGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [
      { area_id: "second", name: "次卧" },
    ],
    devices: [
      { id: "second-ceiling", name: "次卧吸顶灯", area_id: "second", manufacturer: "Fixture", model: "Light" },
      { id: "second-entry-spot", name: "次卧入户射灯", area_id: "second", manufacturer: "Fixture", model: "Light" },
    ],
    entities: [
      { entity_id: "light.second_ceiling", device_id: "second-ceiling", platform: "xiaomi_home", original_name: "吸顶灯" },
      { entity_id: "light.second_entry_spot", device_id: "second-entry-spot", platform: "xiaomi_home", original_name: "入户射灯" },
    ],
    states: [
      { entity_id: "light.second_ceiling", state: "on", attributes: { friendly_name: "次卧吸顶灯", supported_features: 0 } },
      { entity_id: "light.second_entry_spot", state: "off", attributes: { friendly_name: "次卧入户射灯", supported_features: 0 } },
    ],
  };
}

function createEntryHallGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [{ area_id: "entry", name: "入户" }],
    devices: [{
      id: "entry-panel",
      name: "入户三号开关",
      area_id: "entry",
      manufacturer: "UWIZE",
      model: "topwit.switch.rzw33",
    }],
    entities: [
      { entity_id: "switch.hall_spot_1", device_id: "entry-panel", platform: "xiaomi_home", original_name: "过道射灯1" },
      { entity_id: "switch.hall_spot_2", device_id: "entry-panel", platform: "xiaomi_home", original_name: "过道射灯2" },
      { entity_id: "switch.hall_strip", device_id: "entry-panel", platform: "xiaomi_home", original_name: "过道灯带" },
      { entity_id: "switch.entry_light", device_id: "entry-panel", platform: "xiaomi_home", original_name: "入户灯" },
    ],
    states: [
      { entity_id: "switch.hall_spot_1", state: "on", attributes: { friendly_name: "过道射灯1", supported_features: 0 } },
      { entity_id: "switch.hall_spot_2", state: "on", attributes: { friendly_name: "过道射灯2", supported_features: 0 } },
      { entity_id: "switch.hall_strip", state: "off", attributes: { friendly_name: "过道灯带", supported_features: 0 } },
      { entity_id: "switch.entry_light", state: "off", attributes: { friendly_name: "入户灯", supported_features: 0 } },
    ],
  };
}

function createFanGraph() {
  return {
    provider: { id: "home_assistant", name: "Home Assistant" },
    fetchedAt: "2026-07-01T00:00:00.000Z",
    areas: [{ area_id: "living", name: "客厅" }],
    devices: [
      { id: "living-fan", name: "客厅风扇", area_id: "living", manufacturer: "Fixture", model: "Fan" },
    ],
    entities: [
      { entity_id: "fan.living_fan", device_id: "living-fan", platform: "xiaomi_home", original_name: "风扇" },
    ],
    states: [
      { entity_id: "fan.living_fan", state: "off", attributes: { friendly_name: "客厅风扇", supported_features: 0 } },
    ],
  };
}

function seedHallSpatialFile(paths) {
  writeFileSync(paths.spatialEditorPath, `${JSON.stringify({
    version: "0.1",
    updatedAt: "2026-07-03T20:02:31.123Z",
    source: "test",
    state: {
      customRooms: [{ id: "custom_hall", name: "过道", type: "generic" }],
      roomNames: { custom_hall: "过道" },
      deviceAssignments: {
        "asset_entry_过道射灯1": "custom_hall",
        "asset_entry_过道射灯2": "custom_hall",
        "asset_entry_过道灯带": "custom_hall",
        "asset_entry_入户灯": "entry",
      },
    },
  }, null, 2)}\n`);
}

function seedLearningFeedbackFiles(paths) {
  writeFileSync(paths.commandAuditPath, `${JSON.stringify({
    commandId: "cmd-study-light",
    input: "打开书房射灯",
    status: "dry_run",
    execution: {
      services: [{
        thingId: "ha_study-light",
        thingName: "书房射灯",
        capabilityId: "study_spotlight",
        capabilityName: "射灯",
        service: "light.turn_on",
        value: true,
      }],
    },
    safety: { level: "low", confirmationRequired: false },
  })}\n`);
  writeFileSync(paths.learningMemoryPath, `${JSON.stringify({
    version: "0.1",
    updatedAt: "2026-07-01T00:00:00.000Z",
    mode: "shadow",
    observations: [],
    candidates: [{
      id: "candidate_study_light",
      type: "semantic_mapping",
      status: "shadow",
      input: "打开书房射灯",
      commandKey: "打开书房射灯",
      count: 2,
      confidence: 0.8,
      actions: [],
      examples: ["打开书房射灯"],
      safety: {
        level: "low",
        autoApply: false,
        reason: "学习候选默认仅 shadow，不自动执行",
      },
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    tombstones: [],
  }, null, 2)}\n`);
}

function seedPendingPromptLearningFiles(paths) {
  writeFileSync(paths.learningMemoryPath, `${JSON.stringify({
    version: "0.1",
    updatedAt: "2026-07-01T00:00:00.000Z",
    mode: "shadow",
    observations: [
      learningObservation("seed-cmd-1", "2026-07-01T00:00:00.000Z"),
      learningObservation("seed-cmd-2", "2026-07-01T00:01:00.000Z"),
    ],
    candidates: [{
      id: "candidate_打开书房射灯",
      type: "semantic_mapping",
      status: "shadow",
      input: "打开书房射灯",
      commandKey: "打开书房射灯",
      count: 2,
      confidence: 0.8,
      actions: [],
      examples: ["打开书房射灯"],
      safety: {
        level: "low",
        autoApply: false,
        reason: "学习候选默认仅 shadow，不自动执行",
      },
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    tombstones: [],
  }, null, 2)}\n`);
}

function learningObservation(id, observedAt) {
  return {
    id,
    observedAt,
    input: "打开书房射灯",
    path: "hcm-real",
    status: "dry_run",
    success: true,
    actions: [{
      thingId: "ha_study-light",
      thingName: "书房射灯",
      capabilityId: "study_spotlight",
      capabilityName: "射灯",
      service: "light.turn_on",
    }],
    safety: { level: "low", confirmationRequired: false },
  };
}

function registryResult(graph, type) {
  if (type === "config/device_registry/list") return graph.devices;
  if (type === "config/entity_registry/list") return graph.entities;
  if (type === "config/area_registry/list") return graph.areas;
  return [];
}

function acceptWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
}

function sendWs(socket, data) {
  const payload = Buffer.from(JSON.stringify(data));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function readWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (length === 127) throw new Error("large websocket frames are not supported in tests");
  const masked = Boolean(buffer[1] & 0x80);
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += masked ? 4 : 0;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  if (opcode === 8) return { text: "{}", remaining: buffer.subarray(offset + length) };
  return { text: payload.toString("utf8"), remaining: buffer.subarray(offset + length) };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return json;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return json;
}

async function waitForTaskStatus(baseUrl, status) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const list = await getJson(`${baseUrl}/api/tasks?limit=5`);
    const task = list.tasks?.find((item) => item.status === status);
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for task status ${status}`);
}

async function waitForHttp(url, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}\n${output()}`);
}

function harnessPaths(tempDir) {
  return {
    hcmOverlayPath: join(tempDir, "home-model-overlay.local.json"),
    commandAuditPath: join(tempDir, "command-audit.local.jsonl"),
    learningMemoryPath: join(tempDir, "learning-memory.local.json"),
    providerSnapshotPath: join(tempDir, "provider-snapshot.local.json"),
    automationMemoryPath: join(tempDir, "automation-memory.local.json"),
    spatialEditorPath: join(tempDir, "spatial-editor.local.json"),
    pendingPromptQueuePath: join(tempDir, "pending-prompts.local.json"),
    deliveryAuditPath: join(tempDir, "delivery-audit.local.jsonl"),
    taskAuditPath: join(tempDir, "task-audit.local.jsonl"),
    pcWorkspaceRoot: join(tempDir, "pc-workspace"),
    contextMemoryPath: join(tempDir, "jarvis-context.local.json"),
    semanticPlanningCachePath: join(tempDir, "semantic-planning-cache.local.json"),
    semanticPlanningObsidianDir: join(tempDir, "obsidian-jarvis", "semantic-plans"),
  };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

async function closeServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  server.close();
  await Promise.race([
    once(server, "close"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

function createTempDir() {
  const tempDir = mkdtempSync(join(tmpdir(), `jarvis-routes-${randomUUID()}-`));
  cleanupTasks.push(() => rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
}

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}
