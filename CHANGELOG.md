# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use [Semantic Versioning](https://semver.org/spec/v2.0.0.html) when it begins publishing releases.

## [Unreleased]

### Added

- Project-specific contribution, support, security, and conduct policies.
- Structured bug and feature issue forms plus a pull request checklist.
- GitHub Actions CI, CodeQL scanning, Dependabot updates, and CODEOWNERS.
- Portable Node version, editor, and line-ending configuration.
- Reproducible OCI image, Apple Container/Docker deployment commands, hardened Compose defaults, and a production container smoke test.
- Container deployment runbook and documented environment-variable examples.

### Changed

- Reworked the README around architecture, current scope, safety, setup, and verification.
- Replaced maintainer-specific paths, LAN addresses, device identifiers, and firmware hashes with auto-detection or local environment settings.
- Updated Vite to 8.1.4 and moved build tooling to development dependencies.
- Serve the built frontend directly in production while keeping Vite middleware limited to development.
- Default container networking to localhost, Home Assistant execution to `dry_run`, and Hermes integration to API transport.

### Fixed

- Isolated integration tests from local Hermes/subagent environment variables.

### Security

- Removed machine- and device-specific defaults from the public runtime and firmware tooling.
- Enabled private vulnerability reporting, secret scanning push protection, and Dependabot security updates on GitHub.
- Replaced user-controlled and backtracking-prone regular expressions with literal or bounded string matching.
- Parse provider URLs before matching trusted DeepSeek hostnames and use SHA-256 for semantic cache identifiers.
- Run the production container as a non-root user with a read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, and a dedicated writable data volume.

## [0.1.0] - 2026-07-11

### Added

- Initial PC-side Jarvis Brain, HCM safety/runtime, Home Assistant adapter, and StackChan/Xiaozhi bridge foundation.
- Simulator, dry-run execution gates, policy checks, audit paths, automated tests, and Vite interface.

[Unreleased]: https://github.com/18861870889/this-is-javis-2/compare/09002d3...HEAD
[0.1.0]: https://github.com/18861870889/this-is-javis-2/tree/09002d3
