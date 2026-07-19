# Threat model

## Scope

SafeChange is a local developer tool for prepared npm-based TypeScript repositories.
It compares plans, creates a protected safety harness, implements one selected plan,
and verifies the resulting Git branch. It is not a deployment or rollback system.

## Assets

- The target repository, Git history, index, and protected safety tests.
- Local Codex authentication and configuration.
- Ignored files and local configuration such as `.env` and `.npmrc`.
- Persisted run artifacts under `.safechange/runs/`.
- The integrity of the published npm package and generated App Server protocol.
- Optional Sentry configuration and sanitized failure-code events.

## Trust boundaries

The model, model output, target repository, package scripts, and generated command
output are treated as untrusted. Git state, schema-validated artifacts, file hashes,
and deterministic command exit codes are the workflow's sources of truth.

The authenticated Codex runtime and the local host remain inside the user's trust
boundary. SafeChange does not protect a compromised host, Codex binary, Git binary,
package manager, or operating-system sandbox.

## Enforced controls

- A valid, clean tracked baseline is required; SafeChange never stashes, resets,
  cleans, amends, or rewrites user history.
- D0 and C0 are separate roots; decision and write roles fork from C0 and exchange
  schema-validated artifacts rather than hidden transcripts.
- Only one writer runs at a time. T1 is committed before production code and every
  protected T1 path is hash-checked through implementation and verification.
- Repository commands use structured argv, `shell: false`, a sanitized environment,
  timeouts, bounded captured output, an allowlist, and a network-disabled Codex
  sandbox. Real exit codes are persisted.
- Protocol generation and runtime Codex versions must match exactly.
- Resume validates artifact hashes, lineage, Git branch, commits, ancestry, protected
  files, and phase boundaries.
- Sentry telemetry is disabled unless both opt-in variables are set. It sends only a
  stable reason code, command, and SafeChange version over HTTPS, with no exception,
  stack, path, task, prompt, artifact, Git, environment, or command-output fields.

## Known limitations

- AI roles and repository scripts need read access to the checkout. SafeChange does
  not provide a deny-read boundary around ignored files. Core prompts do not include
  `.env`, `.env.local`, or `.npmrc` contents, but a malicious repository script could
  read local files and print them into captured command output. Do not run SafeChange
  in a checkout containing credentials that local development tools must not read.
- A Git branch only protects tracked source. Ignored files, databases, services,
  queues, containers, volumes, and external APIs are not rolled back.
- Network denial applies to AI role policies and deterministic command sandboxes; it
  does not make a compromised host or runtime safe. Explicitly enabled Sentry error
  telemetry performs a separate outbound HTTPS request after a CLI failure. Its
  event has no user fields, but the receiving host can observe the source IP.
- The MVP supports a bounded npm/TypeScript command contract. Other ecosystems and
  production workflows have not been security-qualified.
- Availability attacks remain possible through CPU, disk, or process exhaustion by
  hostile repository code. Timeouts and bounded logs reduce but do not eliminate this
  risk.

## Release controls

CI enforces formatting, lint, strict typechecking, coverage thresholds, protocol
reproducibility, vulnerability audit, package installation smoke tests, CodeQL, and
OpenSSF Scorecard. Release artifacts should be published from GitHub Actions through
npm trusted publishing with provenance and immutable GitHub releases.
