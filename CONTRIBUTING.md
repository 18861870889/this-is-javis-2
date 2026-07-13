# Contributing to Jarvis

Thanks for helping improve Jarvis. This repository contains the PC-side Jarvis Brain, HCM safety runtime, Home Assistant adapter, and StackChan/Xiaozhi bridges. StackChan firmware is maintained in a separate repository.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before You Start

- Search existing issues before opening a new one.
- Use the bug or feature template. Use [SECURITY.md](SECURITY.md) for vulnerabilities and [SUPPORT.md](SUPPORT.md) for setup questions.
- Keep changes focused. Do not mix refactors with behavior changes unless they are inseparable.
- For behavior changes, add or update a regression test.

## Local Setup

This project requires Node.js `^20.19.0 || >=22.12.0`. Use a current Node.js LTS release that satisfies that range.

```bash
git clone https://github.com/18861870889/this-is-javis-2.git
cd this-is-javis-2
nvm use
npm ci
cp .env.example .env
```

`nvm use` is optional if Node.js `20.19.0` or another supported version is already active.

Keep `.env` local. The application runs without real Home Assistant credentials when using the simulator and dry-run paths.

Start the integrated development server:

```bash
npm run dev
```

## Tests

Before submitting a pull request, run:

```bash
npm run check
npm test
npm run test:adapter
npm run build
```

During development, a focused Vitest run is also useful:

```bash
npm test -- src/path/to/file.test.js
```

Changes to HCM, command execution, policy, provider adapters, voice ingress, or delivery routing should include the full test suite. Automated tests must use fixtures, the simulator, read-only provider discovery, or dry-run execution. They must not call real Home Assistant services.

## Home And Device Safety

Jarvis controls physical environments, so a passing unit test is not sufficient authorization for a real action.

- Keep `HARNESS_EXECUTION_MODE=dry_run` while developing and reviewing.
- Prove any change that could affect Home Assistant or StackChan behavior in simulator/dry-run first. Review the resolved room, HCM thing/capability, HA entity/service, risk level, and rollback action before an explicitly authorized real-device test.
- Keep real tests narrow: one known low-risk device, one room, and one reversible action. Never broaden a failed recovery command.
- Do not enable camera, microphone, lock, alarm, gas, water-valve, or other safety/privacy-sensitive execution. These capabilities must remain blocked pending a separate authorization design.
- Do not expose Jarvis, Xiaozhi, MCP, OTA, Home Assistant, STT/TTS, or debug ports to the public internet. Binding to `0.0.0.0` requires a trusted network plus firewall, VPN, or authenticated tunnel controls.
- Do not flash or modify physical StackChan firmware as part of this repository's normal test flow. Firmware changes belong in the dedicated firmware repository and require its backup, build, device-identity, rollback, and explicit release gates.

See [the security baseline](docs/SECURITY_BASELINE.md) and [testing policy](docs/TESTING_POLICY.md) before any integration or physical-device work.

## Secrets And Private Home Data

Never commit or paste into an issue or pull request:

- `.env` files or HA, LLM, TTS/STT, bridge, tunnel, or Cloudflare credentials;
- private HA URLs, public IP addresses, Wi-Fi credentials, or device secrets;
- camera images, microphone recordings, voice transcripts, floor plans, presence data, or household routines;
- unredacted HA snapshots, entity/device registries, audit logs, or firmware backups.

Use obvious placeholders in tests and examples. Redact `authorization`, `token`, `password`, `api_key`, private URLs, personal names, and identifying device/entity values before sharing logs. If a real credential is exposed, rotate it immediately and follow [SECURITY.md](SECURITY.md).

## Pull Requests

In the pull request:

1. Explain the problem and the smallest change that solves it.
2. Describe user-visible and safety-relevant behavior.
3. List the exact test commands and results.
4. State whether validation was simulator, dry-run, read-only HA, or explicitly authorized real-device testing.
5. Update documentation and `CHANGELOG.md` when behavior or contributor expectations change.

Maintainers may ask for a smaller patch, additional safety evidence, or a regression test before merging.
