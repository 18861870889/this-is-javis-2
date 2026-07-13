## Summary

<!-- What problem does this solve, and why is this the smallest useful change? -->

## Behavior And Safety Impact

<!-- Describe user-visible behavior and affected boundaries: Jarvis Brain, HCM/policy, HA, StackChan/Xiaozhi, network exposure, PC tools, or protected devices. Write "None" when applicable. -->

- [ ] This change cannot reach a real device or private household data.
- [ ] This change affects a device/data boundary; I described the authorization, policy, audit, and rollback behavior above.
- [ ] Any real-device-affecting path was verified in simulator/dry-run before an explicitly authorized narrow physical test.
- [ ] Camera, microphone, lock, alarm, gas, water-valve, and other protected capabilities remain blocked.
- [ ] StackChan firmware is unchanged, or firmware work is tracked in its dedicated repository with its own gates.

## Validation

<!-- List exact commands and results. Mark items N/A only with a short explanation. -->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:adapter`
- [ ] `npm run build`
- [ ] Added or updated regression coverage for behavior changes.
- [ ] Validation used fixtures, simulator, dry-run, or read-only provider access by default.

Validation notes:

## Privacy And Documentation

- [ ] I did not include secrets, private URLs/IPs, identifying HA/device data, camera/microphone content, voice transcripts, floor plans, snapshots, audit logs, or firmware backups.
- [ ] New examples and fixtures use synthetic, redacted values.
- [ ] Documentation and `CHANGELOG.md` are updated, or no update is needed.
- [ ] I have read `CONTRIBUTING.md`, `SECURITY.md`, and the Code of Conduct.
