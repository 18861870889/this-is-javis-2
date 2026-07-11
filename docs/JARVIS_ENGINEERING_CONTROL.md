# Jarvis Engineering Control

## Operating Model

User and main Codex thread are the product, architecture, and release decision owners.

Code agent owns bounded PC-side implementation tasks in this repository.

Test agent owns verification plans, automated tests, smoke tests, and release gates. It treats StackChan as a black-box input device and simulates it through transport payloads.

Firmware agent owns StackChan firmware work in a separate firmware repository only. It must keep factory/full-flash backups out of Git, pass host/build checks before flashing, and wait for an explicit release decision before writing to a physical device.

## Non-Negotiables

- This PC repository owns Jarvis Brain ingress, intent recognition, dedupe, HCM safety execution, learning, restricted PC automation, Hermes/Jarvis Agent handoff, and Delivery Router status.
- StackChan firmware changes are allowed only in the dedicated firmware workspace/repository after backup and smoke-build gates pass.
- Home Assistant control must pass HCM grounding, safety, policy, simulation, decision review, and audit.
- PC automation must be tool-scoped. No arbitrary shell, arbitrary path, or broad filesystem write is allowed through voice.
- Accepted learning and automation suggestions are guidance only; they do not bypass HCM.
- Real device execution stays behind dry-run and release gates until verification is stable.
- Jarvis, bridge, WebSocket, MCP, TTS/STT, and LLM gateway ports must follow `docs/SECURITY_BASELINE.md`; no raw public exposure is allowed.

## Decision Log

| ID | Decision | Rationale | Status |
| --- | --- | --- | --- |
| D001 | StackChan is black-box voice/display hardware. | Keeps devices stable and lets the PC bridge evolve independently. | Accepted |
| D002 | All ingress reaches Jarvis Brain before business routing. | StackChan/Xiaozhi/MCP are adapters; Brain owns intent recognition and emits `HomeIntent` for home tasks. | Implemented baseline |
| D003 | HCM consumes `HomeIntent` and owns home-control safety runtime behavior. | HCM grounds the intent to HCM devices, applies safety/policy/scope gates, simulates HA, executes, verifies state, and audits. | Implemented baseline |
| D004 | Non-home tasks go to Hermes/Jarvis Agent, not HCM. | Ordinary conversation, web research, PC work, file generation, and WeChat-side interactions are agent tasks unless they become a home `HomeIntent`. | Accepted |
| D005 | Self-evolution must be user-visible through suggestions, feedback, and accepted guidance. | Silent habit records are not a product feature unless they affect later behavior explainably. | Implemented baseline |
| D006 | Proactive AI M1 only supports L1/L2. | Jarvis may observe, suggest, and ask for confirmation, but must not auto-execute proactive actions in M1. | Accepted |
| D007 | Room priority is explicit target room, then trusted StackChan/source room, then clarification. | Saying "关主卧灯" in another room must still target the master bedroom; saying "关灯" may use the source room; saying "卧室灯" outside a bedroom must ask. | Implemented |
| D008 | Real control scope excludes strong safety devices; all other devices still pass HCM policy. | Doors, locks, gas, water valves, and alarms need hard protection; lights, fans, covers, climate, media, and similar devices may be included only through HCM grounding, policy, simulation, and audit. | Implemented baseline |
| D009 | Jarvis ports are private by default and public exposure is prohibited. | Public scans are routine; exposing HTTP/WebSocket/MCP or bridge ports can leak secrets and camera/home-control capability. | Implemented baseline |
| D010 | Xiaozhi local Server remains the first ASR/TTS runtime; Jarvis exposes `/v1/chat/completions` as the replaceable brain. | This preserves Xiaozhi's tuned voice pipeline while moving intent recognition, HCM, HA, agent tasks, PC tools, and delivery into Jarvis. | Implemented baseline |
| D011 | PC automation starts with a restricted Markdown writer under `JARVIS_PC_WORKSPACE_ROOT`. | It proves StackChan-to-PC operation while broader low-risk PC actions remain Hermes/Jarvis Agent work. | Implemented baseline |
| D012 | StackChan firmware changes live in a separate firmware repo and require full-flash backup plus build/smoke gates. | Device recovery must be possible before changing wake word, OTA, or websocket behavior. | Accepted |
| D013 | Delivery Router is the delivery boundary for StackChan/Xiaozhi/MCP-originated output. | Task results should produce a short StackChan voice summary, optional richer WeChat message, and delivery/audit status; direct Hermes WeChat chat must not trigger this router. | Implemented M0 |

## M0: PC-Side Verifiable Loop

Goal: prove the PC-side brain can accept voice text, dedupe multi-room inputs, recognize intent, emit `HomeIntent` for home tasks, execute home actions only through HCM gates, hand non-home work to Hermes/Jarvis Agent, and accept spoken learning feedback.

Status: implemented with automated verification.

Evidence:

```bash
npm test -- --run src/jarvisBrain.test.js src/jarvisVoiceBridge.test.js src/jarvisLearningFeedback.test.js src/jarvisServerRoutes.test.js src/hcmStateQuery.test.js src/automationSuggestionEngine.test.js src/learningLayer.test.js
node --check server.mjs
```

Current result: focused Jarvis suite passes.

Full regression status: passing, 47 test files and 310 tests.

## M1: Stabilize The Product Contract

1. Resolve the HCM bedroom ambiguity decision:
   - Generic "卧室灯" asks clarification when multiple bedrooms exist.
   - Trusted `currentRoomId` / `selectedRoomId` / focus room context may narrow the command to that room.
   - Brain HomeIntent carries trusted room context only when the user did not name a specific target room.
   - Explicit room names in the utterance override StackChan/source room context.
   - Status: implemented.

2. Add a pending prompt queue:
   - Store the exact learning or automation suggestion that was spoken to the user.
   - Bind "可以 / 别这样 / 撤销" to that pending item instead of relying on latest command audit.
   - Bare feedback only matches a pending prompt with compatible device, room, or session context.
   - Status: implemented for learning and automation suggestion feedback.

3. Harden Hermes/Jarvis Agent handoff:
   - Add timeout.
   - Add speakable error fallback.
   - Add contract tests once the real agent service is selected.
   - Status: timeout and speakable fallback implemented for current Hermes slow path; restricted PC Markdown tasks now bypass Hermes text slow-path and run through Jarvis Agent Task handling.

4. Define the PC Voice Bridge transport contract:
   - Required fields for `/v1/utterance`.
   - Recommended HTTP/MQTT/HA Assist adapter shape.
   - Explicitly document that no StackChan firmware modification is required.
   - Status: HTTP Bridge contract documented in `docs/JARVIS_STACKCHAN_HTTP_BRIDGE.md`.

5. Add latency benchmarks:
   - Duplicate response target: under 100 ms.
   - Mock HA fast path target: under 1 s.
   - Real HA dry-run target: under 2 s.
   - Status: smoke benchmark added via `npm run jarvis:latency`; duplicate and fast-path route assertions are enforced.

6. Decide the first real StackChan integration route:
   - HTTP callback bridge.
   - MQTT bridge.
   - Home Assistant Assist pipeline.
   - Serial/local bridge.
   - Status: HTTP Bridge selected for first arrival validation.

7. Add proactive opportunity detection foundation:
   - Unattended room lights.
   - Repeated routine suggestions.
   - PC meeting/focus interruption suppression.
   - Status: pure shadow detector implemented; no proactive auto-execution.

## Current Open Risks

- Dedupe is process-local; multi-container deployment needs Redis, SQLite, or an event bus.
- Hermes/Jarvis Agent protocol is assumed to be OpenAI-compatible until verified.
- Proactive detector output is not wired to voice/UI delivery yet; it is currently a tested shadow foundation.
- Delivery Router M0 is in memory and process-local; multi-process deployments need a shared queue/store.
- WeChat delivery is wired through Hermes `send_message_tool` but remains behind `JARVIS_DELIVERY_WECHAT_ENABLED=true` to avoid accidental real messages.
- Medium-risk confirmation is currently conservative: many medium-risk capabilities are rejected or held for confirmation instead of having a full "confirm then execute pending action" voice loop.

## Delivery Router M0

Implemented behavior:

- Applies only to StackChan/Xiaozhi/MCP-originated work, including `/v1/utterance`, Xiaozhi `/v1/chat/completions`, and Jarvis MCP tools.
- Explicitly skips direct WeChat/Hermes chat origins; if the user messages Hermes in WeChat, Hermes should answer there normally without Jarvis Delivery Router.
- Adds `delivery` metadata to routed results without replacing HCM command status, HCM audit, or MCP structured content.
- Writes delivery audit entries to `JARVIS_DELIVERY_AUDIT_PATH`, defaulting to `data/delivery-audit.local.jsonl`.
- Home control and state-query results use short StackChan/Xiaozhi voice delivery by default.
- Restricted PC Markdown creation uses voice plus optional WeChat detail delivery.
- Hermes WeChat delivery uses Hermes' own `send_message_tool` when `JARVIS_DELIVERY_WECHAT_ENABLED=true`; tests and normal dry runs keep this disabled.

Boundary:

- M0 does not yet persist the voice queue outside memory.
- M0 does not yet implement rich priority arbitration beyond recording delivery status.
- Long-form Hermes/Jarvis Agent task delivery is now represented by Task Runtime M1; real multi-step agent progress streaming remains future work.

## M1/M2 Agent And HomeIntent Contract

Implemented behavior:

- StackChan/Xiaozhi PC file requests such as "新建一个小黑文文件并写入 helloworld" are handled as local Agent Tasks, not Hermes text slow-path.
- PC file creation remains restricted to Markdown files inside `JARVIS_PC_WORKSPACE_ROOT`.
- Long-running Hermes tasks such as "写一个 app" create an in-memory Task Runtime record, immediately return a short voice acknowledgement, and continue in the background.
- Task status can be queried through `/api/tasks`, `/api/tasks/:taskId`, or by voice phrases like "刚才那个 app 做到哪了".
- Task audit entries write to `JARVIS_TASK_AUDIT_PATH`.
- Hermes HomeIntent planning is attempted by default when a Hermes API base URL is configured; set `JARVIS_HOME_INTENT_PLANNER=off` to force local deterministic Brain behavior.
- Hermes HomeIntent receives compact HCM context including rooms, devices, capabilities, state, policy, learning hints, and conversation focus.
- Hermes HomeIntent output is still only a planner draft; HCM remains responsible for grounding, safety, dry-run/real execution, HA calls, state verification, and audit.

Boundary:

- Task Runtime M1 is process-local and in-memory; a multi-process/container deployment needs SQLite, Redis, or another durable queue.
- Hermes long-task execution currently reports start/completion/failure summaries; fine-grained streaming progress from Hermes tools is not implemented yet.
- Hermes HomeIntent adds latency and has a strict fallback: timeout, unavailable, or invalid JSON falls back to local Brain behavior.

## M3 Context, Cache, And Subagent Contract

Implemented behavior:

- Short-term context memory persists recent PC files and task summaries in `JARVIS_CONTEXT_MEMORY_PATH`.
- Follow-up file questions such as "刚才的文件目录是哪个" are answered from context before PC-file parsing or Hermes slow path.
- Semantic planning cache stores successful home-control planner drafts in `JARVIS_SEMANTIC_CACHE_PATH` and writes Obsidian-compatible Markdown notes under `JARVIS_OBSIDIAN_SEMANTIC_DIR`.
- Semantic cache hits may skip Hermes HomeIntent planning, but still enter HCM grounding, safety, policy, simulation, execution, verification, and audit.
- Long tasks use a real configured subprocess subagent when `JARVIS_SUBAGENT_COMMAND` is set. Success and failure both write Task Runtime status and Delivery Router audit.
- North star and core metrics live in `docs/JARVIS_METRICS.md`.

Boundary:

- Context memory and semantic cache are local JSON files in M3; container/multi-PC deployments need SQLite or another shared store.
- Semantic matching is conservative normalized-key matching; fuzzy embeddings are future work.
- Subagent M3 uses a subprocess JSON contract; richer Hermes worker pools and streaming progress remain future work.
