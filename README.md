# Harness House Jarvis

PC-side Jarvis brain, home-control safety runtime, and delivery layer for a multi-room smart home.

This repository owns the PC-side Jarvis Brain, HCM safety runtime, local agent handoff, and delivery routing. StackChan firmware work lives in a separate firmware workspace/repository so device changes can be backed up, reviewed, built, and flashed independently.

## Current Scope

- `/v1/utterance` voice bridge for StackChan or any HTTP speech adapter. It performs ingress hygiene, then hands the utterance to Jarvis Brain.
- `/mcp` JSON-RPC HTTP bridge exposing home-control and restricted PC tools for StackChan/Xiaozhi or HA MCP proxies.
- `/v1/chat/completions` OpenAI-compatible Jarvis brain endpoint for Xiaozhi local server LLM routing.
- Multi-device wake-session dedupe: duplicated utterances return `duplicate_ignored` and `speak:false`.
- Jarvis Brain M0 intent recognition emits `HomeIntent` for home tasks before HCM receives them.
- HCM consumes `HomeIntent` and owns grounding, safety, policy, simulation, decision review, HA execution, state verification, and audit.
- Non-home tasks are routed to Hermes/Jarvis Agent or restricted local tools such as creating Markdown files.
- Delivery Router is the product boundary for returning short voice summaries, longer WeChat messages, and delivery/audit status.
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

Jarvis binds to `127.0.0.1` by default. Do not expose HTTP, WebSocket, MCP, STT/TTS, or LLM gateway ports directly to the public internet. See [Security Baseline](docs/SECURITY_BASELINE.md) before using `JARVIS_BIND_HOST=0.0.0.0` for LAN devices.

For first real-home testing, keep execution in dry-run mode:

```bash
HARNESS_EXECUTION_MODE=dry_run npm run dev
```

Optional StackChan room registry:

```bash
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-study":"study","stackchan-second":"second"}'
```

First StackChan MCP dry-run:

```bash
JARVIS_BIND_HOST=127.0.0.1 \
PORT=5183 \
HARNESS_EXECUTION_MODE=dry_run \
JARVIS_MCP_ALLOWED_ROOM_IDS=second \
JARVIS_MCP_REQUIRE_TEXT_PATTERN='次卧' \
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-second":"second"}' \
npm run dev
```

See [Jarvis MCP Bridge](docs/JARVIS_MCP_BRIDGE.md) for the real-execution gate.

Xiaozhi local Server can keep its ASR/TTS pipeline and use Jarvis as the brain by configuring an OpenAI-compatible LLM:

```yaml
selected_module:
  LLM: JarvisLLM
  Intent: nointent

LLM:
  JarvisLLM:
    type: openai
    base_url: http://<jarvis-lan-ip>:5183/v1
    model_name: jarvis
    api_key: dummy
```

Jarvis then receives Xiaozhi's LLM calls at `/v1/chat/completions`. Jarvis Brain recognizes the intent first: home tasks become `HomeIntent` and enter HCM/HA, while non-home tasks go to Hermes/Jarvis Agent or approved local tools. Delivery Router is responsible for the final voice/WeChat/audit handoff.

## Important Environment Variables

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
JARVIS_BIND_HOST=127.0.0.1
PORT=5173
HARNESS_EXECUTION_MODE=dry_run
HA_BASE_URL=http://homeassistant.local:8123
HA_TOKEN=
HERMES_API_BASE_URL=
HERMES_API_KEY=
```

Never commit `.env`, HA tokens, OpenAI/TTS/STT keys, local audit logs, Home Assistant snapshots, tunnel credentials, or firmware full-flash backups.

## Verification

Run focused Jarvis/HCM verification:

```bash
npm test -- --run src/jarvisBrain.test.js src/jarvisVoiceBridge.test.js src/jarvisLearningFeedback.test.js src/jarvisPendingPromptQueue.test.js src/jarvisServerRoutes.test.js src/hcmStateQuery.test.js src/automationSuggestionEngine.test.js src/learningLayer.test.js src/hcmPlanner.test.js src/proactiveOpportunityDetector.test.js src/policyEngine.test.js
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

This public repository intentionally excludes local runtime data, build outputs, installed dependencies, private `.env` files, personal Hermes persona files, legacy device-control scripts, and device flash backups. StackChan firmware/device code is kept in a separate firmware repository.
