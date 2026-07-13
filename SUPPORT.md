# Support

Jarvis is an early-stage community project. Support is best-effort and provided through repository documentation and GitHub issues.

## Before Asking

1. Read the [README](README.md), [testing policy](docs/TESTING_POLICY.md), [security baseline](docs/SECURITY_BASELINE.md), and relevant runbook under `docs/`.
2. Search open and closed issues.
3. Confirm a supported Node.js version (`^20.19.0 || >=22.12.0`), run `npm ci`, and reproduce with the current default branch.
4. Prefer the simulator or `HARNESS_EXECUTION_MODE=dry_run`. Do not use a real home action merely to collect debugging evidence.

## Where To Ask

- Reproducible incorrect behavior: open a **Bug report**.
- A new capability or design proposal: open a **Feature request**.
- A vulnerability or accidental exposure: follow [SECURITY.md](SECURITY.md), not a public issue.
- A StackChan firmware build or flashing problem: use the dedicated firmware repository. This repository owns the PC-side Jarvis runtime and bridge contracts.

Include the commit, operating system, Node.js version, affected component, execution mode, expected behavior, actual behavior, and a minimal sanitized reproduction. Say whether the result came from the simulator, dry-run, read-only Home Assistant access, or an explicitly authorized real-device test.

## Protect Your Home Data

Do not post tokens, private URLs or IP addresses, Wi-Fi details, device/entity identifiers, camera or microphone data, voice transcripts, floor plans, presence history, audit logs, HA snapshots, or firmware backups. Replace identifying values with small synthetic examples. Rotate any credential that was posted accidentally.

Maintainers may close support requests that cannot be reproduced safely, belong to another project, or require disclosure of private household data.
