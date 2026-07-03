# Harness House Jarvis

PC-side Jarvis brain and safety execution layer for a multi-room smart home.

This repository treats StackChan/m5stack devices as black-box voice/display terminals. Device firmware and device-side source code are not modified here. The PC/container side owns voice routing, dedupe, HCM grounding, Home Assistant execution policy, audit, learning feedback, and proactive AI foundations.

## Current Scope

- `/v1/utterance` voice bridge for StackChan or any HTTP speech adapter.
- Multi-device wake-session dedupe: duplicated utterances return `duplicate_ignored` and `speak:false`.
- HCM fast path for simple home controls and read-only state questions.
- Explicit room priority: "关主卧灯" wins over the source room; "关灯" may use the trusted device room; "卧室灯" outside a bedroom asks for clarification.
- Optional trusted device placement via `JARVIS_STACKCHAN_DEVICE_ROOMS`.
- Learning feedback via spoken "可以 / 别这样 / 撤销" and pending prompt binding.
- L1/L2 proactive opportunity detector foundation. No proactive auto-execution in M1.
- Home Assistant control only through HCM grounding, policy, simulation, decision review, and audit.

Strong safety devices such as locks, gas devices, water valves, valves, alarm panels, and camera-related controls remain blocked or require stronger future authorization.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Default service URL:

```text
http://localhost:5173
```

For first real-home testing, keep execution in dry-run mode:

```bash
HARNESS_EXECUTION_MODE=dry_run npm run dev
```

Optional StackChan room registry:

```bash
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-study":"study","stackchan-second":"second"}'
```

## Important Environment Variables

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
PORT=5173
HARNESS_EXECUTION_MODE=dry_run
HA_BASE_URL=http://homeassistant.local:8123
HA_TOKEN=
HERMES_API_BASE_URL=
HERMES_API_KEY=
```

Never commit `.env`, HA tokens, OpenAI keys, local audit logs, or Home Assistant snapshots.

## Verification

Run focused Jarvis/HCM verification:

```bash
npm test -- --run src/jarvisVoiceBridge.test.js src/jarvisLearningFeedback.test.js src/jarvisPendingPromptQueue.test.js src/jarvisServerRoutes.test.js src/hcmStateQuery.test.js src/automationSuggestionEngine.test.js src/learningLayer.test.js src/hcmPlanner.test.js src/proactiveOpportunityDetector.test.js src/policyEngine.test.js
```

Run full regression:

```bash
npm test -- --run
```

Syntax checks:

```bash
node --check server.mjs
node --check scripts/jarvis-latency-smoke.mjs
```

Latency smoke against a running local service:

```bash
JARVIS_URL=http://127.0.0.1:5173 npm run jarvis:latency
```

## Repository Layout

```text
.
├── server.mjs                    # Express/Vite server, HCM routes, Jarvis voice routes
├── src/                          # React UI, HCM core, HA adapter, learning, proactive detector
│   ├── adapters/                 # Home Assistant and provider adapter code
│   ├── jarvisVoiceBridge.js      # Voice routing, dedupe keys, StackChan response shape
│   ├── jarvisPendingPromptQueue.js
│   ├── jarvisLearningFeedback.js
│   ├── proactiveOpportunityDetector.js
│   ├── hcmPlanner.js
│   └── policyEngine.js
├── scripts/
│   └── jarvis-latency-smoke.mjs
└── docs/
    ├── JARVIS_ENGINEERING_CONTROL.md
    ├── JARVIS_VERIFICATION_PLAN.md
    └── JARVIS_STACKCHAN_HTTP_BRIDGE.md
```

## Public-Repo Boundary

This public repository intentionally excludes local runtime data, build outputs, installed dependencies, private `.env` files, personal Hermes persona files, and legacy device-control scripts. StackChan firmware/device code is not part of this repo.
