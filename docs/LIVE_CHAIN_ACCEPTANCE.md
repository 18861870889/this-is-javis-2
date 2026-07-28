# Live Chain Acceptance

This checklist verifies the deployed chain without treating generated text as proof of execution.

```text
StackChan -> Xiaozhi ASR -> Jarvis container
  -> non-home: Hermes tools -> PC result
  -> home: Hermes HomeIntent -> HCM -> Home Assistant -> state readback
  -> Xiaozhi TTS -> StackChan speaker
```

## Automated Gates

```bash
npm run test:ci
npm run container:smoke
npm run xiaozhi:host:start
npm run container:live-check
XIAOZHI_WS_SMOKE_DEVICE_ID='<allowed-device-id>' npm run xiaozhi:ws-smoke -- pc
```

Pass criteria:

- Container is non-root, read-only, capability-dropped, and published only on localhost.
- Runtime readiness reports both Hermes and Home Assistant reachable.
- Hermes protected endpoints reject requests without the bearer key.
- The Xiaozhi check receives STT text, TTS `start/stop`, nonzero audio bytes, and creates the requested host file with the expected body.
- Delivery audit records synchronous results as `dispatched`. Background results
  must reach `accepted`, then `dispatched`, then `delivered_inferred`; it must
  never turn `offline` or `busy` into success.
- `container inspect` contains no inline HA, Hermes, or Xiaozhi delivery key.

## Real Home Gate

Run only after the automated suite and at least 20 reviewed dry-run commands pass.

1. Confirm `npm run container:live-check` is green.
2. Start with `JARVIS_CONTAINER_EXECUTION_MODE=real npm run container:start`.
3. Read the target state before control: `次卧吸顶灯开着吗`.
4. Issue one low-risk command: `打开次卧吸顶灯`.
5. Require an HCM audit with a single intended action, allowed safety/policy decisions, provider execution, and post-action verification.
6. Read the state again and physically observe the light.
7. Roll back with `关闭次卧吸顶灯`.

A spoken “已经打开” is not sufficient. If Home Assistant is unreachable, service execution fails, state readback disagrees, or the physical light does not change, the test fails.

Locks, alarms, gas devices, water valves, cameras, microphones, and other safety/privacy-sensitive capabilities are outside this low-risk acceptance.

## Physical StackChan Gate

After the service-chain test passes, use the real microphone and speaker:

1. Say the configured wake word.
2. Ask: `次卧吸顶灯开着吗`.
3. Ask: `在电脑工作区新建 stackchan-voice-final.md 并写入 helloworld`.
4. In real mode, ask: `打开次卧吸顶灯`.
5. Confirm natural progress/failure wording, final TTS playback, the PC artifact, HCM audit, HA state readback, and physical device state.

6. Start one background task, wait without asking a follow-up, and require
   StackChan to proactively speak its short completion/failure summary. Confirm
   the delivery audit ends at `delivered_inferred`.

The WebSocket smoke injects text after authentication, so it covers Xiaozhi/Jarvis/Hermes/TTS but not the physical wake word, microphone, or ASR acoustics.
