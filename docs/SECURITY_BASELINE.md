# Jarvis Security Baseline

> Security baseline for Jarvis PC/container deployments, StackChan/Xiaozhi bridges, Home Assistant access, LLM/TTS providers, and real-device testing.

## 1. Default Network Posture

- Jarvis must not expose HTTP, WebSocket, MCP, TTS, STT, LLM gateway, or debug ports directly to the public internet.
- The server binds to `127.0.0.1` by default through `JARVIS_BIND_HOST=127.0.0.1`.
- Use `JARVIS_BIND_HOST=0.0.0.0` only when a StackChan/Xiaozhi bridge or another LAN client must reach this PC.
- Before binding to `0.0.0.0`, restrict the source network with a local firewall, router ACL, VPN, or a private tunnel.
- For remote access, prefer a private overlay or authenticated tunnel, such as WireGuard, Tailscale, or Cloudflare Tunnel with Access policy. Do not publish the raw Jarvis port.
- If Jarvis is reachable from the LAN, treat every unauthenticated HTTP route as sensitive. This includes `/v1/utterance`, `/mcp`, `/api/hcm/command`, `/api/hcm/overrides/*`, `/api/onboarding/snapshot`, `/api/commands/audit`, and all Home Assistant adapter routes.
- `npm run dev:vite` and `npm run preview` bind locally by default. Use `npm run dev:vite:lan` or `npm run preview:lan` only on a trusted network, and never with real HA tokens or real execution enabled on an untrusted network.
- The integrated Jarvis dev server must not expose a separate public Vite HMR listener. In the managed stack, Jarvis should listen only on `127.0.0.1:5183`; Vite HMR rides the same local HTTP server.

Allowed examples:

```bash
JARVIS_BIND_HOST=127.0.0.1 PORT=5173 npm run dev
```

```bash
JARVIS_BIND_HOST=0.0.0.0 PORT=5183 HARNESS_EXECUTION_MODE=dry_run npm run dev
```

The second form is only acceptable after LAN source restrictions are in place.

## 2. Bridge Authentication

- Any upstream bridge with an `auth.enabled` setting must run with `auth.enabled=true`.
- Add an allowlist for known device identities, such as StackChan/Xiaozhi device id and the device MAC address when the bridge supports it.
- MAC allowlists are a convenience gate, not a complete auth system. MAC addresses can be spoofed and are usually not visible to Jarvis HTTP once traffic crosses a router, proxy, tunnel, or container network.
- Pair device allowlists with a shared secret, bearer token, mTLS, Cloudflare Access service token, or VPN identity before enabling real execution.
- Unknown device ids, empty room ids, or unexpected rooms must stay in dry-run or be rejected.
- Jarvis does not reliably see the source device MAC address at the HTTP layer, especially behind routers, proxies, tunnels, or containers. Put MAC/device allowlists in the upstream bridge, router, firewall, or access gateway.
- Direct Jarvis routes such as `/api/hcm/command` and `/v1/utterance` do not replace bridge authentication. If they are exposed beyond localhost, network source restriction and bridge/access authentication are mandatory before real execution.

Jarvis MCP real execution requires all of these:

```text
HARNESS_EXECUTION_MODE=real
JARVIS_MCP_ALLOW_REAL=true
request.arguments.dryRun=false
```

Recommended Stage-1 physical smoke-test guards. These are intentionally narrower than the product HCM policy and should be left unset for normal HCM operation:

```bash
JARVIS_MCP_ALLOWED_ROOM_IDS=second
JARVIS_MCP_REQUIRE_TEXT_PATTERN='次卧'
JARVIS_INGRESS_ALLOWED_DEVICE_IDS=stackchan-second
JARVIS_INGRESS_ALLOWED_ROOM_IDS=second
JARVIS_INGRESS_REQUIRE_TEXT_PATTERN='次卧'
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-second":"second"}'
JARVIS_ALLOWED_ACTION_ROOM_IDS=second
```

`JARVIS_ALLOWED_ACTION_ROOM_IDS` is the preferred Stage-1 real-device guard. It preserves normal HCM coverage for low-risk devices inside the room while rejecting a command whose resolved `action.logicalRoomId` / `thing.spaceId` points elsewhere. Exact text or entity whitelists such as `JARVIS_MCP_ALLOWED_TEXTS`, `JARVIS_INGRESS_ALLOWED_TEXTS`, and `JARVIS_ALLOWED_ENTITY_IDS` are ultra-narrow smoke-test tools only.

## 3. Xiaozhi Brain Endpoint And PC Tools

When Xiaozhi local Server points its OpenAI-compatible LLM to Jarvis, the Jarvis `/v1/chat/completions` endpoint becomes a voice-command control surface. Treat it like MCP:

- Keep it LAN/private only.
- Set `JARVIS_XIAOZHI_ALLOW_REAL=false` until dry-run evidence is reviewed.
- Use `JARVIS_XIAOZHI_DEVICE_ID` and `JARVIS_XIAOZHI_ROOM_ID` for the first physical StackChan placement.
- Use `JARVIS_ALLOWED_ACTION_ROOM_IDS` during Stage-1 real HA testing.

PC automation tools must be explicit and workspace-scoped:

```bash
JARVIS_PC_WORKSPACE_ROOT=data/pc-workspace.local
```

The initial `computer_create_markdown_file` tool can only write `.md` files inside this directory. Do not add shell execution, arbitrary path writes, or unrestricted app-control tools without a separate threat review and tests.

## 4. Secrets

- Do not put LLM, TTS, STT, HA, Cloudflare, or bridge API keys into tracked config files.
- Keep secrets in environment variables, `.env` files excluded by `.gitignore`, OS keychain, container secrets, or a secret manager.
- Never commit:
  - `.env`, `.env.*`
  - HA long-lived access tokens
  - OpenAI-compatible provider keys
  - TTS/STT provider keys
  - Cloudflare API tokens or tunnel credentials
  - Home Assistant snapshots containing tokens, passwords, URLs, or device secrets
  - local audit logs that may contain private commands
- Audit and provider snapshots must redact `authorization`, `token`, `password`, `api_key`, and similar secret fields.

## 5. Camera And Sensitive Devices

- Camera, microphone, lock, alarm, gas, water valve, valve, and safety-critical controls must not auto-execute.
- Camera snapshot, stream, privacy-mode, recording, and pan/tilt actions require explicit future authorization design before they can be enabled.
- Devices or capabilities whose names look like camera, monitoring, microphone, or recording targets must be blocked even if the provider misclassified their type.
- A public or unauthenticated port must be treated as equivalent to exposing camera and home-control capability to strangers.
- LLMs may help interpret user intent, but they must not receive camera media or decide final execution permission.
- Jarvis policy gates must remain the final local authority for sensitive device blocking.

## 6. Real Execution Rules

- Keep `HARNESS_EXECUTION_MODE=dry_run` until the exact target has passed dry-run audit.
- Real execution may only be enabled for explicit, low-risk, user-authorized tests.
- Before each real-device test, record:
  - command text
  - room id
  - device id
  - HCM thing and capability
  - HA entity id
  - selected service
  - risk level
  - rollback or off command
- Do not broaden a recovery command. If `关闭次卧吸顶灯` fails, do not issue `关卧室灯`, `关全屋灯`, or other wide commands.

## 7. Deployment Self-Check

Run this after each deployment or before enabling real execution.

Linux:

```bash
ss -tlnp
```

macOS:

```bash
lsof -nP -iTCP -sTCP:LISTEN
```

Focused checks:

```bash
lsof -nP -iTCP:5183 -iTCP:8000 -iTCP:8003 -iTCP:24678 -sTCP:LISTEN
curl -fsS http://127.0.0.1:5183/api/runtime/status
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5183/api/adapters/home-assistant/actions
```

Required checks:

- No unexpected listener is present.
- Jarvis is bound to `127.0.0.1` unless LAN access is intentionally required.
- No current Jarvis `node` process is listening on `*:24678` or another public HMR/debug port.
- If Jarvis is bound to `0.0.0.0`, firewall or tunnel access is already restricted to trusted sources.
- Home Assistant is not exposed through Jarvis routes that bypass HCM.
- `/api/adapters/home-assistant/actions` remains disabled.
- `/api/adapters/home-assistant/actions` returns `410`.
- `/mcp` real execution is blocked unless the three real-execution gates are enabled.
- The first physical test uses room and text guards.
- TTS output cannot feed back into STT as a new command.
- Camera and other sensitive device actions remain blocked by policy tests.

## 7. Incident Response

If a port was exposed, a token leaked, or an unknown client reached Jarvis:

1. Stop Jarvis and any bridge services.
2. Rotate HA, LLM, TTS/STT, Cloudflare, and bridge credentials.
3. Review command audit logs and HA logbook/history for unexpected actions.
4. Re-enable only in `dry_run`.
5. Re-run the deployment self-check before returning to real execution.
