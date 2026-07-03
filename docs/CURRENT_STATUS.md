# Current Status

> Last updated: 2026-06-22. This document is the short source of truth for current progress, near-term plans, and safety boundaries.

## Current Version

Current engineering progress: `v0.24`.

Completed major runtime capabilities:

- Local 3D MVP with simulator devices and Three.js house view.
  - V2 visual upgrade: dollhouse walls, floor textures (wood/tile/stone), light sub-types (pendant/spotlight/strip/ceiling/floor), device entity modeling (fan/AC/sensor/TV/robot).
  - V2 info architecture: removed per-device text labels, replaced with status dots + room summary badges + legend.
  - Polygon room support: map editor supports irregular polygon rooms via SVG drawing mode; 3D rendering uses THREE.Shape + edge-based walls.
  - See `docs/3D-HOUSE-V2-DESIGN.md` for design spec.
- OpenAI-compatible LLM planning, currently usable with DeepSeek-style providers.
- Home Assistant discovery and HCM mapping.
- HCM overlay and review decisions.
- Production command pipeline with audit, replay, learning memory, and explanations.
- HA service simulator for dry-run validation before real execution.
- Shadow multi-agent runtime: Context, Learning, Mapping, Diagnostics, Test.
- Provider-to-HCM onboarding planner for new/changed/deleted provider devices.
- Intent Accuracy Engine after LLM output.
- Digital Twin State Layers for `selection / occupancy / preview / execution / alert`.
- Policy Gate between Safety Gate and Provider Adapter simulation.
- Independent browser STT/TTS with push-to-talk, transcript confidence gating, and half-duplex output.
- Shadow home-event capture and automation suggestions with local simulation and review decisions.
- Morning Mint light UI refresh across the operational panels and Three.js digital twin.
- Stable desktop/mobile layout with distinct visual semantics for selection, occupancy, preview, execution, and alerts.
- Provider Adapter Contract and provider-neutral snapshot schema at version `1.0`.
- Capability Evidence attached to HCM capabilities.
- Simulator and Home Assistant adapters passing the same read-only Contract Harness.
- Adapter Registry and gated provider execution with simulation, authorization, and command audit identity.
- HCM Control Graph separating physical controllers, relay endpoints, logical assets, and semantic rooms.
- Logical-light planning for multi-gang switches, including strict explicit-room validation and provider-channel resolution.
- Life-view digital twin projection showing controlled lights in their semantic rooms while preserving controller identity for maintenance.
- Session-scoped conversation target memory with deterministic referential-command protection.
- Inventory/count/list queries over HCM logical devices.
- Atomic numbered-device group expansion and residual-member correction.
- Primary relay vs remote-binding classification in the Control Graph.
- Provider state readback after execution; service acceptance alone is not final success.
- Local Spatial Home Model Editor for floor-plan upload, room renaming, device placement, naming modes, and logical-asset vs physical-controller organization.
- Assisted spatial mapping suggestions and local 2D -> 3D digital-twin projection.
- Intent Frame contract for goal, grounding, ambiguity, decision mode, and HCM-level actions.
- Prompt Context Pack v2 with room-oriented affordances, context, conversation, personal semantics, and learning guidance.
- Semantic Grounding Resolver for converting model semantic targets into HCM logical assets while preserving ambiguity.
- Decision Review stage after policy/provider simulation and before any authorized provider execution.
- Household Learning Context that feeds shadow learning back into planner guidance without auto-applying rules.
- Runtime Gate with default dry-run execution, release readiness checks, and visible UI/API execution mode.

`v0.10 Real Home Pilot` is intentionally not marked complete. It requires real-home observation over time and user-authorized low-risk device testing.

## v0.16.1 UI Refresh

Status: completed.

- Replaced the dark glass theme with warm white, mint, neutral wood, amber, and coral semantic colors.
- Preserved the existing three-surface information architecture and all command, speech, agent, automation, mapping, and audit controls.
- Updated Three.js room floors, translucent walls, furniture, labels, lighting, fog, and grid for the light environment.
- Kept selection, occupancy, preview, execution, and alert as independent digital-twin layers.
- Stabilized Command panel sizing so the input does not overlap the following panel.
- Verified desktop and 390px mobile layouts without horizontal overflow.

## v0.17 Adapter SDK & Provider Portability

Status: completed for the SDK and current-provider migration scope.

- Added the required Adapter methods: identity, connection status, snapshot discovery, HCM mapping, action compilation, simulation, execution, and state reading.
- Added provider-neutral snapshots and diffs for stable device/entity/state change detection.
- Added Capability Evidence with observed provider facts, command candidates, constraints, and confidence.
- Migrated Simulator and Home Assistant to Contract `1.0` while retaining the discovery methods used by the current UI/runtime.
- Added a reusable adapter template, registry, fixture-driven Contract Harness, and failure injection tests.
- Provider execution now requires runtime authorization, successful adapter simulation bound to the same command fingerprint, and a command ID.
- Disabled the public direct Home Assistant action route; commands must enter through `/api/hcm/command`.

Limit: Matter/MQTT adapters are not claimed as hardware-certified until corresponding devices or certified fixtures are available. The SDK contract and mock portability path are complete.

## v0.18A Multi-Gang Switch Control Graph

Status: implemented and verified against the current read-only HA snapshot.

- Derives `Controller -> Endpoint -> Asset -> Space` without changing HA entities or provider data.
- Current snapshot produces 22 physical panels, 56 relay endpoints, and 41 logical controlled assets.
- `入户1号开关` is resolved as two independent endpoints: left -> `餐厅射灯`, right -> `餐边柜灯带`.
- Unnamed channels and remote bindings remain review/unbound and are not exposed as primary actuators.
- Planner targets logical assets and normalization resolves back to the original HCM thing/capability.
- Explicit room mismatch is rejected for logical assets instead of relying on model similarity.
- Relay state is labeled inferred; actual light output remains unknown without independent observation.
- Mapping corrections persist in HCM Overlay through `POST /api/hcm/overrides/control-mappings`.
- Digital-twin preview/execution targets logical asset IDs.

## v0.18.1 Intent And Control Closed Loop

Status: implemented and validated with the real HA snapshot using read-only queries and dry-run commands.

- A failed control request can no longer degrade into an `answered` state query.
- `关一下` and similar follow-ups use the previous audited target; mismatches are blocked as critical.
- Numbered logical groups execute atomically; unresolved members prevent silent partial execution.
- Corrective language such as `还有一个没关` selects only members whose relay state still differs from the requested state.
- Inventory questions such as `客厅有几个射灯` return deterministic counts and names.
- Explicit load-room semantics override the physical controller's HA Area.
- Remote bindings remain review relationships and cannot replace the primary direct relay.
- Successful execution now requires provider state convergence.

Design: [INTENT_CONTROL_CLOSED_LOOP.md](INTENT_CONTROL_CLOSED_LOOP.md).

## v0.18.2 Lighting Preference Loop

Status: implemented and covered by automated tests. Validation uses unit tests and dry-run/read-only runtime checks; no automatic real-device control is used for debugging.

- Room-level light questions such as `书房灯开着吗` return aggregate room lighting state instead of pinning one lamp.
- Conversation context now tracks focused rooms as well as focused targets, so short follow-ups can inherit the previous room safely.
- Preference feedback such as `建议默认开射灯，如果还是暗再开吊灯` is treated as learning input and never as a real device command.
- Ambiguous light turn-on requests prefer the household lighting order: `射灯 -> 台灯 -> 灯带 -> 吊灯/主灯`.
- Brightness discomfort such as `还是有点暗` seeks a brighter outcome by opening another currently-off light in the same room before repeating an already-on relay.
- The chat surface now prefers a short human-readable result while retaining the detailed execution explanation in the plan/audit surfaces.

## v0.18B Spatial Home Model Editor

Status: implemented for the local editor scope.

- Added a local spatial editor panel in the left rail for floor-plan upload, room naming, device placement, and device detail inspection.
- Separates room assignment from map placement so a device can be assigned but unplaced, placed but unassigned, fully organized, or still unorganized.
- Shows HCM logical assets and physical switch controllers as different roles instead of forcing multi-gang switches into the same object as the lights they control.
- Supports two naming modes: `room + provider/HCM default name` and `room + custom device name`.
- Stores editor state in the local Harness service file `data/spatial-editor.local.json`; browser local storage is kept only as a backward-compatible migration/cache layer.
- The same localhost instance now shares spatial edits across Chrome, the Codex in-app browser, and other browser contexts.
- Covered by `src/spatialHomeEditor.test.js`; automated validation remains dry-run/read-only and does not control real devices.

## v0.19 Assisted Mapping And 2D/3D Sync

Status: implemented for local suggestions and digital-twin projection.

- Generates explainable placement suggestions from HCM semantic rooms, controller installation rooms, and current map placement.
- Suggestions can be accepted or dismissed locally; accepting them updates only the Harness spatial editor state file.
- Accepted room names, room assignments, and map coordinates are projected into the 3D scene model before digital-twin layers are applied.
- 3D room/device labels and device positions now reflect confirmed spatial edits while the command runtime still uses HCM identities and policy gates.
- Existing v0.18B local storage is migrated into the v0.19 state shape.
- Boundary: v0.19 does not write Home Assistant areas, does not write HCM Overlay mapping, and does not perform automatic floor-plan recognition.

## v0.20 Intent Frame & Prompt Context Pack v2

Status: implemented and covered by local tests.

- Added `Intent Frame` normalization for both new `intent_frame` planner output and legacy `actions` JSON.
- The frame captures intent type, domain/outcome, target/space references, required facts, candidate targets, ambiguity, decision mode, and HCM-level actions.
- Added Prompt Context Pack v2 so the model sees rooms, affordances, occupancy, conversation focus, personal semantics, and learning hints as structured context.
- The HCM planner prompt now asks the model to reason at the semantic home layer; provider service selection remains local runtime work.

Boundary: v0.20 does not ask the model for hidden chain-of-thought and does not allow provider service calls in model output.

## v0.21 Semantic Grounding Resolver

Status: implemented and covered by local tests.

- Resolves semantic target names such as `书房射灯` into HCM logical asset IDs before action normalization.
- Keeps ambiguous targets visible instead of silently choosing one.
- Adds grounding diagnostics to every normalized HCM plan, including status, candidates, explicit room IDs, evidence, and unresolved reasons.
- Existing legacy planner actions remain compatible.

Boundary: semantic grounding can propose or resolve HCM targets, but Safety, Policy, Provider Simulation, and Decision Review still decide whether execution is allowed.

## v0.22 Decision Review & Recovery

Status: implemented and covered by local tests.

- Added `decision_review` after Policy Gate and Provider Adapter simulation.
- Blocks unresolved controls, empty control plans, safety/policy rejection, and provider simulation rejection before any provider execution.
- Produces recovery modes such as `ask_clarification`, `adapter_diagnosis`, and `safety_review`.
- User-facing explanations now include decision-review recovery messages instead of only raw rejection codes.

Boundary: review is local and deterministic; it does not call the LLM and does not control devices.

## v0.23 Household Learning Context

Status: implemented and covered by local tests.

- Compiles shadow learning candidates, preference hints, and correction hints into planner guidance.
- Learning guidance is included in Prompt Context Pack v2 and the LLM payload.
- `autoApply` remains false; learning cannot create executable actions without fresh HCM grounding and full safety/policy/simulation review.

Boundary: v0.23 is still guidance, not autonomous rule mutation.

## v0.24 Runtime Gate & Release Safety

Status: implemented and covered by local tests.

- Added `HARNESS_EXECUTION_MODE` as the explicit runtime switch for real provider execution.
- Default mode is `dry_run`; HCM commands still plan, simulate, review, audit, and explain, but do not touch real devices.
- The backend enforces dry-run even if the frontend forgets to send `dryRun: true`.
- `/api/runtime/status` reports execution mode, release target, blockers, warnings, and next gaps.
- The control UI shows `Dry-run` / `Real` in the header and a Runtime Gate panel in the right rail.
- Release readiness currently requires LLM config, HA config, command audit, and the default safety gates.

Boundary: this is not a public production release. It is a local/internal alpha guardrail so iteration and demonstrations cannot accidentally control real devices.

## Current Runtime Chain

```text
User Command
  -> Runtime Execution Mode
  -> Conversation Context
  -> Context Snapshot
  -> HCM Overlay + Personal Semantics
  -> HCM Control Graph
  -> Context Agent Snapshot
  -> Household Learning Context
  -> Prompt Compile
  -> Prompt Context Pack v2
  -> LLM Planner
  -> Intent Frame Normalize
  -> Semantic Grounding Resolver
  -> Plan Normalize
  -> Intent Accuracy Engine
  -> Safety Gate
  -> Policy Gate
  -> Provider Adapter Compile / Simulate
  -> Decision Review
  -> Authorized Provider Execute
  -> Provider State Readback
  -> Audit / Learning / Agents
```

Key boundaries:

- LLM understands intent; it does not own service selection or final execution permission.
- Runtime Gate decides whether an otherwise valid provider plan may execute or must remain dry-run.
- HCM is the upper-layer model; provider entities must not leak directly into planner/runtime code.
- Safety Gate answers whether a capability is executable.
- Policy Gate answers whether this context should execute it.
- The active Provider Adapter validates its command against current HCM evidence before any real device call; HA currently reuses the strict HA Service Simulator internally.

## Near-Term Plan

### v0.25 - Conversation Router

Status: deferred; intentionally not implemented yet.

Goal: add a lightweight entry router before HCM so obvious non-device requests do not get forced through the smart-home execution chain.

Intended scope:

- Route deterministic local questions such as current time/date without calling the HCM planner.
- Route generic chat or story requests to a chat response path instead of returning "no home device can execute this."
- Route external knowledge questions, such as sports schedules or current events, to a future external knowledge provider or a clear "needs lookup" response.
- Route device capability questions, such as "电视有哪些可控制功能", to HCM read-only capability lookup.
- Keep complex home scenes, such as "准备睡觉" or "有点暗", on the existing LLM + HCM path.

Constraints:

- No extra LLM call should be added to the hot path.
- Rules should only handle high-confidence routing; ambiguous home intents still go to the current LLM intent frame.
- This is a future product layer, not part of the current v0.24 runtime.

### v0.10 - Real Home Pilot

Goal: run a limited real-home pilot with low-risk devices only.

Scope:

- Lights, fan, curtains, TV/media pause/stop, bounded climate temperature.
- Dry-run and audit for all experiments.
- Manual authorization for any real-device execution during testing.

Exit criteria:

- 7-day stable observation.
- Common command P95 around 2 seconds.
- UI state and HA state consistency above 98% for pilot devices.
- 0 high-risk accidental executions.
- All failures have audit traces.

### v0.15 - Independent STT & TTS Alpha

Status: completed for the alpha scope.

Goal: provide independent push-to-talk speech input and reliable speech output without Xiaoai integration.

Scope:

- Add a `SpeechInput` abstraction: microphone audio -> STT transcript -> visible command text.
- Submit STT transcripts through the existing `/api/hcm/command` pipeline; STT never calls devices directly.
- Use push-to-talk and half-duplex interaction by default: pause listening while TTS is speaking.
- Require review or retry when STT confidence is low, the transcript is empty, or audio is truncated.
- Speak state-query answers, execution results, rejections, and confirmation requests.
- Keep text as the source of truth; TTS consumes the final audited response and cannot create another command.
- Provide replaceable `SpeechInput` and `SpeechOutput` provider abstractions.
- Support mute, volume, interruption, duplicate suppression, and long-text truncation.

Non-goals:

- Xiaoai integration.
- Always-listening voice assistant.
- Wake-word detection.
- Voice commands that bypass transcript visibility or the HCM command pipeline.

### v0.16 - Home Event & Automation Suggestions

Status: completed for the shadow proposal scope.

Product meaning: the house starts noticing repeatable situations and proposes automations, but it does not silently take control.

Example:

```text
Observed: study presence becomes occupied after 20:00, and the study light is usually turned on within 30 seconds.
Proposal: when the study becomes occupied after 20:00, turn on the study light.
Result: show the proposal, simulate it, and wait for user review.
```

Implemented scope:

Scope:

- Read-only HCM snapshot capture and state-change event history.
- Suggestions from at least two matching successful audited actions.
- Preview-only simulations through HCM Executor, Policy Gate, and HA Service Simulator.
- Local `reviewed` / `ignored` decisions; no persistent provider automation is created.

This version does not automatically write Home Assistant automations or execute a newly discovered rule.

### v1.0 - Open Source Framework Release

Goal: stable local-first AI smart-home framework release.

Required:

- HCM contract and adapter docs.
- Simulator Adapter.
- Home Assistant Adapter.
- Capability registry and policy gates.
- LLM planner and intent accuracy checks.
- Audit/replay/learning.
- Digital twin UI.
- Safety and testing documentation.

## Verification Commands

```bash
npm test
npm run build
git diff --check
```

Browser smoke checks should verify:

- App renders without console errors.
- 3D canvas is present and non-empty.
- Main panels render.
- HCM mode works when HA is configured; simulator fallback works otherwise.

## Safety Rules

- Automated tests must not call real HA `/api/services/*`.
- Real-device execution requires user authorization and must go through HCM, Intent Accuracy Engine, Safety Gate, Policy Gate, and the active Provider Adapter simulation.
- High-risk, privacy, gas/water heater, lock, config, and unclear capabilities default to protected.
- Learning and multi-agent suggestions remain shadow-mode unless explicitly reviewed.
