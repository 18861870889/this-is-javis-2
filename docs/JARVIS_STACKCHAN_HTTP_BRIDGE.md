# Jarvis StackChan HTTP Bridge Contract

StackChan is treated as a black-box voice/display device. Do not modify StackChan firmware or device-side source code for M1.

The first integration path is an HTTP bridge that runs on the PC, Home Assistant, or another local adapter. The bridge converts recognized speech text into Jarvis `/v1/utterance` calls and plays back `replyText` only when `speak` is true.

## Endpoint

```http
POST http://<jarvis-pc-host>:5173/v1/utterance
Content-Type: application/json
```

Minimum payload:

```json
{
  "deviceId": "stackchan-study",
  "roomId": "study",
  "wakeSessionId": "wake-20260701-0001",
  "trigger": "wake_word",
  "text": "打开书房射灯",
  "dryRun": true
}
```

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `text` | Yes | Final recognized utterance. Do not send interim STT text. |
| `deviceId` | Recommended | Stable StackChan or bridge identifier. |
| `roomId` | Recommended | Source room context. PC-side `JARVIS_STACKCHAN_DEVICE_ROOMS` can override it for trusted device placement. |
| `wakeSessionId` | Recommended | Same session id for devices that heard the same wake event; used for dedupe. |
| `trigger` | Optional | `wake_word`, `button`, `ha_assist`, or adapter-specific string. |
| `dryRun` | Optional | Keep `true` during arrival tests and first HA validation. |

Room priority:

- Explicit target room in `text` wins. Example: if the second-bedroom StackChan hears "关主卧灯", Jarvis targets the master bedroom.
- If `text` has no explicit room, Jarvis may use the trusted source room. Example: a registered second-bedroom StackChan hearing "关灯" targets the second bedroom.
- Generic bedroom wording outside a bedroom remains ambiguous. Example: a living-room StackChan hearing "卧室灯关一下" should ask which bedroom.

Optional trusted device-room registry:

```bash
JARVIS_STACKCHAN_DEVICE_ROOMS='{"stackchan-study":"study","stackchan-second":"second"}'
```

When present, this PC-side registry is the trusted source for StackChan placement. Payload `roomId` is still useful for simulation and adapters, but the registry wins on conflicts.

Expected response shape:

```json
{
  "route": "hcm_fast_path",
  "status": "dry_run",
  "speak": true,
  "replyText": "书房射灯已准备打开。",
  "duplicate": false,
  "learnedSuggestion": {
    "pendingPromptId": "pending_..."
  }
}
```

Bridge behavior:

- If `speak` is `true`, play `replyText` through StackChan TTS.
- If `route` is `duplicate_ignored` or `speak` is `false`, stay silent.
- If `learnedSuggestion.prompt` exists, speak it after the main response or display it as a follow-up.
- If the user then says "可以", "别这样", or "撤销", send that text as a new `/v1/utterance` request. The PC-side pending prompt queue binds it to the previous suggestion.

Control scope:

- Strong safety devices such as locks, gas devices, water valves, and alarm panels must stay blocked or require stronger future authorization.
- Non-safety devices such as lights, fans, covers, climate, and media devices may be included, but every action still goes through HCM grounding, policy, simulation, decision review, and audit.

## Arrival Smoke Test

1. Start Jarvis in dry-run mode:

```bash
HARNESS_EXECUTION_MODE=dry_run npm run dev
```

2. Simulate one StackChan:

```bash
curl -s http://127.0.0.1:5173/v1/utterance \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"stackchan-study","roomId":"study","wakeSessionId":"arrival-1","trigger":"wake_word","text":"打开书房射灯","dryRun":true}' | jq
```

Pass criteria:

- `route` is `hcm_fast_path`.
- `status` is `dry_run`, `answered`, `needs_clarification`, or another safe non-error state.
- HCM audit is written.
- No real device is controlled.

3. Simulate a read-only state question:

```bash
curl -s http://127.0.0.1:5173/v1/utterance \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"stackchan-study","roomId":"study","wakeSessionId":"arrival-2","trigger":"wake_word","text":"书房射灯开着吗"}' | jq
```

Pass criteria:

- With HA configured, `route` is `hcm_fast_path` and `routeReason` is `read_only_home_state_query`.
- No HA service call is made.

4. Simulate two devices hearing the same utterance:

```bash
curl -s http://127.0.0.1:5173/v1/utterance \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"stackchan-study","roomId":"study","wakeSessionId":"arrival-shared","text":"打开书房射灯","dryRun":true}' | jq

curl -s http://127.0.0.1:5173/v1/utterance \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"stackchan-living","roomId":"living","wakeSessionId":"arrival-shared","text":"打开书房射灯","dryRun":true}' | jq
```

Pass criteria:

- First response is handled normally.
- Second response has `route: "duplicate_ignored"` and `speak: false`.
- Only one command audit entry is created for the shared utterance.

5. Simulate feedback:

```bash
curl -s http://127.0.0.1:5173/v1/utterance \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"stackchan-study","roomId":"study","wakeSessionId":"arrival-feedback","text":"可以"}' | jq
```

Pass criteria:

- If Jarvis recently asked a learning or automation question, the feedback binds to `pendingPromptId`.
- Otherwise it falls back to the latest compatible command audit.

## Release Gate

- Keep `HARNESS_EXECUTION_MODE=dry_run` until at least 20 representative utterances are audited.
- Enable real execution gradually from low-risk allowlisted rooms/devices, not by bypassing HCM policy.
- Keep locks, gas, water valves, alarms, and camera-related actions blocked or confirmation-only.
- Do not install HA automations from accepted suggestions in M1; accepted means guidance only.
