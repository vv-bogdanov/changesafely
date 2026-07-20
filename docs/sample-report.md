# ChangeSafely assurance report

## Task

Retry a payment once after a transient timeout without allowing a duplicate charge

## Result

- Run id: `<run-id>`
- Status: `VERIFIED` / `verified`
- Branch: `changesafely/<run-id>`
- Selected plan: `plan-2`
- Final verifier: **ACCEPT** - The scoped implementation passed the declared assurance case.
- Assurance decision: accepted after the final deterministic release gate

`VERIFIED` means that the declared, evidence-linked assurance case passed its release gates. It is
not a claim of absolute safety beyond the recorded scope, environment, and rollback boundary.

Evidence: [decision.json](decision.json), [verification.json](verification.json).

## Git boundaries

- Baseline B0: `<baseline-commit>`
- Characterization C1: `<characterization-commit>`
- Change harness T1: `<test-commit>`
- Implementation I1: `<implementation-commit>`
- Repair R1: not used

Evidence: [characterization.json](characterization.json), [harness.json](harness.json),
[implementation.json](implementation.json).

## Traceability

| Kind | ID | Declared behavior or risk | Executable checks |
| --- | --- | --- | --- |
| acceptance | `AC1` | Retry one transient failure | `CHK-T1` |
| invariant | `INV1` | Never charge an operation twice | `CHK-C1`, `CHK-T2` |
| critical-risk | `R1` | Concurrent retries may duplicate a charge | `CHK-T2` |

Evidence: [contract.json](contract.json), [plans/plan-2.json](plans/plan-2.json),
[harness.json](harness.json).

## Protected checks

- `CHK-C1` (characterization) in `test/payment.characterization.test.js`: existing successful
  payment behavior remains stable; maps `INV1`.
- `CHK-T1` (change) in `test/payment.retry.test.js`: one transient failure is retried; maps `AC1`.
- `CHK-T2` (change) in `test/payment.retry.test.js`: concurrent retries share one provider charge;
  maps `INV1`, `R1`; non-interference: distinct operation ids remain isolated.

Non-interference: **applicable**; targets `operation id`; checks `CHK-T2`.

Evidence: [harness.json](harness.json).

## Harness review H1

- Attempt 1: **ACCEPT** - Grounded checks reject the plausible unsafe implementations.
- Corrections: 0
- Final protected commit: `<test-commit>`

Evidence: [harness-review.json](harness-review.json).

## Deterministic commands

- **C1 characterization** - [characterization-commands.json](characterization-commands.json)
  - `command-c1` `npm test`: exit 0, 820 ms
- **T1 harness baseline** - [commands.json](commands.json)
  - `command-t1` `npm test`: exit 1, 790 ms
- **final verification** - [verification-commands.json](verification-commands.json)
  - `command-final` `npm test`: exit 0, 840 ms

## Impacted coverage

- Scope: `src/payment.js`
- Baseline: lines 92/100 (92.00%), branches 18/20 (90.00%)
- Final: lines 94/100 (94.00%), branches 19/20 (95.00%)

No recorded coverage gaps.

Evidence: [coverage-baseline.json](coverage-baseline.json),
[coverage-final.json](coverage-final.json).

## Protected harness integrity

- `test/payment.characterization.test.js`: `<sha256>`
- `test/payment.retry.test.js`: `<sha256>`

Evidence: [harness.json](harness.json); final command replay:
[verification-commands.json](verification-commands.json).

## Independent verification

ACCEPT: The implementation satisfies the mapped criteria and invariants within the recorded scope.

No findings.

## Residual risks

- None recorded.

Evidence: [verification.json](verification.json).

## Run analytics

- Trace wall time: 15420 ms
- Model time: 11200 ms
- Command time: 2450 ms
- Turns: 9; correction turns: 0
- Commands: 5; failures: 1; timeouts: 0
- Tool calls: 31; failures: 0
- Artifact volume: 48210 bytes
- Tokens: total 48200, input 36100, cached input 18800, non-cached input 17300, output 12100,
  reasoning 6300

Per-role metrics follow in the generated report. Evidence: [trace.jsonl](trace.jsonl),
[manifest.json](manifest.json).

## Evidence index

The generated report lists each artifact path with its complete SHA-256 hash.

## Rollback boundary

Discarding this branch returns tracked source code to B0. ChangeSafely does not roll back ignored
files, local services, databases, queues, volumes, or external systems.

## Next action

Review the ChangeSafely branch and merge it through the normal repository process.
