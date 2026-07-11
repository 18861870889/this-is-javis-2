# Xiaozhi StackChan Runbook

This runbook covers the local StackChan -> Xiaozhi Server -> Jarvis -> Home Assistant/PC path. It is intentionally secret-free: keep HA tokens, Xiaozhi tokens, LLM keys, Wi-Fi credentials, user names, private URLs, and device-specific secrets out of this file.

## Scope

- PC Jarvis repo: `/Users/jerf/Documents/this is javis 2`
- Xiaozhi Server repo: `/Users/jerf/Documents/xiaozhi-esp32-server-jarvis/main/xiaozhi-server`
- StackChan firmware repo: `/Users/jerf/Documents/stackchan-jarvis-firmware`
- Jarvis default port: `5183`
- Jarvis default bind host: `127.0.0.1`
- Jarvis brain endpoint: `POST /v1/chat/completions`
- Jarvis MCP endpoint: `POST /mcp`
- First physical mode: Xiaozhi Server keeps ASR, TTS, and VAD; only its LLM provider points to Jarvis.
- Firmware state: full flash backup exists; the current Jarvis candidate has been flashed with explicit approval. Do not flash again unless a new candidate passes preflight and flashing is explicitly approved.

## Architecture

```text
StackChan mic/speaker
  -> local Xiaozhi Server
     - ASR
     - VAD
     - TTS
     - WebSocket/OTA service for StackChan
  -> Jarvis OpenAI-compatible /v1/chat/completions
     - HCM routing and policy
     - Home Assistant dry-run or real execution gate
     - restricted PC tool routing
  -> Home Assistant or PC workspace
```

Jarvis remains the control authority. Xiaozhi should not call HA directly and should not receive broad PC automation capability. For the first integration, Xiaozhi sends recognized user text to Jarvis as an OpenAI-compatible chat completion request and speaks Jarvis's response through its own TTS pipeline.

## Port And Security Constraints

- Keep Jarvis on `127.0.0.1:5183` whenever Xiaozhi runs on the same PC.
- Use `JARVIS_BIND_HOST=0.0.0.0` only when Xiaozhi or StackChan must reach Jarvis from another LAN host.
- If Jarvis is reachable on the LAN, restrict source access with a trusted local network, host firewall, router ACL, VPN, or private tunnel before enabling real HA execution.
- Never expose Jarvis, Xiaozhi, OTA, MCP, HA, STT, TTS, or debug ports directly to the public internet.
- Keep every real token in local environment variables, ignored `.env` files, OS keychain, container secrets, or a secret manager.
- Treat `/v1/chat/completions` like a control surface. It can route text into HA and the restricted PC tool.

Suggested listening self-check on macOS:

```bash
lsof -nP -iTCP -sTCP:LISTEN
lsof -nP -iTCP:5183 -sTCP:LISTEN
curl -fsS http://127.0.0.1:5183/api/runtime/status
```

Pass criteria:

- Jarvis is listening on the expected host and port.
- No unexpected public listener is present.
- Real HA execution remains disabled during arrival tests.

## Start Jarvis

Preferred managed commands:

```bash
cd "/Users/jerf/Documents/this is javis 2"

npm run jarvis:stack:check
npm run jarvis:stack:start
npm run jarvis:stack:status
npm run jarvis:stack:stop
```

The managed stack starts Jarvis on `127.0.0.1:5183` and Xiaozhi Server on `0.0.0.0:8000` / `0.0.0.0:8003`. Logs and pid files are local-only under `data/jarvis-stack.local/`.

Start Jarvis manually with dry-run defaults only when debugging the stack script:

```bash
cd "/Users/jerf/Documents/this is javis 2"

JARVIS_BIND_HOST=127.0.0.1 \
PORT=5183 \
HARNESS_EXECUTION_MODE=dry_run \
JARVIS_XIAOZHI_DEVICE_ID=stackchan-second \
JARVIS_XIAOZHI_ROOM_ID=second \
JARVIS_XIAOZHI_ALLOW_REAL=false \
JARVIS_PC_WORKSPACE_ROOT=data/pc-workspace.local \
JARVIS_ALLOWED_ACTION_ROOM_IDS=second \
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-second":"second"}' \
npm run dev
```

If Xiaozhi runs on another LAN machine, change only the bind host after network restrictions are in place:

```bash
JARVIS_BIND_HOST=0.0.0.0 PORT=5183 HARNESS_EXECUTION_MODE=dry_run npm run dev
```

Do not switch to `HARNESS_EXECUTION_MODE=real` until the dry-run acceptance checklist below has passed.

## Configure Xiaozhi Server

Keep Xiaozhi's voice modules selected and change only the LLM provider to Jarvis:

```yaml
selected_module:
  ASR: FunASR
  VAD: SileroVAD
  TTS: EdgeTTS
  LLM: JarvisLLM
  Intent: nointent
  Memory: nomem

LLM:
  JarvisLLM:
    type: openai
    base_url: http://<jarvis-host-or-lan-ip>:5183/v1
    model_name: jarvis
    api_key: placeholder-not-a-real-secret
```

Use `http://127.0.0.1:5183/v1` only when Xiaozhi and Jarvis run on the same host. Use the PC LAN IP only when Xiaozhi runs elsewhere on the LAN and Jarvis is intentionally bound to `0.0.0.0`.

Current local override path:

```text
/Users/jerf/Documents/xiaozhi-esp32-server-jarvis/main/xiaozhi-server/data/.config.yaml
```

Current OTA self-check:

```bash
curl -fsS http://127.0.0.1:8003/xiaozhi/ota/
```

Expected response includes:

```text
ws://192.168.31.99:8000/xiaozhi/v1/
```

Xiaozhi acceptance checks:

```bash
curl -s http://127.0.0.1:5183/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"jarvis","messages":[{"role":"user","content":"打开次卧吸顶灯"}]}' | jq
```

Pass criteria:

- Jarvis returns a chat-completion-shaped response.
- The underlying home route stays dry-run.
- No HA device changes state.
- Jarvis logs or audit show the expected StackChan/Xiaozhi device and room context.

## Point StackChan To Local Xiaozhi Server

Do not flash yet. First verify the local Xiaozhi Server can reach Jarvis and can serve the expected StackChan WebSocket and OTA endpoints.

Firmware repo:

```bash
cd "/Users/jerf/Documents/stackchan-jarvis-firmware"
```

Before any flashing or OTA change:

- Confirm the full flash backup is still present and readable.
- Record the current firmware version and current server endpoint settings.
- Keep the original cloud/server endpoint values in a local untracked note if needed.
- Do not commit Wi-Fi credentials, tokens, device IDs, or private endpoint URLs.

When physical testing is approved, point StackChan's runtime configuration to the local Xiaozhi Server, not directly to Jarvis:

```text
XIAOZHI_WS_URL=ws://<xiaozhi-server-lan-ip>:<ws-port>/<path>
XIAOZHI_OTA_URL=http://<xiaozhi-server-lan-ip>:<ota-port>/<path>
```

Use the actual Xiaozhi Server route names from the local server config. The values above are placeholders and must not be committed with real private details.

StackChan local-server pass criteria:

- StackChan connects to the local Xiaozhi WebSocket endpoint.
- OTA check reaches the local Xiaozhi OTA endpoint, if OTA is enabled.
- Xiaozhi sends LLM requests to Jarvis `POST /v1/chat/completions`.
- Jarvis stays in dry-run for HA control.
- TTS audio comes from Xiaozhi back to StackChan.

## HA Real-Control Phases

Phase 0: no physical control.

- `HARNESS_EXECUTION_MODE=dry_run`
- `JARVIS_XIAOZHI_ALLOW_REAL=false`
- Only curl/Xiaozhi/StackChan dry-run voice tests are allowed.
- Expected result: HCM route, policy result, and simulator/audit evidence; no HA service call.

Phase 1: one low-risk allowlisted room or device.

- Use only low-risk devices such as a single light or switch.
- Keep sensitive devices blocked: locks, gas, water valves, alarms, cameras, microphones, and safety-critical devices.
- Prefer `JARVIS_ALLOWED_ACTION_ROOM_IDS=second` for the first real room guard.
- Enable real execution only for the session being tested. Preferred command:

```bash
cd "/Users/jerf/Documents/this is javis 2"
npm run jarvis:stack:stop
npm run jarvis:stack:real-second
```

Manual equivalent:

```bash
JARVIS_BIND_HOST=127.0.0.1 \
PORT=5183 \
HARNESS_EXECUTION_MODE=real \
JARVIS_XIAOZHI_ALLOW_REAL=true \
JARVIS_ALLOWED_ACTION_ROOM_IDS=second \
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-second":"second"}' \
npm run dev
```

Real execution still requires Jarvis HCM/policy approval. If the command resolves outside the allowed room or requires confirmation, stop and return to dry-run.

`real-second` adds two first-stage guards:

- The utterance must match the text pattern `次卧`.
- The resolved HCM action room must be `second`.

Phase 2: full-home low-risk delivery mode for user acceptance.

- This is the default handoff mode for user-side physical testing after engineering smoke has passed.
- It removes the Stage-1 `second` room and `次卧` text-pattern guards.
- It still keeps HCM grounding, safety, policy, simulator, decision review, state verification, and audit.
- Strong safety devices remain blocked by policy: locks, gas, water valves, alarms, cameras, microphones, and similar safety-critical devices.
- Explicit room names still win over source room. If you say "关主卧灯" while standing in the second bedroom, Jarvis should target the master bedroom or reject through HCM policy, not silently rewrite the target to the second bedroom.

Preferred command for handoff testing:

```bash
cd "/Users/jerf/Documents/this is javis 2"
npm run jarvis:stack:stop
npm run jarvis:stack:check:real-home
npm run jarvis:stack:real-home
```

Engineering small-scope regression remains available:

```bash
npm run jarvis:stack:stop
npm run jarvis:stack:check:real-second
npm run jarvis:stack:real-second
```

Recommended physical prompts in `real-home`:

```text
小黑，打开次卧吸顶灯
小黑，关闭次卧吸顶灯
小黑，打开主卧主灯
小黑，主卧主灯开着吗
小黑，帮我总结今天要做什么
小黑，在电脑工作区新建 hello.md 并写入 helloworld
```

Pass criteria:

- Home commands that resolve to low-risk devices can execute across rooms.
- Safety-critical devices are rejected.
- Non-home tasks call Hermes and return a natural spoken answer.
- PC Markdown writes only inside `JARVIS_PC_WORKSPACE_ROOT`.
- `data/command-audit.local.jsonl` records home execution decisions.
- `data/delivery-audit.local.jsonl` records StackChan/Xiaozhi/MCP-originated delivery status.

Before every real test, record locally:

- utterance text
- StackChan device id
- room id
- HCM thing/capability
- HA entity id
- HA service
- expected rollback command

## PC Markdown File Acceptance Test

The first PC tool is intentionally narrow: `computer_create_markdown_file` can create or update `.md` files only inside `JARVIS_PC_WORKSPACE_ROOT`.

MCP tool test:

```bash
curl -s http://127.0.0.1:5183/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"computer_create_markdown_file","arguments":{"filename":"stackchan-smoke.md","content":"helloworld","overwrite":false}}}' | jq
```

Xiaozhi brain endpoint test:

```bash
curl -s http://127.0.0.1:5183/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"jarvis","messages":[{"role":"user","content":"在电脑工作区新建一个 md 文件 stackchan-smoke.md，写入 helloworld"}]}' | jq
```

Pass criteria:

- Jarvis creates or reports the `.md` file inside `data/pc-workspace.local`.
- No arbitrary path write is possible.
- Non-markdown filenames are rejected.
- No shell command, app control, or unrestricted filesystem tool is exposed.

## Non-Physical Acceptance

Run this checklist before any new OTA or flash step, and after every stack/server change:

1. Jarvis starts on `5183` with `HARNESS_EXECUTION_MODE=dry_run`.
2. Xiaozhi selected modules keep ASR, VAD, and TTS local/server-side.
3. Xiaozhi LLM provider uses Jarvis `base_url: http://<jarvis-host>:5183/v1`.
4. A direct curl to `/v1/chat/completions` returns a valid assistant response.
5. A home-control utterance produces HCM/policy/audit evidence and no HA state change.
6. A PC markdown request creates only a `.md` file in the configured workspace.
7. StackChan can connect to local Xiaozhi WebSocket without direct Jarvis access.
8. OTA endpoint is local and verified; flashing or rollback occurs only through the guarded firmware commands.
9. Secrets are absent from git status, config snippets, logs copied into docs, and commits.

Local non-destructive chain check:

```bash
cd "/Users/jerf/Documents/this is javis 2"
npm run jarvis:stack:e2e
npm run xiaozhi:ws-smoke
```

This checks Jarvis runtime, Xiaozhi OTA response, MCP manifest, read-only HA state query, restricted PC Markdown creation, Xiaozhi WebSocket ingress, Jarvis LLM routing, TTS text events, and TTS binary audio frames. It does not flash StackChan and does not perform real HA control.

`jarvis:stack:acceptance` is an alias for `jarvis:stack:e2e`; run `xiaozhi:ws-smoke` separately when you need the simulated StackChan WebSocket path.

After flashing, print the physical voice checklist:

```bash
npm run jarvis:stack:e2e -- --device
```

For live physical voice acceptance, prefer the session wrapper before speaking to StackChan:

```bash
npm run stackchan:voice:session -- --scenario=home-state
```

The session wrapper creates a timestamped evidence directory, records stack/OTA prechecks, tries to capture StackChan serial logs, and starts the watcher with trigger evidence enabled.

For lower-level debugging, run the watcher directly:

```bash
npm run stackchan:voice:watch -- --scenario=home-state --expect-text=次卧吸顶灯
```

Use the deterministic manual path first: hold StackChan's head, say `次卧吸顶灯开着吗`, then release. To require explicit wake/touch evidence, add `--require-trigger`; to prove `小黑` specifically, also pass a StackChan serial log with `--serial-log=/tmp/stackchan-serial.log`.

The watcher classifies the chain by stage: device connection, listen start, audio frames, VAD, ASR, recognized text, Xiaozhi LLM ingress, TTS, Jarvis/HCM audit, HA result, and PC markdown result. Full instructions are in `docs/STACKCHAN_PHYSICAL_VOICE_ACCEPTANCE.md`.

Real HA control in the e2e script is guarded separately and only targets the second-bedroom ceiling light:

```bash
JARVIS_E2E_REAL_CONTROL_APPROVED=I_UNDERSTAND_THIS_CONTROLS_SECOND_BEDROOM_LIGHT \
  npm run jarvis:stack:e2e -- --real-control
```

Latency smoke in `real-second` mode must use the allowlisted StackChan device, room, and text pattern:

```bash
JARVIS_URL=http://127.0.0.1:5183 \
JARVIS_LATENCY_DEVICE_A=stackchan-second \
JARVIS_LATENCY_DEVICE_B=stackchan-second \
JARVIS_LATENCY_ROOM_ID=second \
JARVIS_LATENCY_DUPLICATE_TEXT=次卧吸顶灯开着吗 \
  npm run jarvis:latency
```

## Verified Local Results

Latest local checks:

```bash
node --check server.mjs
node --check scripts/xiaozhi-mcp-bridge.mjs
node --check scripts/jarvis-stack.mjs
node --check scripts/jarvis-latency-smoke.mjs
node --check scripts/stackchan-firmware-gate.mjs
node --check scripts/stackchan-e2e-check.mjs
node --check scripts/xiaozhi-ws-smoke.mjs
npm run jarvis:stack:check
npm run jarvis:stack:check:real-second
npm run jarvis:stack:check:real-home
npm run stackchan:firmware:preflight
npm run stackchan:firmware:device-check
npm run jarvis:stack:e2e
npm run xiaozhi:ws-smoke
npm test -- --run src/jarvisServerRoutes.test.js src/jarvisVoiceBridge.test.js src/policyEngine.test.js src/skipPlanner.test.js
```

Observed results:

- Xiaozhi Python venv exists and imports Torch, FunASR, EdgeTTS, OpenAI SDK, and Opus successfully.
- SenseVoiceSmall `model.pt` exists at `936291369` bytes with SHA-256 `833ca2dcfdf8ec91bd4f31cfac36d6124e0c459074d5e909aec9cabe6204a3ea`.
- Jarvis runtime gate is clean after local `.env` migration; HA adapter reports configured.
- Dry-run utterance `打开次卧吸顶灯` returns: `这是预览：会操作 次卧吸顶灯，不会控制真实设备。`
- PC tool utterance creates `data/pc-workspace.local/hello.md` with `helloworld`.
- `real-second` utterance `打开次卧吸顶灯` executed `switch.turn_on` for `switch.topwit_cn_1110296386_rzw33_on_p_3_1`.
- Read-back utterance confirmed: `次卧吸顶灯开着`.
- Guard check `打开主卧灯` returns HTTP `403` in `real-second` mode because it does not match the allowed text pattern.
- `jarvis:stack:e2e` passes for Jarvis runtime, Xiaozhi OTA, MCP manifest, read-only HA query, and restricted PC Markdown creation.
- `xiaozhi:ws-smoke` passes with simulated StackChan WebSocket device ID `80:45:6b:4d:da:d0`: home state prompt returned TTS text for second-bedroom light state and `24668` TTS audio bytes; PC Markdown prompt created `xiaozhi-ws-smoke-1783295652919.md`, returned spoken progress text, and `26479` TTS audio bytes.
- Guarded real-control e2e opened `次卧吸顶灯`, read back `次卧吸顶灯开着`, then the manual restore command closed it and read back all second-bedroom lights off.
- `jarvis:latency` in real-second-compatible mode reports duplicate p95 `3ms` against the `100ms` budget.
- Focused Vitest regression passes: 4 files, 32 tests.

Current firmware candidate:

- Firmware build directory: `/Users/jerf/Documents/stackchan-jarvis-firmware/firmware/build-xiaohei-local`.
- The build loaded `sdkconfig.defaults.jarvis` plus ignored `sdkconfig.defaults.local`.
- `sdkconfig.h` shows `CONFIG_USE_CUSTOM_WAKE_WORD=1`, `CONFIG_CUSTOM_WAKE_WORD="xiao hei"`, `CONFIG_CUSTOM_WAKE_WORD_DISPLAY="小黑"`, `CONFIG_SR_MN_CN_MULTINET7_QUANT=1`, and local `CONFIG_OTA_URL`.
- `stack-chan.bin` is `3787120` bytes; the app partition check reports 27% free.
- `generated_assets.bin` is `4688585` bytes, below the 5MB assets partition.
- Firmware artifact SHA-256: `stack-chan.bin` = `e08ff7de5a70c991ce843d43f002fd355874b6f3f7054e95d4b7c70f443ef427`; `generated_assets.bin` = `ccd7d1ef488aa07eb4f5c982084db9515bc902f588c6c3ba2ec193070315cbfe`.
- The app binary contains the Jarvis auto-start marker plus head-touch manual listening start/stop markers.
- Read-only device checks on `/dev/cu.usbmodem31201` report ESP32-S3, MAC `80:45:6b:4d:da:d0`, and detected flash size 16MB.
- This candidate has already been flashed successfully. The last flash verified all written segments and hard-reset the device.

Firmware gate commands:

```bash
cd "/Users/jerf/Documents/this is javis 2"
npm run stackchan:firmware:preflight
```

The preflight command is read-only and does not touch the USB device. It checks the factory backup, candidate firmware hashes, app/assets sizes, `小黑` wake-word config, and local OTA URL.

Device read checks are a separate explicit step:

```bash
npm run stackchan:firmware:device-check
```

This checks the StackChan USB port, chip ID, MAC allowlist, and 16MB flash size without writing flash.

Flash is intentionally guarded and must not be run without explicit approval:

```bash
cd "/Users/jerf/Documents/this is javis 2"
JARVIS_STACKCHAN_FLASH_APPROVED=I_UNDERSTAND_THIS_WRITES_DEVICE \
  npm run stackchan:firmware:flash
```

Rollback is also guarded:

```bash
cd "/Users/jerf/Documents/this is javis 2"
JARVIS_STACKCHAN_ROLLBACK_APPROVED=I_UNDERSTAND_THIS_WRITES_DEVICE \
  npm run stackchan:firmware:rollback
```

Remaining physical-device gap:

- Xiaozhi Server is running locally and the device has connected to it. The missing acceptance is a person physically next to StackChan proving: `小黑` or head-touch input -> useful ASR text -> Jarvis/HCM or PC tool -> Xiaozhi TTS -> audible StackChan response.

## Rollback And No-Flash Notes

- The current safe default is no further flashing. Keep the flashed Jarvis candidate in place while validating physical voice.
- If another OTA or flash test is later approved, verify the full flash backup before changing the device.
- Keep a known-good firmware image and the original endpoint configuration available outside git.
- To roll back a failed local-server test, stop Xiaozhi/Jarvis, restore the previous StackChan endpoint settings, and return Jarvis to `HARNESS_EXECUTION_MODE=dry_run`.
- To roll back a real HA test, issue only the pre-recorded narrow inverse command for the same low-risk entity, then disable real execution.
- If a token or private endpoint appears in a log or config, stop testing, rotate the affected secret, and remove the leaked material from any tracked file before continuing.

## Files Changed

- `docs/XIAOZHI_STACKCHAN_RUNBOOK.md`
- `docs/STACKCHAN_PHYSICAL_VOICE_ACCEPTANCE.md`
- `scripts/jarvis-stack.mjs`
- `scripts/stackchan-e2e-check.mjs`
- `scripts/stackchan-firmware-gate.mjs`
- `scripts/stackchan-voice-watch.mjs`
- `scripts/xiaozhi-ws-smoke.mjs`
- `package.json`
