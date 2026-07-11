# Jarvis MCP Bridge

Jarvis exposes a small JSON-RPC HTTP MCP bridge for StackChan/Xiaozhi or Home Assistant MCP proxies.

The bridge does not bypass Jarvis. Tool calls are routed into the same `/v1/utterance` ingress path: ingress hygiene and dedupe run first, Jarvis Brain recognizes intent, home tasks become `HomeIntent`, and HCM then owns grounding, safety, policy, provider simulation, decision review, audit, and learning feedback.

## Endpoint

```http
POST http://<jarvis-pc-host>:5183/mcp
Content-Type: application/json
```

Jarvis binds to `127.0.0.1` by default. If a StackChan/Xiaozhi device must reach the PC over LAN, set `JARVIS_BIND_HOST=0.0.0.0` only after applying the network, auth, and port self-checks in [Security Baseline](SECURITY_BASELINE.md).

Health/capability probe:

```http
GET http://<jarvis-pc-host>:5183/mcp
```

## Tools

`jarvis_home_command`

Input:

```json
{
  "text": "打开次卧吸顶灯",
  "deviceId": "stackchan-second",
  "roomId": "second",
  "wakeSessionId": "stackchan-wake-001",
  "dryRun": true
}
```

Response content is speakable text. `structuredContent` contains the underlying Jarvis voice result.

`computer_create_markdown_file`

Input:

```json
{
  "filename": "hello.md",
  "content": "helloworld",
  "overwrite": false
}
```

This tool can only create or update `.md` files inside `JARVIS_PC_WORKSPACE_ROOT`. It does not expose shell, arbitrary paths, app control, or general filesystem writes.

Response content is also speakable text, for example: "已创建电脑工作区里的 hello.md，写入内容：helloworld。"

## Xiaozhi Local Server Brain Mode

Preferred local architecture:

```text
StackChan -> Xiaozhi Server ASR/VAD/TTS -> Jarvis Brain /v1/chat/completions
  -> HomeIntent -> HCM/HA
  -> Agent task -> Hermes/Jarvis Agent or restricted PC tools
  -> Delivery Router -> Xiaozhi TTS / WeChat / audit
```

Keep Xiaozhi's voice pipeline and change only the LLM provider to Jarvis:

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
    base_url: http://<jarvis-lan-ip>:5183/v1
    model_name: jarvis
    api_key: dummy
```

Jarvis implements `POST /v1/chat/completions` for this mode. The endpoint currently treats Xiaozhi as an ingress adapter and routes through Jarvis Brain:

- Home control/state text becomes `HomeIntent`, then HCM performs grounding, policy, audit, and Home Assistant execution/readback.
- "新建/创建 md 文件并写入..." requests enter the current restricted local PC action.
- Other general assistant requests are agent tasks; the current implementation has a bounded fallback until Hermes/Jarvis Agent is fully wired in.

Set these Jarvis environment variables for the first physical Xiaozhi/StackChan test:

```bash
JARVIS_XIAOZHI_DEVICE_ID=stackchan-second
JARVIS_XIAOZHI_ROOM_ID=second
JARVIS_XIAOZHI_ALLOW_REAL=false
JARVIS_PC_WORKSPACE_ROOT=data/pc-workspace.local
```

`JARVIS_XIAOZHI_ALLOW_REAL=true` only removes the Xiaozhi dry-run preference. Real HA execution still also requires `HARNESS_EXECUTION_MODE=real` and HCM/policy approval.

## Safety Defaults

- MCP calls default to `dryRun: true`.
- If a client sends `dryRun:false`, Jarvis still forces dry-run unless `JARVIS_MCP_ALLOW_REAL=true`.
- Real execution also requires `HARNESS_EXECUTION_MODE=real`.
- Optional room guard:

```bash
JARVIS_MCP_ALLOWED_ROOM_IDS=second
```

- Optional text guard:

```bash
JARVIS_MCP_REQUIRE_TEXT_PATTERN='次卧'
```

For the first StackChan physical smoke test, use the guards below. They are deliberately narrower than the normal HCM policy. Leave the exact text/entity guards unset after the smoke test when returning to normal HCM-scoped operation.
For normal Stage-1 real control, prefer `JARVIS_ALLOWED_ACTION_ROOM_IDS=second`: it keeps all low-risk HCM-supported devices in the room available while rejecting any resolved action outside that room.

## Local Test

Start Jarvis on a safe test port:

```bash
JARVIS_BIND_HOST=127.0.0.1 \
PORT=5183 \
HARNESS_EXECUTION_MODE=dry_run \
JARVIS_MCP_ALLOWED_ROOM_IDS=second \
JARVIS_MCP_REQUIRE_TEXT_PATTERN='次卧' \
JARVIS_INGRESS_ALLOWED_DEVICE_IDS=stackchan-second \
JARVIS_INGRESS_ALLOWED_ROOM_IDS=second \
JARVIS_INGRESS_REQUIRE_TEXT_PATTERN='次卧' \
JARVIS_ALLOWED_ACTION_ROOM_IDS=second \
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-second":"second"}' \
npm run dev
```

List tools:

```bash
curl -s http://127.0.0.1:5183/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq
```

Dry-run a second-bedroom light:

```bash
curl -s http://127.0.0.1:5183/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"jarvis_home_command","arguments":{"deviceId":"stackchan-second","roomId":"second","wakeSessionId":"mcp-dryrun-1","text":"打开次卧吸顶灯","dryRun":true}}}' | jq
```

Create a Markdown file in the restricted PC workspace:

```bash
curl -s http://127.0.0.1:5183/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"computer_create_markdown_file","arguments":{"filename":"hello.md","content":"helloworld"}}}' | jq
```

Test the Xiaozhi-compatible brain endpoint:

```bash
curl -s http://127.0.0.1:5183/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"jarvis","messages":[{"role":"user","content":"在电脑上新建一个md文件并写入helloworld"}]}' | jq
```

Pass criteria before real execution:

- `structuredContent.route` is `hcm_fast_path`.
- `structuredContent.status` is `dry_run`.
- Audit shows exactly one target.
- The target room is `second`.
- The service target is the intended second-bedroom light.
- Provider simulation is accepted.

If the status is `needs_clarification`, `needs_confirmation`, or `rejected`, do not switch to real execution.

## Xiaozhi/StackChan Cloud Bridge

Factory StackChan AI Agent uses Xiaozhi's cloud MCP access point. In that mode, StackChan does not call the local Jarvis URL directly. Run a local bridge that connects outbound to the Xiaozhi `wss://api.xiaozhi.me/mcp/?token=...` access point and forwards JSON-RPC MCP messages to Jarvis:

```bash
XIAOZHI_MCP_ENDPOINT='wss://api.xiaozhi.me/mcp/?token=REDACTED' \
JARVIS_MCP_URL=http://127.0.0.1:5183/mcp \
npm run xiaozhi:mcp
```

Keep the real endpoint token in local shell environment or an ignored `.env` file only. When the bridge is connected, the StackChan World MCP page should show the access point as online. If StackChan replies with its own "cannot control" message and Jarvis access logs show no `/mcp` request, the bridge is not connected to the Xiaozhi access point yet.

## Real Execution Gate

Only after dry-run passes:

```bash
JARVIS_BIND_HOST=127.0.0.1 \
PORT=5183 \
HARNESS_EXECUTION_MODE=real \
JARVIS_MCP_ALLOW_REAL=true \
JARVIS_MCP_ALLOWED_ROOM_IDS=second \
JARVIS_MCP_REQUIRE_TEXT_PATTERN='次卧' \
JARVIS_INGRESS_ALLOWED_DEVICE_IDS=stackchan-second \
JARVIS_INGRESS_ALLOWED_ROOM_IDS=second \
JARVIS_INGRESS_REQUIRE_TEXT_PATTERN='次卧' \
JARVIS_ALLOWED_ACTION_ROOM_IDS=second \
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-second":"second"}' \
npm run dev
```

Then send one explicit open command:

```json
{
  "text": "打开次卧吸顶灯",
  "deviceId": "stackchan-second",
  "roomId": "second",
  "wakeSessionId": "real-open-001",
  "dryRun": false
}
```

Immediately close the same light:

```json
{
  "text": "关闭次卧吸顶灯",
  "deviceId": "stackchan-second",
  "roomId": "second",
  "wakeSessionId": "real-close-001",
  "dryRun": false
}
```

If close fails, do not broaden the command to "关卧室灯", "关所有灯", or "关全屋灯"; stop and manually turn off the light.
