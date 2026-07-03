# Jarvis Engineering Control

## Operating Model

User and main Codex thread are the product, architecture, and release decision owners.

Code agent owns bounded PC-side implementation tasks. It must not modify StackChan, m5stack, firmware, or device-side source code.

Test agent owns verification plans, automated tests, smoke tests, and release gates. It treats StackChan as a black-box input device and simulates it through transport payloads.

## Non-Negotiables

- StackChan is a device endpoint, not an application runtime to modify.
- The PC/container side owns routing, dedupe, HCM execution, learning, and slow-path brain integration.
- Home Assistant control must pass HCM grounding, safety, policy, simulation, decision review, and audit.
- Accepted learning and automation suggestions are guidance only; they do not bypass HCM.
- Real device execution stays behind dry-run and release gates until verification is stable.

## Decision Log

| ID | Decision | Rationale | Status |
| --- | --- | --- | --- |
| D001 | StackChan is black-box voice/display hardware. | Keeps devices stable and lets the PC bridge evolve independently. | Accepted |
| D002 | Simple low-risk controls use HCM fast path with external planner draft. | Reduces latency and avoids a second LLM call while preserving HCM safety gates. | Implemented |
| D003 | Home state questions use HCM read-only fast path when HA is configured. | Answers should come from real HA/HCM state and must not trigger device control. | Implemented |
| D004 | If HA is unavailable, state questions may fall back to Hermes/OpenClaw. | Provides a voice-friendly fallback instead of a raw integration error. | Implemented |
| D005 | Self-evolution must be user-visible through suggestions, feedback, and accepted guidance. | Silent habit records are not a product feature unless they affect later behavior explainably. | Implemented baseline |
| D006 | Proactive AI M1 only supports L1/L2. | Jarvis may observe, suggest, and ask for confirmation, but must not auto-execute proactive actions in M1. | Accepted |
| D007 | Room priority is explicit target room, then trusted StackChan/source room, then clarification. | Saying "关主卧灯" in another room must still target the master bedroom; saying "关灯" may use the source room; saying "卧室灯" outside a bedroom must ask. | Implemented |
| D008 | Real control scope excludes strong safety devices; all other devices still pass HCM policy. | Doors, locks, gas, water valves, and alarms need hard protection; lights, fans, covers, climate, media, and similar devices may be included only through HCM grounding, policy, simulation, and audit. | Implemented baseline |

## M0: PC-Side Verifiable Loop

Goal: prove the PC-side brain can accept voice text, dedupe multi-room inputs, route to HCM or Hermes, execute only through HCM gates, and accept spoken learning feedback.

Status: implemented with automated verification.

Evidence:

```bash
npm test -- --run src/jarvisVoiceBridge.test.js src/jarvisLearningFeedback.test.js src/jarvisServerRoutes.test.js src/hcmStateQuery.test.js src/automationSuggestionEngine.test.js src/learningLayer.test.js
node --check server.mjs
```

Current result: focused Jarvis suite passes.

Full regression status: passing, 44 test files and 274 tests.

## M1: Stabilize The Product Contract

1. Resolve the HCM bedroom ambiguity decision:
   - Generic "卧室灯" asks clarification when multiple bedrooms exist.
   - Trusted `currentRoomId` / `selectedRoomId` / focus room context may narrow the command to that room.
   - Voice fast path injects trusted room context into external planner drafts only when the user did not name a specific target room.
   - Explicit room names in the utterance override StackChan/source room context.
   - Status: implemented.

2. Add a pending prompt queue:
   - Store the exact learning or automation suggestion that was spoken to the user.
   - Bind "可以 / 别这样 / 撤销" to that pending item instead of relying on latest command audit.
   - Bare feedback only matches a pending prompt with compatible device, room, or session context.
   - Status: implemented for learning and automation suggestion feedback.

3. Harden Hermes/OpenClaw slow path:
   - Add timeout.
   - Add speakable error fallback.
   - Add contract tests once the real brain service is selected.
   - Status: timeout and speakable fallback implemented; real service contract test remains future work.

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
- Hermes/OpenClaw protocol is assumed to be OpenAI-compatible until verified.
- Proactive detector output is not wired to voice/UI delivery yet; it is currently a tested shadow foundation.
- Medium-risk confirmation is currently conservative: many medium-risk capabilities are rejected or held for confirmation instead of having a full "confirm then execute pending action" voice loop.
