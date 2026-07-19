# Prerelease checklist

This checklist is intentionally deferred while the MVP is changing quickly. Do not
enable branch protection or repository rulesets during the current development
phase. Apply the governance section when a release candidate is declared and before
publishing the first public prerelease.

## Release candidate

- [ ] Select the generated Codex protocol baseline and regenerate artifacts if it
  changed.
- [ ] Run `safechange doctor --json` with the standard Codex executable on `PATH`;
  every check must pass without a test-only shim.
- [ ] Repeat the golden demo twice from fresh setup on the generated Codex baseline
  and once on the current standard Codex when it differs.
  Use Spark only through `--model gpt-5.3-codex-spark` for timed test runs; also run
  one untimed rehearsal without a model override.
- [ ] Update `docs/RELEASE_REHEARSAL.md` with sanitized current evidence. Historical
  runs do not qualify after runtime or workflow code changes.
- [ ] Run `npm run ci` and `npm run security:signatures` from a clean clone with
  Node.js 22 and 24.
- [ ] Confirm `npm pack --dry-run` contains no test fixtures, local artifacts,
  credentials, `.idea`, source maps outside the declared package surface, or
  generated protocol files unused at runtime.
- [ ] Verify the `safechange` npm name is still available. It was available on
  2026-07-19, but registry state is not a reservation.
- [ ] Exercise the release workflow without publishing, then inspect the tarball,
  CycloneDX SBOM, checksums, and provenance statement.

## Privacy and security

- [ ] Send one staging Sentry event using explicit telemetry opt-in and inspect the
  received payload. It must contain only version, command, and stable reason code.
- [ ] Confirm Sentry receives no exception, stack, path, task, prompt, artifact, Git,
  environment, command output, or user field; document that the receiver observes
  the source IP.
- [ ] Switch `step-security/harden-runner` from egress `audit` to `block` after
  recording the minimum GitHub and npm endpoints needed by CI and release jobs.
- [ ] Confirm GitHub secret scanning, push protection, Dependabot alerts, dependency
  graph, CodeQL, private vulnerability reporting, and npm trusted publishing are
  enabled in repository or organization settings.
- [ ] Confirm the `npm` GitHub environment has only the required trusted-publishing
  configuration and no long-lived npm token.

## Deferred repository rules

Create a `main` ruleset only at the prerelease boundary:

- [ ] Require pull requests for `main` and require conversation resolution.
- [ ] Require the `Node 22`, `Node 24`, `Supply chain`, `Package smoke (macOS)`,
  `Package smoke (Windows)`, `JavaScript and TypeScript`, and `Dependency review`
  checks without allowing skipped required checks.
- [ ] Require branches to be current before merge, linear history, and block force
  pushes and branch deletion.
- [ ] Restrict bypass to the minimum maintainer/release identity and audit every use.
- [ ] Require one approval only after a second active maintainer exists; do not add a
  ceremonial approval requirement that a solo maintainer cannot satisfy honestly.
- [ ] Add a tag ruleset for `v*` that blocks tag updates and deletion.

After the first release, enable immutable GitHub releases, verify installation with
`npx safechange@<version> doctor`, and keep branch/tag rules enabled for subsequent
development.
