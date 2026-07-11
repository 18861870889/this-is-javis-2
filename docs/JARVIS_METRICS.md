# Jarvis Metrics

## North Star

**Safe Delivered Task Rate**

StackChan/Xiaozhi/MCP 发起的请求，在安全边界内被正确完成或正确拒绝，并最终可交付、可查询、可审计的比例。

目标：M3 golden path 100%，日常真实使用先以 95% 为告警线。

## Core Metrics

| Area | Metric | M3 Target |
| --- | --- | --- |
| Subagent loop | Long task terminal rate | 100% of tracked long tasks end in `completed`, `failed`, or `cancelled`; no orphan `queued/running` in acceptance tests. |
| Subagent loop | Result return rate | 100% of subagent success/failure results create `task_runtime` delivery audit. |
| Context memory | Follow-up answer accuracy | 100% on golden follow-ups such as “刚才文件在哪里”. |
| Context memory | Cross-session leakage | 0 known leaks across incompatible session/device contexts in tests. |
| Semantic planning cache | Exact repeat hit rate | 100% for repeated normalized commands after a successful plan is recorded. |
| Semantic planning cache | Miss correctness | 100% miss for opposite actions, disabled entries, unrelated commands, or stale signatures. |
| Semantic planning cache | False trigger rate | 0 in golden tests; production warning if `cacheFailureCount / cacheExecutionCount > 1%`. |
| Safety | HCM bypass count | 0. Cache and Hermes can only provide planner drafts; HA execution must pass HCM. |
| Safety | Real HA calls in tests | 0 real `/api/services/*` calls unless an explicit real-device acceptance flag is set. |
| Delivery | Voice delivery audit | 100% for routed StackChan/Xiaozhi/MCP origins. |
| Latency | Fast duplicate p95 | <100 ms. |
| Latency | Mock HA fast path p95 | <1 s. |
| Latency | Long task first ack | <1 s before background work continues. |

## M3 Acceptance Gates

Run:

```bash
npm run jarvis:m3:acceptance
```

The gate must prove:

- A real configured subagent process is started.
- Successful subagent output reaches Task Runtime and Delivery Router.
- Failed subagent output reaches Task Runtime and high-priority Delivery Router.
- PC file follow-up questions are answered from context memory without Hermes timeout.
- Hermes HomeIntent plans are recorded into semantic cache and Markdown.
- Repeated equivalent commands hit cache and skip Hermes semantic planning.
- Opposite commands miss cache and call Hermes again.

## Observability Files

| File | Purpose |
| --- | --- |
| `data/jarvis-context.local.json` | Short-term persistent context: recent PC files and tasks. |
| `data/semantic-planning-cache.local.json` | Machine-readable semantic planning cache and hit/failure counters. |
| `data/obsidian-jarvis/semantic-plans/*.md` | Human-readable Obsidian-compatible learning notes. |
| `data/task-audit.local.jsonl` | Task Runtime lifecycle events. |
| `data/delivery-audit.local.jsonl` | Voice/WeChat/task delivery outcomes. |
| `data/command-audit.local.jsonl` | HCM command safety, execution, and audit traces. |
