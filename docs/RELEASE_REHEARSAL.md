# Release rehearsal

> Historical evidence only: these runs predate the current runtime and workflow
> changes, so the prerelease checklist requires fresh rehearsals before `0.1.0` is
> published.

Date: 2026-07-18  
Codex CLI: `codex-cli 0.144.5`  
Live-test model: `gpt-5.3-codex-spark`, medium effort  
Task: payment retry after one transient timeout with a stable idempotency key

## Final repeats

| Run | Plans | Result | Wall time |
| --- | ---: | --- | ---: |
| `2026-07-18T15-30-41-688Z-02e1bd4d` | 3 | `VERIFIED` | 118.90 s |
| `2026-07-18T15-32-53-365Z-b242d01e` | 3 | `VERIFIED` | 122.30 s |

Both runs started from a fresh demo setup and produced exactly B0, T1, and I1.
T1 changed only `test/payment.test.ts`; I1 changed only `src/payment.ts`. The
baseline test command returned exit 1 from the network-disabled sandbox. Final
test, typecheck, and build commands returned exit 0 from the same sandbox. T1
hashes remained unchanged and the independent Verifier accepted both runs.

## Performance profile

The standard user-selected model remains the product default. With low reasoning
effort it completed a correct live run in 274.45 seconds in this environment,
outside the three-minute demo target. The opt-in Spark profile is therefore used
for timed CLI rehearsals; it is not a hidden production default and is persisted
in `state.json` when enabled.

Earlier safe stops exposed invalid safety commands, rewritten existing tests,
and over-classified approval questions. Each became a deterministic gate or one
bounded same-role artifact correction before the final repeats. Those stopped
runs were not counted as successful rehearsals.
