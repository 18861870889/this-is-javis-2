# Harness House Jarvis

[![CI](https://github.com/18861870889/this-is-javis-2/actions/workflows/ci.yml/badge.svg)](https://github.com/18861870889/this-is-javis-2/actions/workflows/ci.yml)
[![CodeQL](https://github.com/18861870889/this-is-javis-2/actions/workflows/codeql.yml/badge.svg)](https://github.com/18861870889/this-is-javis-2/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local-first Jarvis brain for StackChan, Xiaozhi, Home Assistant, and PC tasks.

> [!IMPORTANT]
> This project is experimental. Home control is disabled by default through `dry_run`; review the [security baseline](docs/SECURITY_BASELINE.md) before connecting real devices or exposing any service to a LAN.

## What It Does

- Keeps Xiaozhi's tuned wake-word, ASR, VAD, and TTS experience while replacing its LLM endpoint with Jarvis.
- Uses Jarvis Brain to classify requests and produce structured home-control intent.
- Sends every real home action through HCM policy, simulation, execution, verification, and audit.
- Routes non-home requests to Hermes/Jarvis Agent, including its reviewed PC and web tools.
- Deduplicates the same wake session when multiple StackChan devices hear one command.
- Returns short voice results and optional long-form delivery metadata through Delivery Router.
- Stores contextual memory and successful semantic plans for faster repeated commands.

Locks, gas devices, water valves, alarm panels, camera controls, and similarly sensitive capabilities remain blocked or require stronger authorization.

## Architecture

```text
StackChan microphone / speaker
  -> Xiaozhi (wake word, ASR, VAD, TTS)
  -> Jarvis Brain (conversation, intent recognition, semantic planning)
       -> home request -> HCM safety runtime -> Home Assistant -> device
       -> other task   -> Hermes / local tools -> PC or network result
  -> Delivery Router (StackChan voice, optional WeChat, audit status)
```

The boundary is deliberate: Jarvis Brain understands and plans; HCM is the final authority for real home execution. Hermes cannot bypass HCM to call Home Assistant directly. Direct WeChat conversations with Hermes do not enter Delivery Router.

StackChan firmware is maintained separately so device backups, builds, reviews, and flashes do not get mixed with PC-side runtime changes.

## Project Status

Implemented today:

- OpenAI-compatible Jarvis endpoint: `POST /v1/chat/completions`
- StackChan/HTTP voice ingress: `POST /v1/utterance`
- MCP bridge: `GET|POST /mcp`
- Home Assistant discovery, dry-run, real execution gates, state verification, and audit
- Authenticated native Hermes API transport, real PC tool execution, long-task support, and task status
- Voice dedupe, room context, semantic cache, learning feedback, and L1/L2 proactive foundations
- StackChan/Xiaozhi smoke, latency, firmware preflight, and physical-session scripts

Known limitations:

- The current runtime is designed for one trusted PC and one process; distributed dedupe needs a shared store.
- Real-device acceptance depends on the contributor's Home Assistant entities and local network.
- WeChat delivery requires an existing Hermes WeChat adapter and remains opt-in.
- Container mode keeps Delivery Router WeChat disabled until a reviewed host-side
  Hermes WeChat delivery contract is added; direct WeChat-to-Hermes chat is unaffected.
- Proactive AI is limited to L1 observation and L2 confirmation; it does not auto-execute actions.

See [current status](docs/CURRENT_STATUS.md) and the [roadmap](docs/ROADMAP.md) for the engineering backlog.

## Requirements

- Node.js `20.19+` or `22.12+`
- npm
- Optional: Apple Container `1.1.0+` on Apple silicon with macOS 26, or Docker with Compose
- Optional: Home Assistant with a least-privilege long-lived token
- Optional: a local Hermes/Jarvis Agent runtime
- Optional: Xiaozhi Server and StackChan hardware

## Quick Start

```bash
git clone https://github.com/18861870889/this-is-javis-2.git
cd this-is-javis-2
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`. Jarvis binds to localhost and uses `dry_run` by default.

Verify a clean checkout before changing configuration:

```bash
npm run test:ci
```

For Home Assistant, add only local values to the ignored `.env` file:

```bash
HARNESS_EXECUTION_MODE=dry_run
HA_BASE_URL=http://homeassistant.local:8123
HA_TOKEN=replace-with-a-least-privilege-token
```

Do not switch to `HARNESS_EXECUTION_MODE=real` until dry-run logs resolve the intended room, entity, capability, and action.

## Container Deployment

Jarvis ships as one OCI image. The project wrapper prefers [Apple Container](https://github.com/apple/container) on supported Macs and remains compatible with Docker Compose:

```bash
cp .env.example .env
npm run container:check
npm run container:build
npm run container:smoke
npm run xiaozhi:host:prepare
npm run xiaozhi:host:start
npm run container:start
npm run container:status
```

Open `http://127.0.0.1:5183`. The default container is bound only to localhost and remains in `dry_run`; switching Home Assistant to real execution requires an explicit local configuration change. Stop it with `npm run container:stop`.

Keep every HA, Hermes, LLM, STT, TTS, and Xiaozhi credential outside the image and tracked files. The wrapper keeps Hermes and Xiaozhi delivery APIs on host loopback, stores generated keys in ignored `0600` files, and mounts secret directories read-only instead of placing key values in container configuration. `npm run container:live-check` verifies both Hermes and Home Assistant from inside Jarvis.

See the [container deployment runbook](docs/JARVIS_CONTAINER_DEPLOYMENT.md) for Apple Container and Docker prerequisites, networking, smoke tests, rollback, and real-control gates.

## Xiaozhi Integration

Keep Xiaozhi's voice modules and point only its OpenAI-compatible LLM provider to Jarvis:

```yaml
selected_module:
  LLM: JarvisLLM
  Intent: nointent

LLM:
  JarvisLLM:
    type: openai
    base_url: http://<jarvis-host>:5183/v1
    model_name: jarvis
    api_key: placeholder-not-a-real-secret
```

The complete setup and physical acceptance flow is in the [Xiaozhi/StackChan runbook](docs/XIAOZHI_STACKCHAN_RUNBOOK.md).

For the maintained local Xiaozhi fork, `npm run xiaozhi:host:start` validates
`JarvisLLM`, `nointent`, `auth.enabled=true`, and a non-empty device allowlist
before opening its device ports. Its proactive TTS API stays authenticated on
`127.0.0.1:8004`; background Jarvis results use it without calling Xiaozhi's LLM.

## Configuration

The documented configuration surface lives in [.env.example](.env.example). Common settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_BIND_HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `5173` | Jarvis port |
| `HARNESS_EXECUTION_MODE` | `dry_run` | `dry_run` or intentional real execution |
| `JARVIS_CONTAINER_ENGINE` | `auto` | Prefer Apple Container, or select `apple` / `docker` explicitly |
| `JARVIS_CONTAINER_BIND_HOST` | `127.0.0.1` | Host address used to publish the container port |
| `JARVIS_CONTAINER_PORT` | `5183` | Host port for containerized Jarvis and Xiaozhi LLM calls |
| `JARVIS_CONTAINER_EXECUTION_MODE` | `dry_run` | Container-specific Home Assistant execution gate |
| `JARVIS_CONTAINER_CPUS` | `2.0` | Docker Compose CPU limit |
| `JARVIS_CONTAINER_MEMORY` | `1g` | Docker Compose memory limit |
| `HA_BASE_URL` / `HA_TOKEN` | empty | Home Assistant connection |
| `JARVIS_HERMES_API_HOST` | `127.0.0.1` | Host bind for Hermes' authenticated native API |
| `HERMES_API_BASE_URL` | managed by wrapper | Container-reachable Hermes/Jarvis Agent endpoint |
| `JARVIS_XIAOZHI_DELIVERY_PORT` | `8004` | Loopback-only Xiaozhi proactive TTS API |
| `JARVIS_STACKCHAN_DEVICE_ROOMS` | empty | Trusted device-to-room placement map |
| `JARVIS_PC_WORKSPACE_ROOT` | local data path | Restricted PC file workspace |

Never commit `.env`, HA tokens, Xiaozhi endpoint tokens, LLM/STT/TTS keys, private URLs, Home Assistant snapshots, local audit logs, or firmware backups.

## Verification

```bash
npm run check       # JavaScript syntax checks
npm test            # full Vitest regression
npm run build       # production frontend build
npm run test:ci     # all required local CI checks
npm run container:live-check
```

With a local stack running:

```bash
npm run jarvis:stack:e2e
JARVIS_URL=http://127.0.0.1:5183 npm run jarvis:latency
XIAOZHI_WS_SMOKE_DEVICE_ID='<allowed-device-id>' npm run xiaozhi:ws-smoke -- pc
```

Hardware and real-control checks are intentionally separate because they require local devices and explicit approval.

## Repository Layout

```text
.
├── server.mjs               # Express/Vite service and public API routes
├── src/
│   ├── adapters/            # Home Assistant and provider adapters
│   ├── jarvisBrain.js       # top-level intent classification
│   ├── hcm*.js              # home-control model, validation, and execution
│   ├── deliveryRouter.js    # voice/WeChat/audit delivery boundary
│   └── *.test.js            # unit and integration tests
├── scripts/                 # local stack, smoke, latency, and firmware tools
├── docs/                    # architecture, operations, security, and roadmap
└── .github/                 # CI, security automation, and contribution templates
```

## Documentation

- [Product requirements](docs/PRD.md)
- [Engineering control](docs/JARVIS_ENGINEERING_CONTROL.md)
- [HCM control graph](docs/HCM_CONTROL_GRAPH.md)
- [Security baseline](docs/SECURITY_BASELINE.md)
- [Container deployment](docs/JARVIS_CONTAINER_DEPLOYMENT.md)
- [Live chain acceptance](docs/LIVE_CHAIN_ACCEPTANCE.md)
- [Verification plan](docs/JARVIS_VERIFICATION_PLAN.md)
- [Testing policy](docs/TESTING_POLICY.md)
- [Adapter SDK](docs/ADAPTER_SDK.md)
- [Roadmap](docs/ROADMAP.md)

## Contributing And Security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Use GitHub Issues for reproducible bugs and scoped proposals. Do not post vulnerabilities, credentials, camera details, device identifiers, or private home topology in a public issue; follow [SECURITY.md](SECURITY.md) instead.

This public repository intentionally excludes runtime data, personal Hermes files, real credentials, local device snapshots, and firmware full-flash backups.

## License

[MIT](LICENSE)
