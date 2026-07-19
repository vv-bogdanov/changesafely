# Release rehearsal

> Development rehearsal evidence only. This is not a final or publishable benchmark
> measurement. The payment repeats below are historical; the Python smoke records the current
> packed CLI and workflow.

## Current Python packed-CLI Spark smoke

- Date: 2026-07-19 UTC
- ChangeSafely source: `9df7acdbbbe5424743967d9171cd7cf87645a47b`
- Package invocation: offline `npx` from `changesafely-0.1.0.tgz`
- Codex CLI: `codex-cli 0.144.6`
- Live-test model: `gpt-5.3-codex-spark`, medium effort
- Python: 3.14.4; pytest: 9.0.2
- Task: add private `_double(number)` behavior while preserving `value()`

Run `2026-07-19T23-39-25-733Z-c93891a3` completed `VERIFIED` in 71.94 seconds.
It recorded separate boundaries:

- B0 `da29195ff1d8f799b67bc05ba5b02957715359a0`;
- T1 `de75288e4dfa1a23fc4c6fcf26e4612760599b90`, adding only
  `tests/test_private_double.py`;
- I1 `f7b6e9cb6c6462ac89f3fbea8052990f87004334`, changing only `src/value.py`.

The protected harness ran `python -m pytest` at T1 and recorded exit 2 before production
code changed. Deterministic verification recorded the same argv and cwd with exit 0 and no
timeout at I1. A separate post-run invocation passed both tests. The persisted status and
manifest revalidated successfully through the packed CLI, and the disposable repository was
clean afterward.

An earlier task formulation, run `2026-07-19T23-38-10-752Z-8efd47b4`, explicitly requested a
public return-contract change. It stopped at `HUMAN_DECISION_REQUIRED` before branch creation or
writes. It is retained as a safe-stop rehearsal and is not counted as the successful Python
smoke.

## Historical payment rehearsal

Date: 2026-07-18  
Codex CLI: `codex-cli 0.144.5`  
Live-test model: `gpt-5.3-codex-spark`, medium effort  
Task: payment retry after one transient timeout with a stable idempotency key

### Repeats

| Run | Plans | Result | Wall time |
| --- | ---: | --- | ---: |
| `2026-07-18T15-30-41-688Z-02e1bd4d` | 3 | `VERIFIED` | 118.90 s |
| `2026-07-18T15-32-53-365Z-b242d01e` | 3 | `VERIFIED` | 122.30 s |

Both runs started from a fresh demo setup and produced exactly B0, T1, and I1.
T1 changed only `test/payment.test.ts`; I1 changed only `src/payment.ts`. The
baseline test command returned exit 1 from the network-disabled sandbox. Final
test, typecheck, and build commands returned exit 0 from the same sandbox. T1
hashes remained unchanged and the independent Verifier accepted both runs.

### Performance profile

The standard user-selected model remains the product default. With low reasoning
effort it completed a correct live run in 274.45 seconds in this environment,
outside the three-minute demo target. The opt-in Spark profile is therefore used
for timed CLI rehearsals; it is not a hidden production default and is persisted
in `state.json` when enabled.

Earlier safe stops exposed invalid safety commands, rewritten existing tests,
and over-classified approval questions. Each became a deterministic gate or one
bounded same-role artifact correction before the final repeats. Those stopped
runs were not counted as successful rehearsals.
