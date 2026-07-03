# Intent And Control Closed Loop

> Status: implemented through v0.18.2. The LLM proposes semantics; deterministic runtime invariants own target resolution, safety, execution, preference handling, and verification.

## Runtime

```text
User utterance
  -> Conversation Context (focused targets + focused rooms + recent turns)
  -> Scoped HCM Prompt (explicit room, focused room, or focused target)
  -> LLM semantic draft
  -> Intent Type Invariant
  -> Knowledge / State / Control Resolver
  -> Preference / Comfort Resolver
  -> Logical Group Expansion
  -> Control Graph Primary Actuator
  -> Intent Accuracy + Safety + Policy
  -> Provider Simulation
  -> Authorized Execution
  -> Provider State Readback
  -> Audit + Digital Twin + Shadow Learning
```

## Hard Invariants

1. A control request cannot become an `answered` state query when its action is invalid.
2. A short referential command such as `关一下` must keep the previous focused target; a target change is blocked as critical.
3. An unnumbered numbered-group command such as `过道射灯关一下` resolves every member or executes none when one member is unresolved.
4. A corrective command such as `还有一个没关` targets only members whose current state has not converged.
5. Inventory questions use deterministic HCM aggregation and never return a single device state as the answer.
6. Physical controller location and controlled asset location are independent.
7. A direct relay is the primary actuator; a named remote binding remains a separate review relationship.
8. Provider service success is not final success. The runtime reads provider state back and records convergence or mismatch.
9. Preference feedback is not a device command. Advice such as `建议默认...` records a shadow learning candidate and executes nothing.
10. Brightness discomfort must seek an actual brighter state, for example by opening another off light in the same room before repeating an already-on relay.

## Conversation Context

Conversation state is session-scoped and contains only compact audited targets, room focus, and recent turn summaries. It does not contain arbitrary model prose. Failed or clarification-required commands do not replace the focused target or room.

The prompt is narrowed to devices in an explicitly named room, to the focused logical target, or to the focused room for a referential follow-up. This improves both target precision and prompt latency while every command still passes through the LLM.

Room-level questions such as `书房灯开着吗` answer aggregate light state for the room and keep a room focus rather than pinning the conversation to an arbitrary lamp.

## Lighting Preferences

The first implementation is RL-lite rather than opaque reinforcement learning. Preference feedback is stored as auditable shadow learning input, while deterministic policies apply only low-risk lighting defaults:

- Ambiguous turn-on: prefer `射灯 -> 台灯 -> 灯带 -> 吊灯/主灯`.
- Too dark: turn on a currently-off light in the same room before repeating a relay that is already on.
- Advice/correction utterances: answer and record; never execute.

## Control Graph Primary Actuator

```text
Controller (installation location)
  -> direct relay endpoint ----> logical asset (semantic room)
  -> remote binding endpoint --> same logical asset (review relationship)
```

An explicit load name such as `过道射灯2` owns the semantic room even when the wall panel's HA Area is different. A name such as `绑定（过道射灯2）` is classified as `remote_control` and cannot displace the direct relay as the primary executor.

## Failure Semantics

- `answered`: read-only state or inventory result exists.
- `dry_run`: executable provider commands passed simulation; no service was called.
- `executed`: service calls succeeded and provider states converged.
- `partial_failure`: execution or state verification failed for at least one target.
- `needs_clarification`: control semantics, group membership, or primary actuator is incomplete; nothing executes.
- `needs_confirmation`: a resolved action is blocked by intent accuracy or policy until reviewed.
- `rejected`: safety, policy, provider evidence, or simulation rejected the plan.

## Validated Cases

- `客厅有几个射灯` -> count 2, no service.
- `过道射灯关一下` -> relay 1 + relay 2 in one dry-run plan.
- `关闭过道射灯2` -> direct relay on 入户四号开关右键.
- `过道射灯还有一个没关` -> only the remaining `on` member.
- `餐厅射灯开着吗` followed by `关一下` -> conversation target remains 餐厅射灯 even when the UI selected room is 书房.
- `书房灯开着吗` -> aggregate room lighting state, not a random single lamp.
- `建议默认开射灯，如果还是暗再开吊灯` -> preference feedback, no service.
- `书房灯开一下` -> preferred `书房射灯`.
- `还是有点暗` -> opens another off light in the focused room.

Automated tests and development validation must remain mock/read-only/dry-run. Real service calls require an explicit real-home test action.
