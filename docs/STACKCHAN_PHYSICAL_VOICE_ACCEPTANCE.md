# StackChan Physical Voice Acceptance

This checklist is for the moment when someone is physically next to StackChan. It watches local logs while the user speaks and reports where the chain passed or stopped.

It does not modify firmware and does not modify Xiaozhi Server code.

## What It Observes

The watcher reads:

- Xiaozhi runtime log: `data/jarvis-stack.local/xiaozhi.log`
- Jarvis command audit: `data/command-audit.local.jsonl`
- Jarvis PC workspace: `data/pc-workspace.local`
- Optional serial log if you pass `--serial-log`

It classifies the physical chain into these stages:

- device connected to local Xiaozhi
- listen start
- audio frames entering Xiaozhi
- VAD voice started
- ASR started
- recognized text
- LLM received user message
- TTS sent back to StackChan
- Jarvis/HCM result
- HA state/control result
- PC markdown result

Note: Xiaozhi currently does not emit a dedicated per-utterance `ASR started` log line. The watcher marks ASR started as inferred when VAD stops with buffered audio, or as direct evidence when an ASR result line appears.

## Before Physical Testing

Start the local stack. For engineering smoke, use `real-second`; for user handoff testing, use `real-home`.

```bash
cd "/Users/jerf/Documents/this is javis 2"
npm run jarvis:stack:status
```

If it is not running and you are doing engineering small-scope smoke:

```bash
npm run jarvis:stack:real-second
```

If it is not running and you are ready for full-home low-risk user acceptance:

```bash
npm run jarvis:stack:check:real-home
npm run jarvis:stack:real-home
```

Check the local non-physical path first:

```bash
npm run jarvis:stack:e2e
npm run xiaozhi:ws-smoke
```

Parser self-check with historical logs:

```bash
npm run stackchan:voice:watch -- --replay --scenario=full
```

Replay proves the watcher can parse known log shapes. It is not physical acceptance.

Add `--require-trigger` when you want the watcher to fail unless it sees wake-word or head-touch evidence. Manual head-touch can be inferred from Xiaozhi `listen start, mode=manual`; wake-word proof needs StackChan serial output through `--serial-log`.

## One-Command Physical Session

Use this first when someone is next to StackChan. It creates a timestamped session directory, records precheck output, tries to capture StackChan serial logs, starts the watcher, and writes all evidence under `data/stackchan-physical-sessions/`.

```bash
npm run stackchan:voice:session -- --scenario=home-state
```

At StackChan:

```text
按住头
次卧吸顶灯开着吗
松开头提交
```

For Hermes/Jarvis Agent non-home tasks:

```bash
npm run stackchan:voice:session -- --scenario=agent
```

At StackChan:

```text
按住头
帮我总结今天要做什么
松开头提交
```

For PC markdown:

```bash
npm run stackchan:voice:session -- --scenario=pc
```

The session command prints the exact `.md` filename to say, so use the filename it gives you.

For real HA control, first intentionally start `real-second`, then run:

```bash
npm run stackchan:voice:session -- --scenario=ha-control --require-real-ha
```

If serial capture fails because the USB port is busy or unavailable, the session still watches Xiaozhi/Jarvis logs. Add `--no-serial` to skip serial capture on purpose.

## Test 1: Voice To HA State Query

Terminal:

```bash
npm run stackchan:voice:watch -- --scenario=home-state --expect-text=次卧吸顶灯
```

At StackChan, use the deterministic manual path first:

```text
按住头
次卧吸顶灯开着吗
松开头提交
```

Then verify the wake-word path separately:

```text
小黑
次卧吸顶灯开着吗
```

For trigger-proof mode:

```bash
npm run stackchan:voice:watch -- --scenario=home-state --expect-text=次卧吸顶灯 --require-trigger
```

For `小黑` proof specifically, include serial evidence:

```bash
npm run stackchan:voice:watch -- --scenario=home-state --expect-text=次卧吸顶灯 --require-trigger --serial-log=/tmp/stackchan-serial.log
```

Pass means StackChan audio reached Xiaozhi, Xiaozhi recognized the text, Jarvis/HCM answered through HA state query, and Xiaozhi sent TTS back.

## Test 2: Voice To Real HA Control

Only run this when real control is intentionally enabled and the target is safe.

Terminal:

```bash
npm run stackchan:voice:watch -- --scenario=ha-control --expect-text=打开次卧吸顶灯 --require-real-ha
```

At StackChan, use the deterministic manual path first:

```text
按住头
打开次卧吸顶灯
松开头提交
```

Then verify the wake-word path separately:

```text
小黑
打开次卧吸顶灯
```

Pass means the audit shows real HA execution, not dry-run. After the test, restore the light with the narrow inverse command:

```text
小黑
关闭次卧吸顶灯
```

Then verify:

```text
按住头
次卧吸顶灯开着吗
松开头提交

小黑
次卧吸顶灯开着吗
```

## Test 3: Voice To PC Markdown

Use a fresh `.md` filename for each run. Jarvis intentionally refuses to overwrite an existing file unless a later workflow explicitly asks for overwrite.

Terminal:

```bash
npm run stackchan:voice:watch -- --scenario=pc --expect-text=电脑工作区 --pc-file=stackchan-voice-final.md --expect-pc-content=helloworld
```

At StackChan, use the deterministic manual path first:

```text
按住头
在电脑工作区新建 stackchan-voice-final.md 并写入 helloworld
松开头提交
```

Then verify the wake-word path separately if needed:

```text
小黑
在电脑工作区新建 stackchan-voice-final.md 并写入 helloworld
```

Pass means the voice request reached Jarvis and created the markdown file inside the restricted PC workspace.

## Full Session

To observe the whole first-stage acceptance in one run:

```bash
npm run stackchan:voice:watch -- --scenario=full --timeout-ms=300000 --pc-file=stackchan-voice-final.md --expect-pc-content=helloworld
```

Suggested spoken order for the deterministic manual path:

```text
按住头
次卧吸顶灯开着吗
松开头提交

按住头
在电脑工作区新建 stackchan-voice-final.md 并写入 helloworld
松开头提交

按住头
打开次卧吸顶灯
松开头提交
```

To verify `小黑`, rerun a state-query watcher or use a fresh PC filename before repeating the PC markdown test:

```text
小黑
次卧吸顶灯开着吗
```

For the full session, add `--require-real-ha` only when you want the watcher to fail dry-run HA control.

## Optional Serial Evidence

If a serial monitor is already writing to a local file, pass it to the watcher:

```bash
npm run stackchan:voice:watch -- --scenario=home-state --serial-log=/tmp/stackchan-serial.log
```

The watcher can then also mark wake-word or touch-trigger evidence from serial lines such as `xiao hei`, `小黑`, `head touch starts xiaozhi manual listening`, or `head touch stops xiaozhi manual listening`.

To make serial trigger evidence mandatory:

```bash
npm run stackchan:voice:watch -- --scenario=home-state --expect-text=次卧吸顶灯 --require-trigger --serial-log=/tmp/stackchan-serial.log
```

## Troubleshooting By Pending Stage

`设备连接` pending:
StackChan did not reach local Xiaozhi. Check Wi-Fi, OTA endpoint, Xiaozhi port `8000`, auth MAC allowlist, and whether the device is still pointing at cloud Xiaozhi instead of local Xiaozhi.

`listen start` pending:
Wake word/touch did not put the device into listening mode, or the watcher started too late with `--fresh`. Try the avatar/head touch fallback and then retest `小黑`.

`音频帧进入` pending:
The device connected but did not stream microphone audio. Check mic path, firmware audio settings, and whether Xiaozhi immediately disconnected.

`VAD voice started` pending:
Audio arrived but VAD did not consider it speech. Speak closer/louder, reduce room noise, or tune Xiaozhi VAD threshold later.

`ASR started` pending:
VAD did not stop with buffered speech or the ASR queue did not run. Check FunASR model load and Xiaozhi ASR errors.

`识别文本` pending:
ASR may be failing or recognizing only silence/timeout prompts. Check for `语音识别耗时` and `大模型收到用户消息` in Xiaozhi logs.

`大模型收到用户消息` pending:
ASR text did not enter Xiaozhi's LLM provider. Check Xiaozhi intent/LLM routing and JarvisLLM config.

`Jarvis/HCM 结果` pending:
Jarvis did not write a command audit for the recognized text. Check whether the text is outside the current ingress pattern, whether it went to the generic fallback, or whether Jarvis is not reachable at `127.0.0.1:5183`.

`HA 状态/控制结果` pending:
HCM ran but did not produce a home result. Check room guard, safety policy, HA credentials, entity mapping, and real/dry-run mode.

`PC 文件操作结果` pending:
The utterance did not parse as a markdown creation request or the file was rejected by the restricted PC workspace guard. Use a simple `.md` filename and include `写入 helloworld`.

`TTS 已发送` pending:
Jarvis may have answered but Xiaozhi did not synthesize or send audio. Check EdgeTTS/provider errors and Xiaozhi send-audio logs.
