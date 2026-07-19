# Changelog

All notable changes to SafeChange are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Versioned run state and artifact envelopes with closed phase/status contracts and
  named predecessor hashes.
- Versioned text/JSON outcomes, read-only `status`, explicit `--model`, total
  workflow `--timeout`, phase progress, and resumable pre-write interruption handling.
- Packed CLI functional coverage plus macOS and Windows package/process smoke jobs.

### Changed

- Treat the generated Codex protocol version as a reproducible development baseline
  and validate runtime compatibility through the App Server contract.
- Allow bounded targeted npm test scripts and common verification script variants.
- Resolve npm, Codex, and package binaries portably without shell interpolation.

## [0.1.0] - 2026-07-18

### Added

- Complete `plan`, `run`, boundary-validated `resume`, and local `doctor` CLI workflows.
- Separate D0 and C0 roots with independent C0 planner, Judge, Test Author,
  Implementer, and Verifier forks.
- Schema-validated artifacts, deterministic eligibility gates, atomic persistence,
  lineage and hash verification, and concise Markdown reports.
- Protected failing-first T1, scoped I1, one bounded repair, and independent release
  verification on a SafeChange branch.
- Structured network-disabled command runner with sanitized environment, timeouts,
  bounded output, and real exit evidence.
- Payment-retry golden demo and installable `safechange-demo` binary.
- Node 22/24 CI, Biome, coverage thresholds, protocol drift checks, npm audit,
  registry signature verification, package smoke tests, CodeQL, dependency review,
  Dependabot, and OpenSSF Scorecard.
- Property-based command allowlist fuzzing with generated shell-operator positions.
- Opt-in, allowlisted Sentry failure-code telemetry with no automatic instrumentation.
- TypeBox single-source artifact contracts plus Knip and publint CI gates.

### Security

- Documented the local checkout, secret-file, ignored-state, external-state, and
  resource-exhaustion boundaries.
- Replaced duplicated Ajv schemas and TypeScript interfaces with pinned TypeBox
  contracts, reducing runtime dependencies and schema maintenance.

[0.1.0]: https://github.com/vv-bogdanov/safechange/releases/tag/v0.1.0
