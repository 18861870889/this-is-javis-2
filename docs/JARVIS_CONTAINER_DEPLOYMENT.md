# Jarvis Container Deployment

This runbook deploys the PC-side Jarvis service as one OCI image. It prefers Apple Container on supported Macs and keeps Docker Compose as the portable fallback.

The defaults are intentionally conservative:

- publish only on `127.0.0.1`;
- keep Home Assistant actions in `dry_run`;
- load credentials from an ignored local `.env`, never from the image;
- run Hermes through its API transport;
- run as a non-root user with a read-only root filesystem and dropped capabilities.

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
JARVIS_CONTAINER_PORT=5173
JARVIS_CONTAINER_EXECUTION_MODE=dry_run
JARVIS_CONTAINER_CPUS=2.0
JARVIS_CONTAINER_MEMORY=1g
HERMES_API_TRANSPORT=api
```

Add secrets only to `.env`:

```dotenv
HA_BASE_URL=http://homeassistant.local:8123
HA_TOKEN=replace-with-a-least-privilege-token
HERMES_API_BASE_URL=http://host-address-reachable-from-the-container:19998
```

Never put tokens in `Dockerfile`, `compose.yaml`, shell history, source-controlled examples, or image build arguments. Confirm `.env` remains ignored before proceeding:

```bash
git check-ignore .env
```

## Build And Verify

Run the preflight, image build, and disposable smoke test:

```bash
npm run container:check
npm run container:build
npm run container:smoke
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
curl --fail http://127.0.0.1:5173/api/runtime/status
```

Open `http://127.0.0.1:5173` only after the status check succeeds. Stop the service with:

```bash
npm run container:stop
```

## Hermes API Transport

The container does not mount a host Hermes installation or execute its local CLI. Non-home tasks therefore use:

```dotenv
HERMES_API_TRANSPORT=api
HERMES_API_BASE_URL=http://host-address-reachable-from-the-container:19998
```

Do not use `127.0.0.1` for a Hermes process running on the host: from inside the container it points back to Jarvis's own Linux environment. Use a host address that the selected runtime can reach, then restrict that Hermes listener with the host firewall. Keep `JARVIS_SUBAGENT_COMMAND` unset unless a separately reviewed remote execution design is introduced.

Verify a harmless non-home request before relying on Hermes for longer tasks. A timeout or connection failure should be treated as an API/networking problem, not as permission to expose Hermes publicly.

## Home Assistant Acceptance

Containerization does not change the HCM boundary. Jarvis Brain produces home-control intent, while HCM still applies policy, entity scope, simulation, execution, verification, and audit.

1. Keep `JARVIS_CONTAINER_EXECUTION_MODE=dry_run`.
2. Verify status queries and at least 20 representative dry-run commands.
3. Confirm every plan resolves the intended room, entity, capability, and action.
4. Keep locks, gas, water valves, alarm panels, cameras, and other sensitive capabilities blocked or strongly authorized.
5. Set `JARVIS_CONTAINER_EXECUTION_MODE=real` only for an explicitly accepted deployment, then restart the container.
6. Return immediately to `dry_run` if execution or post-action verification differs from the spoken request.

Home Assistant must be reachable from inside the container. Prefer a stable private LAN address or private DNS name; do not publish Home Assistant or Jarvis directly to the public internet.

## StackChan And Xiaozhi Networking

The default `127.0.0.1` publication intentionally allows only local clients. A StackChan or Xiaozhi service on another device cannot reach that address.

For physical-device testing, use an authenticated private tunnel or a narrowly scoped LAN firewall rule before changing the bind address. Permit only the required trusted source and port, keep camera-related endpoints private, and verify exposed listeners on the host:

```bash
ss -tlnp
```

On macOS, use `lsof -nP -iTCP -sTCP:LISTEN` when `ss` is unavailable. Do not expose the HTTP, WebSocket, Hermes, Home Assistant, or camera surfaces directly to the public internet.

## Data And Updates

Runtime data is stored outside the read-only image at `/app/data` through a dedicated volume. Back up that volume before destructive changes. Do not commit its contents because it can contain household topology, audits, learned behavior, or conversation context.

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

Confirm `HERMES_API_TRANSPORT=api`, replace a host-only `127.0.0.1` Hermes URL, and test the configured address from the container network. Keep the listener private.

### Home Assistant discovery or execution fails

Check the private HA address, least-privilege token, HCM audit, allowed room/entity scope, and execution mode. Do not solve connectivity by opening HA to the internet.

### Port 5173 is already in use

Choose another localhost port in `.env`, for example:

```dotenv
JARVIS_CONTAINER_PORT=5183
```

Then restart and use `http://127.0.0.1:5183`.

## Security Checklist

- [ ] The published address is `127.0.0.1` or protected by a reviewed private-access policy.
- [ ] `JARVIS_CONTAINER_EXECUTION_MODE` remains `dry_run` until real-device acceptance is complete.
- [ ] `.env` is ignored and no secret is present in image history or tracked files.
- [ ] Hermes uses API transport over a private, firewall-restricted path.
- [ ] The runtime is non-root, read-only, capability-dropped, and uses only the dedicated data volume.
- [ ] Home Assistant uses a least-privilege token and sensitive device classes remain blocked.
- [ ] Host listener inspection shows no unexpected public HTTP, WebSocket, HA, Hermes, or camera port.
