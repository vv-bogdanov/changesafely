# Security policy

## Supported versions

Security fixes are applied to the latest published release and `main`. Pre-release
versions may receive breaking security changes without a compatibility shim.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/vv-bogdanov/safechange/security/advisories/new).
Do not open a public issue for a suspected vulnerability and do not include real
credentials, private source code, or secret-file contents in a report.

Include the SafeChange and Codex versions, operating system, a minimal sanitized
reproduction, the affected trust boundary, and the impact. You should receive an
initial acknowledgement within seven days. Disclosure timing will be coordinated
after the issue is reproduced and a fix is available.

## Security boundary

SafeChange executes AI roles and repository scripts locally. Read
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before using it on sensitive code.
SafeChange is not a deployment tool and does not claim to roll back external state.

Optional Sentry error telemetry is disabled by default and requires both
`SAFECHANGE_TELEMETRY=1` and `SAFECHANGE_SENTRY_DSN`. It sends only allowlisted
failure metadata described in the threat model. Never place a private credential in
the DSN variable.
