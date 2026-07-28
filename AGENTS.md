# Jarvis Contributor Guide

Jarvis is a local-first brain for StackChan/Xiaozhi, Hermes, HCM, Home
Assistant, and restricted PC tasks.

## Run And Verify

```bash
npm ci
npm run test:ci
npm run container:smoke
```

Use `npm run dev` for the host service. Use the `container:*`,
`hermes:api:*`, and `xiaozhi:host:*` commands documented in
`docs/JARVIS_CONTAINER_DEPLOYMENT.md` for the live local stack.

## Architecture Boundaries

- Every StackChan/Xiaozhi request enters Jarvis Brain first.
- Jarvis Brain and Hermes classify and plan natural-language intent.
- Every real home action must pass through HCM and its Home Assistant
  execution, verification, and audit gates.
- Non-home tasks use Hermes/Jarvis Agent and its reviewed local tools.
- Only StackChan/Xiaozhi or trusted Jarvis MCP-originated asynchronous results
  use Delivery Router. Direct WeChat-to-Hermes conversations bypass it.
- StackChan firmware and the maintained Xiaozhi server fork live in separate
  repositories; do not mix firmware changes into this repository.

## Safety And Repository Hygiene

- Keep execution in `dry_run` unless a user explicitly authorizes a narrow,
  reversible real-device test.
- Never bypass HCM, broaden a failed recovery command, or expose service ports
  directly to the public internet.
- Never commit `.env`, credentials, private HA data, device identifiers,
  recordings, floor plans, audit logs, runtime data, or firmware backups.
- Preserve unrelated user changes in a dirty worktree.
- Use existing patterns, add focused regression tests, and update the
  authoritative runbook when behavior changes.

## Current State

The software and container dry-run chain are automated and covered by CI.
Physical StackChan proactive delivery and one low-risk real HA light control
remain explicit hardware acceptance gates. See `docs/CURRENT_STATUS.md` and
`docs/LIVE_CHAIN_ACCEPTANCE.md`.
