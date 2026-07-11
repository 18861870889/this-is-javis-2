# Jarvis Voice Entry Verification Plan

## Scope

This plan verifies the PC-side Jarvis/Harness House implementation for voice entry, Jarvis Brain intent recognition, `HomeIntent` handoff to HCM, learning feedback, multi-entry dedupe, and delivery status.

StackChan/stackchen/m5stack devices are treated as black-box voice terminals. Verification must not require modifying device firmware or device-side source code.

## Test Strategy

1. Unit tests verify Brain intent recognition, `HomeIntent` payload construction, HCM safety semantics, learning state transitions, and automation suggestion safety semantics.
2. HTTP integration tests start the real `server.mjs` process and simulate external callers through `/v1/utterance` and `/v1/learning/feedback`.
3. Mock services replace real hardware and cloud dependencies:
   - Mock Home Assistant provides `/api/states`, registry WebSocket responses, and optional service-call responses.
   - Mock Hermes/Jarvis Agent provides an OpenAI-compatible `/v1/chat/completions` agent path.
   - StackChan is represented only by HTTP payload fields such as `deviceId`, `roomId`, and `wakeSessionId`.
4. Manual smoke tests validate local deployment wiring, latency, and logs before any real home device is allowed.

## Verification Matrix

| Capability | Automated Coverage | Required Environment | Pass Criteria | Known Gap |
| --- | --- | --- | --- | --- |
| Multiple StackChan devices heard the same command | `src/jarvisVoiceBridge.test.js`, `src/jarvisServerRoutes.test.js` | Local Node test process; mock HA | Same `wakeSessionId + text` returns one HCM audit entry; duplicate response has `route: duplicate_ignored`, `speak: false`, and points to the first `handledByDeviceId` | Process-local dedupe only; multi-process/container dedupe needs Redis/SQLite/HA event id |
| Brain HomeIntent for simple voice control | `src/jarvisBrain.test.js`, `src/jarvisVoiceBridge.test.js`, `src/jarvisServerRoutes.test.js` | Mock HA registry/state service; no `OPENAI_API_KEY` | `/v1/utterance` enters Brain, emits `HomeIntent`, audit stages include `brain_home_intent`, and stages do not include `llm_planner` | M0 Brain recognition uses local deterministic rules; future prompt/model recognition needs contract tests |
| Brain HomeIntent does not require OpenAI key | `src/jarvisBrain.test.js`, `src/jarvisServerRoutes.test.js` | `OPENAI_API_KEY=""`; mock HA configured | Simple home command does not fail with model config error; HCM safety/policy/simulation/audit stages still run after `brain_home_intent` | Complex home intent recognition will need prompt/model contract tests once enabled |
| Room priority for StackChan commands | `src/jarvisVoiceBridge.test.js`, `src/jarvisServerRoutes.test.js`, `src/hcmPlanner.test.js` | Mock HA bedroom graph; optional `JARVIS_STACKCHAN_DEVICE_ROOMS` | Explicit target room wins over source room; no explicit room may use trusted device room; "卧室灯" from a non-bedroom source asks for clarification | PC-side registry is environment-based for M1; a UI editor can come later |
| Non-light device controls | `src/jarvisServerRoutes.test.js`, `src/policyEngine.test.js` | Mock HA fan/cover/media fixtures | Non-safety devices are not hard-limited to lights; accepted actions still pass HCM grounding, policy, simulation, and audit | Medium-risk confirmation is conservative until pending-action execution exists |
| Strong safety devices | `src/policyEngine.test.js`, HA catalog tests | Mock policy items and HA catalog fixtures | Locks, gas devices, water valves, valves, and alarm-like targets are blocked even if an adapter mislabels risk | Future "strong confirmation" design is not implemented in M1 |
| State query reads real home state without control | `src/jarvisBrain.test.js`, `src/jarvisVoiceBridge.test.js`, `src/jarvisServerRoutes.test.js`, `src/hcmStateQuery.test.js` | Mock HA configured; optional mock Hermes to prove it is not called | "书房射灯开着吗" becomes a Brain `HomeIntent` state query; HCM plan is `hcm_state_query`; no HA service call is made; explicit targets such as "次卧吸顶灯开着吗" do not return room-level aggregates | More state-query phrasings and device classes need fixture coverage |
| State query fallback when HA is unavailable | `src/jarvisServerRoutes.test.js` | HA intentionally unconfigured; mock Hermes configured | "书房射灯开着吗" can fall back to agent path and creates no HCM command audit entry | Hermes may not know live HA state unless we later provide read-only tools/context |
| Learning feedback accept/reject/undo | `src/jarvisLearningFeedback.test.js`, `src/jarvisPendingPromptQueue.test.js`, `src/jarvisServerRoutes.test.js` | Temp audit, learning memory, and pending prompt files | `accept` marks candidate `accepted` with `application`; `reject` marks `ignored`; `undo` tombstones the candidate; bare "可以" binds to the latest pending prompt when present | Feedback falls back to latest compatible audit only when there is no pending prompt |
| Automation accepted remains shadow | `src/automationSuggestionEngine.test.js` | Fixture HCM home and audit entries | Accepted suggestions appear in `activeSuggestions`; memory mode remains `shadow`; `autoApply` and `realDeviceControl` remain false | No HA automation CRUD yet; accepted means guidance/confirmation, not installed automation |
| Hermes/Jarvis Agent path | `src/jarvisServerRoutes.test.js` | Mock OpenAI-compatible `/v1/chat/completions` endpoint | Agent-task utterance forwards to Hermes endpoint with session header and returns speakable text; timeout returns a speakable `brain_timeout` fallback | Need contract tests against the chosen Hermes/Jarvis Agent deployment once selected |
| Xiaozhi local Server Jarvis brain | `src/jarvisServerRoutes.test.js` | Mock HA and temp PC workspace; call Jarvis `/v1/chat/completions` with Xiaozhi-style OpenAI payload | Home text becomes `HomeIntent` and routes through HCM dry-run/audit; PC text creates a `.md` file under `JARVIS_PC_WORKSPACE_ROOT`; reply is speakable text | Real Xiaozhi server/device contract test still required |
| Delivery Router M0 | `src/deliveryRouter.test.js`, `src/jarvisServerRoutes.test.js` | Local test process; mock WeChat sender; temp delivery audit path | StackChan/Xiaozhi/MCP origins receive voice delivery metadata and delivery audit; direct Hermes WeChat origins are skipped; PC Markdown can request voice plus optional WeChat detail; duplicate voice commands do not create extra delivery | M0 queue is process-local; real Hermes WeChat send remains manual smoke behind `JARVIS_DELIVERY_WECHAT_ENABLED=true` |
| M3 context memory | `src/jarvisServerRoutes.test.js` | Temp context memory path and PC workspace | After creating a PC Markdown file, follow-up questions like "刚才的文件目录是哪个" answer from `jarvis-context` and do not call Hermes or create another file | Context memory is local JSON; multi-process coordination is future SQLite |
| M3 semantic planning cache | `src/jarvisServerRoutes.test.js` | Mock HA and mock Hermes HomeIntent endpoint; temp semantic cache and Obsidian dir | First successful Hermes HomeIntent records JSON cache + Markdown note; repeated normalized command hits cache and skips Hermes; opposite action misses cache | Matching is conservative exact-normalized semantic key; embedding/fuzzy retrieval is future work |
| M3 subagent loop | `src/jarvisServerRoutes.test.js` | Real Node subprocess configured through `JARVIS_SUBAGENT_COMMAND` | Long task starts a real subprocess; success and failure both end in terminal task status and `task_runtime` delivery audit; failure delivery is high priority | Production subagent contract is subprocess JSON for M3; richer Hermes worker pools are future work |
| StackChan black-box boundary | `src/jarvisServerRoutes.test.js`, this plan, `docs/JARVIS_STACKCHAN_HTTP_BRIDGE.md` | No StackChan source checkout required | Tests only send HTTP payloads that a bridge could produce; no device code is imported or patched | MQTT/HA Assist/serial bridges remain optional future adapters |
| Low-latency control path | `npm run jarvis:latency` plus manual smoke | Local Jarvis service; HA required only for fast-path benchmark | Duplicate p95 under 100ms; mock HA fast path under 1s; real HA dry-run under 2s | Fast-path p95 depends on HA and machine state, so run it as a smoke benchmark instead of a unit test |
| Proactive AI L1/L2 foundation | `src/proactiveOpportunityDetector.test.js` | Fixture HCM home, automation summary, and PC context | Unattended lights produce L2 confirmation prompts; routine suggestions produce L1 observations; meeting/focus mode suppresses interruption | Detector is not wired to voice delivery or automatic execution in M1 |

## Recommended Commands

Run focused Jarvis verification:

```bash
npm test -- --run src/jarvisBrain.test.js src/jarvisVoiceBridge.test.js src/jarvisLearningFeedback.test.js src/jarvisPendingPromptQueue.test.js src/jarvisServerRoutes.test.js src/deliveryRouter.test.js src/hcmStateQuery.test.js src/automationSuggestionEngine.test.js src/learningLayer.test.js src/hcmPlanner.test.js src/proactiveOpportunityDetector.test.js src/policyEngine.test.js
```

Run M3 acceptance:

```bash
npm run jarvis:m3:acceptance
```

Run full regression:

```bash
npm test -- --run
```

Run syntax validation for the server entry:

```bash
node --check server.mjs
node --check src/deliveryRouter.js
```

Run latency smoke against a running Jarvis service:

```bash
npm run jarvis:latency
JARVIS_LATENCY_FAST_PATH=1 npm run jarvis:latency
```

## Manual Smoke Test

1. Start the PC-side service with dry-run mode and configured HA credentials:

```bash
HARNESS_EXECUTION_MODE=dry_run npm run dev
```

2. Send a simulated StackChan utterance from another terminal:

```bash
curl -s http://127.0.0.1:5173/v1/utterance \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"stackchan-study","roomId":"study","wakeSessionId":"manual-1","text":"打开书房射灯","dryRun":true}' | jq
```

3. Immediately send the same command from a second simulated room:

```bash
curl -s http://127.0.0.1:5173/v1/utterance \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"stackchan-living","roomId":"living","wakeSessionId":"manual-1","text":"打开书房射灯","dryRun":true}' | jq
```

4. Expected result:
   - First response routes to `hcm_fast_path`.
   - Second response routes to `duplicate_ignored`.
   - `data/command-audit.local.jsonl` gains only one command entry.
   - No StackChan firmware or source code is changed.

## Release Gate For Real Devices

Before enabling real execution:

1. Keep `HARNESS_EXECUTION_MODE=dry_run` until dry-run audit results are stable.
2. Verify HA token scope and device allowlist.
3. Confirm high-risk devices require explicit confirmation.
4. Confirm accepted learning and automation suggestions do not bypass HCM safety, policy, simulation, decision review, or audit.
5. Add a rollback path for the PC-side bridge before connecting physical room devices.
6. Configure `JARVIS_STACKCHAN_DEVICE_ROOMS` for fixed StackChan placements before real execution.
