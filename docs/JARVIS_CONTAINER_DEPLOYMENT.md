# Jarvis Container Deployment

This runbook deploys the PC-side Jarvis service as one OCI image. It prefers Apple Container on supported Macs and keeps Docker Compose as the portable fallback.

The defaults are intentionally conservative:

- publish only on `127.0.0.1`;
- keep Home Assistant actions in `dry_run`;
- read credentials from an ignored local `.env`, copy only required values into
  ignored `0600` secret files, and mount their directories read-only;
- run Hermes through its API transport;
- run as a non-root user with a read-only root filesystem and dropped capabilities.
- limit production frontend fallback traffic per client without throttling Jarvis API routes.

## Choose A Runtime

The common `npm run container:*` commands select a runtime automatically. Set `JARVIS_CONTAINER_ENGINE=apple` or `JARVIS_CONTAINER_ENGINE=docker` in `.env` only when an explicit choice is useful.

### Apple Container

[Apple Container](https://github.com/apple/container) provides OCI-compatible Linux containers on Apple silicon. This project targets CLI `1.1.0+`; the upstream release requires Apple silicon and macOS 26.

```bash
container --version
container system start
container system status
```

The project uses real 1.1.0 CLI capabilities including `container build --tag`, `container run --env-file`, `--publish`, `--volume`, `--tmpfs`, `--read-only`, and `--cap-drop`.

### Docker

Docker Engine or Docker Desktop must include Compose v2:

```bash
docker version
docker compose version
```

The same `Dockerfile` is used by both runtimes. Docker users can use the common wrapper or the direct `npm run container:docker:*` commands.

## Prepare Configuration

Create the local environment file once:

```bash
cp .env.example .env
```

Keep these safety defaults during initial acceptance:

```dotenv
JARVIS_CONTAINER_ENGINE=auto
JARVIS_CONTAINER_BIND_HOST=127.0.0.1
JARVIS_CONTAINER_PORT=5183
JARVIS_CONTAINER_EXECUTION_MODE=dry_run
JARVIS_CONTAINER_CPUS=2.0
JARVIS_CONTAINER_MEMORY=1g
HERMES_API_TRANSPORT=api
JARVIS_HOME_INTENT_PLANNER=hermes
JARVIS_HOME_INTENT_REQUIRED=true
JARVIS_PC_TASK_MODE=hermes
```

Add secrets only to `.env`:

```dotenv
HA_BASE_URL=http://homeassistant.local:8123
HA_TOKEN=replace-with-a-least-privilege-token
```

Never put tokens in `Dockerfile`, `compose.yaml`, shell history, source-controlled examples, image build arguments, or container environment values. The wrapper does not inject the whole `.env`; it passes an explicit non-secret allowlist and exposes HA/Hermes/Xiaozhi credentials through `_FILE` paths. Confirm `.env` remains ignored before proceeding:

```bash
git check-ignore .env
```

## Build And Verify

Run the preflight, image build, and disposable smoke test:

```bash
npm run container:check
npm run container:build
npm run container:smoke
npm run xiaozhi:host:prepare
npm run xiaozhi:host:start
```

The smoke test must prove all of the following before a persistent service starts:

- `/api/runtime/status` responds successfully;
- the reported execution mode is `dry_run`;
- the production frontend is served;
- the temporary container can be removed cleanly.

Start and inspect the persistent service:

```bash
npm run container:start
npm run container:status
npm run container:live-check
curl --fail http://127.0.0.1:5183/api/runtime/status
```

Open `http://127.0.0.1:5183` only after the status check succeeds. `container:start` proves the server is up; `container:live-check` is stricter and fails unless both Hermes and Home Assistant are reachable from the running container. Stop the service with:

```bash
npm run container:stop
```

## Hermes API Transport

The container does not mount the host Hermes installation. The wrapper reuses Hermes' native OpenAI-compatible API instead of creating a proxy or a second agent:

```dotenv
HERMES_API_TRANSPORT=api
JARVIS_HERMES_API_HOST=127.0.0.1
JARVIS_HERMES_API_PORT=8642
JARVIS_APPLE_HERMES_HOST=203.0.113.113
```

Hermes listens only on host loopback. Apple Container reaches it through Apple's
localhost forwarding rule:

```bash
sudo container system dns create host.container.internal --localhost 203.0.113.113
container system dns list
```

The packet-filter rule forwards the reserved local address `203.0.113.113`.
`container:start` uses that address directly because some VPNs fake-resolve
`host.container.internal` into `198.18.0.0/15`. The rule can be removed by a
macOS or Apple Container restart, so the wrapper verifies it and runs an
authenticated disposable-container request before Jarvis starts. Do not replace
this with a LAN or `0.0.0.0` Hermes listener.

`npm run hermes:api:start` generates a 32-byte key, stores it under
`data/jarvis-hermes-api.local/api.key`, updates Hermes' ignored `0600`
environment, and restarts the installed Hermes gateway. Protected API routes
return `401` without that key. Jarvis mounts the secret directory read-only and
uses `HERMES_API_KEY_FILE`; `container inspect` therefore contains only a file
path, not the key.
Disable the API platform without stopping Hermes' direct WeChat gateway with:

```bash
npm run hermes:api:stop
```

The wrapper sets `JARVIS_PC_TASK_MODE=hermes`, so PC requests use Hermes tools on the host. It also sets `JARVIS_HOME_INTENT_REQUIRED=true`: a real control command with neither a verified semantic-cache hit nor a valid Hermes HomeIntent fails closed before HCM execution. HCM remains the only route to Home Assistant.

Verify a harmless non-home request before relying on Hermes for longer tasks. A timeout or connection failure should be treated as an API/networking problem, not as permission to expose Hermes publicly.

## Xiaozhi Host And Delivery Router

The local Xiaozhi process remains on the Mac so StackChan can reach its existing
WebSocket/OTA ports while Jarvis stays containerized:

```bash
npm run xiaozhi:host:prepare
npm run xiaozhi:host:start
npm run xiaozhi:host:status
```

The manager fails closed unless Xiaozhi uses `JarvisLLM`, `nointent`,
`server.auth.enabled=true`, and at least one allowed device. Device WebSocket
`8000` and OTA `8003` may listen on the LAN for the allowlisted StackChan.
Proactive TTS uses a separate bearer-authenticated endpoint on
`127.0.0.1:8004`; Apple Container reaches it through `203.0.113.113:8004`.

Synchronous voice replies return through Xiaozhi's normal LLM/TTS flow.
Background task completion uses Delivery Router:

```text
accepted -> dispatched -> delivered_inferred
```

`delivered_inferred` means Xiaozhi sent `tts.stop` and the same automatic-mode
connection later sent `listen:start`. It is deliberately not described as a
firmware-correlated ACK. Stop the host process with
`npm run xiaozhi:host:stop`.

Transient `offline` and `busy` responses are retried in memory after
`1s,3s,10s` by default, using the same idempotent delivery ID and never beyond
the message TTL. Configure the bounded schedule with
`JARVIS_XIAOZHI_DELIVERY_RETRY_MS`.

Container mode intentionally keeps Delivery Router WeChat disabled because the
container does not mount Hermes' Python installation or WeChat credentials.
Direct WeChat-to-Hermes conversations continue through the existing host
gateway and do not enter Delivery Router.

## Home Assistant Acceptance

Containerization does not change the HCM boundary. Jarvis Brain produces home-control intent, while HCM still applies policy, entity scope, simulation, execution, verification, and audit.

1. Keep `JARVIS_CONTAINER_EXECUTION_MODE=dry_run`.
2. Verify status queries and at least 20 representative dry-run commands.
3. Confirm every plan resolves the intended room, entity, capability, and action.
4. Keep locks, gas, water valves, alarm panels, cameras, and other sensitive capabilities blocked or strongly authorized.
5. Set `JARVIS_CONTAINER_EXECUTION_MODE=real` only for an explicitly accepted deployment, then restart the container.
6. Return immediately to `dry_run` if execution or post-action verification differs from the spoken request.

Home Assistant must be reachable from inside the container. Prefer a stable private LAN IP or DNS record that resolves inside the VM; mDNS-only `.local` names are not guaranteed to resolve there. Do not publish Home Assistant or Jarvis directly to the public internet.

## StackChan And Xiaozhi Networking

The default Jarvis publication on `127.0.0.1:5183` intentionally allows only the
local Xiaozhi process. StackChan connects to Xiaozhi on the Mac's private LAN
address; it does not connect directly to Jarvis or Hermes.

For physical-device testing, use an authenticated private tunnel or a narrowly scoped LAN firewall rule before changing the bind address. Permit only the required trusted source and port, keep camera-related endpoints private, and verify exposed listeners on the host:

```bash
ss -tlnp
```

On macOS, use `lsof -nP -iTCP -sTCP:LISTEN` when `ss` is unavailable. Do not expose the HTTP, WebSocket, Hermes, Home Assistant, or camera surfaces directly to the public internet.

## Data And Updates

Runtime data is stored outside the read-only image at `/app/data` through
`data/container-runtime.local` on Apple Container or a dedicated Docker volume.
Secret-manager directories are not part of that data mount. Back up runtime data
before destructive changes and never commit it.

To update safely:

```bash
git pull --ff-only
npm ci
npm run test:ci
npm run container:build
npm run container:smoke
npm run container:start
```

If the new service fails acceptance, stop it, restore the last known-good image/tag and data backup, and keep execution in `dry_run` while investigating.

## Troubleshooting

### Apple Container is not running

```bash
container system start
container system status
container system logs
```

### Docker daemon is unavailable

Start Docker Desktop or the Docker daemon, then rerun `docker version` and `npm run container:check`.

### Jarvis is healthy but Hermes is unreachable

Confirm `HERMES_API_TRANSPORT=api`, keep Hermes bound to `127.0.0.1`, and
recreate Apple's localhost forwarding rule if `container system dns list` does
not contain `host.container.internal`:

```bash
sudo container system dns create host.container.internal --localhost 203.0.113.113
```

Then rerun `npm run container:start`; its disposable-container probe verifies the
authenticated path before the persistent service starts.

### Home Assistant discovery or execution fails

Check the private HA address, least-privilege token, HCM audit, allowed room/entity scope, and execution mode. Do not solve connectivity by opening HA to the internet.

### Port 5183 is already in use

Stop the old host Jarvis service before switching Xiaozhi to the container. If another local service intentionally owns the port, select a different one and update Xiaozhi's Jarvis LLM base URL at the same time:

```dotenv
JARVIS_CONTAINER_PORT=5184
```

Then restart and use `http://127.0.0.1:5184`.

## Security Checklist

- [ ] The published address is `127.0.0.1` or protected by a reviewed private-access policy.
- [ ] `JARVIS_CONTAINER_EXECUTION_MODE` remains `dry_run` until real-device acceptance is complete.
- [ ] `.env` is ignored; `container inspect` has only `_FILE` secret paths and no inline token/key values.
- [ ] Hermes uses API transport over a private, firewall-restricted path.
- [ ] Xiaozhi auth and its device allowlist are enabled; delivery API `8004` is loopback-only and bearer-authenticated.
- [ ] The runtime is non-root, read-only, capability-dropped, and uses only the dedicated data volume.
- [ ] Home Assistant uses a least-privilege token and sensitive device classes remain blocked.
- [ ] Host listener inspection shows no unexpected public HTTP, WebSocket, HA, Hermes, or camera port.
