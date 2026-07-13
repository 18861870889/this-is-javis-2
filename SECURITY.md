# Security Policy

Jarvis bridges natural-language input, local agent tools, StackChan/Xiaozhi, and Home Assistant. A vulnerability can therefore expose private household data or cause a physical action. Please report security problems privately and test conservatively.

## Supported Versions

This project is in early development and has no maintained release branches. Security fixes target the latest commit on the default branch. Older commits and local forks are not supported.

## Reporting A Vulnerability

Do not open a public issue with vulnerability details.

Use GitHub's **Report a vulnerability** button on this repository's Security page when private vulnerability reporting is available. Otherwise, contact [@18861870889](https://github.com/18861870889) through an existing private channel. If no private channel is available, a public issue may contain only a request for private security contact, with no technical, household, or credential details; wait for a private channel before sending the report.

In the private report, include the affected commit, component, impact, and a minimal sanitized reproduction. State which boundary was crossed, such as dry-run reaching real execution, an unauthenticated bridge route, a blocked device capability becoming executable, cross-room targeting, unrestricted PC file access, or secret disclosure.

Never send active credentials. Redact or omit:

- HA, Xiaozhi, OpenAI-compatible, TTS/STT, Cloudflare, tunnel, or bridge tokens;
- HA base URLs, public IPs, Wi-Fi details, MAC addresses, device/entity names, and household identities;
- camera images or streams, microphone audio, voice transcripts, floor plans, presence history, and private automations;
- unredacted snapshots, registries, command/delivery audits, and firmware backups.

If a credential may have been exposed, rotate it immediately instead of waiting for triage. Maintainers will coordinate validation and disclosure privately; please do not probe systems or devices you do not own or control.

## Security Boundaries

The expected baseline is:

- Jarvis binds to `127.0.0.1` by default. Jarvis, Xiaozhi, MCP, OTA, HA, STT/TTS, HMR, and debug ports must never be exposed directly to the public internet.
- Development and automated validation use fixtures, read-only discovery, the simulator, or `HARNESS_EXECUTION_MODE=dry_run`.
- Home control enters through Jarvis Brain and HCM grounding, policy, simulation, decision review, runtime authorization, and audit. Direct HA action routes are not an acceptable bypass.
- MCP real execution requires `HARNESS_EXECUTION_MODE=real`, `JARVIS_MCP_ALLOW_REAL=true`, and a request with `dryRun=false`, plus trusted device/room/network controls.
- Camera, microphone, lock, alarm, gas, water-valve, and similar privacy or safety-critical actions remain blocked pending a stronger authorization design.
- PC automation remains explicitly allowlisted and confined to `JARVIS_PC_WORKSPACE_ROOT`.
- StackChan firmware changes belong in the separate firmware repository and require backup, build, device identity, rollback, and explicit release gates before flashing.

More deployment detail is in [`docs/SECURITY_BASELINE.md`](docs/SECURITY_BASELINE.md).

## If Something Leaks Or Executes Unexpectedly

1. Stop Jarvis and all bridge services.
2. Revoke and rotate affected HA, LLM, TTS/STT, Cloudflare, tunnel, and bridge credentials.
3. Review Jarvis audits and the Home Assistant logbook/history for unexpected actions without publishing them.
4. Restore `HARNESS_EXECUTION_MODE=dry_run` and disable real-execution flags.
5. Re-run the deployment checks in the security baseline before reconnecting any physical device.
