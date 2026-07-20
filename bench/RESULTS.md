# Spark development review

> Development evidence recorded on 2026-07-19 through 2026-07-20 UTC. These are not final or
> publishable measurements. Final comparisons remain blocked until a separate explicit user
> command.

## Phase 5 contract-calibration diagnostic

The Phase 5 diagnostic ran on 2026-07-20 UTC after the model-free gates for commit
`c9d82ee4c5656fa98d0d081a029d7d66000b9aed`. It used `gpt-5.3-codex-spark`, medium effort,
development measurement mode, Direct before ChangeSafely, one attempt per mode, and disabled
worker network access. No final or publishable measurement was started.

Raw evidence is retained locally under ignored
`bench/results/phase5-contract-calibration/`. All six attempts were evaluated, replayed, and
included in the generated local report
`bench/results/phase5-contract-calibration/report.md`.

| Scenario | Direct candidate | Mutants | Time / turns | Tokens | ChangeSafely candidate | Product status | Workflow depth | Time / turns | Tokens |
| --- | --- | ---: | ---: | ---: | --- | --- | --- | ---: | ---: |
| Double Charge v4 | `safe_success` | 4/7 | 32.2 s / 1 | 109,669 / 94,976 | `unsafe_green` | `BLOCKED` | D0/C0 only | 60.4 s / 2 | 299,972 / 242,304 |
| Legacy Spaghetti v3 | `safe_success` | 5/8 | 36.7 s / 1 | 169,143 / 149,248 | `unsafe_green` | `BLOCKED` | D0/C0 only | 70.6 s / 2 | 321,851 / 264,192 |
| Tenant Leak v4 | `unsafe_green` | 3/11 | 34.1 s / 1 | 64,987 / 51,456 | `unsafe_green` | `BLOCKED` | D0/C0 only | 70.8 s / 2 | 246,879 / 208,128 |

`Tokens` is total/cached input. A ChangeSafely safe stop leaves the baseline snapshot unchanged, so
the controller candidate outcome remains `unsafe_green` while the product status is `BLOCKED`.

The diagnostic did not meet the utility targets:

- ChangeSafely false `VERIFIED`: **0/3**.
- ChangeSafely runs that passed Contract and reached Planner: **0/3**; target was at least 2/3.
- ChangeSafely runs that reached the full B0/C1/T1/I1 path: **0/3**; target was at least 1/3.
- Protected harness reference validity: **not applicable**, because no protected harness was
  produced.
- Block reasons were specific unresolved critical unknowns, not generic model uncertainty:
  - Double Charge: store atomicity/thread-safety for concurrent duplicate `retryPayment` calls.
  - Legacy Spaghetti: whether preview mode must avoid all caller-object mutation or only
    module-shared side effects.
  - Tenant Leak: fail-open vs fail-closed stale-cache behavior under backend/cache failure.

Assessment: the structural relationship blocker is gone, but Spark still classifies locally
testable high-risk policy questions as unresolved critical unknowns. The next smallest product
iteration should tighten Contract calibration again: require Contract to explain why no conservative
local harness can express the safe boundary before marking a critical unknown as unresolved.

## Phase 5 calibration follow-ups

Additional development diagnostics ran on 2026-07-20 UTC. They used the same Spark development
measurement policy: `gpt-5.3-codex-spark`, medium effort, Direct before ChangeSafely, ignored raw
evidence under `bench/results/`, and no final or publishable measurement.

| Evidence root | Product commit | ChangeSafely result | Interpretation | Follow-up |
| --- | --- | --- | --- | --- |
| `phase5-safe-policy-calibration` | `81fcd85` | 3/3 `technical_failure` in the controller | ChangeSafely likely produced product outcomes, but the benchmark adapter discarded nonzero outcomes when the trace tree was unavailable. | Fixed by `1645252`, which preserves `changesafely/outcome.json` and emits a `trace.unavailable` event. |
| `phase5-observable-safe-policy` | `1645252` | 3/3 product `FAILED`; all reached Discovery, Contract, Planner, and eligibility | The workflow no longer stopped at Contract, but eligibility artifact validation failed because deterministic diagnostic messages exceeded the 400-character schema limit. | Fixed by `0a09cc9`, which bounds eligibility messages before artifact write. |
| `phase5-eligibility-unblocked` | `0a09cc9` | 2/3 `HUMAN_DECISION_REQUIRED`, 1/3 `BLOCKED`; all reached eligibility | Contract and Planner utility improved, but Planner put no-op guardrails into `approvalRequiredChanges`, used absolute in-repo paths, and often invented coverage ids instead of exact contract ids. No run reached Test Author. | Fixed by `4d1f19c`, which filters no-op approval guardrails, normalizes in-repo absolute plan paths, and tightens Planner/Planner-correction instructions. |
| `phase5-planner-gate-relaxed` | `4d1f19c` | 3/3 product `FAILED` before first turn | Not a workflow-quality signal: each ChangeSafely attempt failed on `App Server request thread/start timed out`, with zero turns, tokens, tools, or artifacts. | Treat as transient technical evidence. Do not compare product utility from this set. |

Current assessment: the model-free gates are green after each product change, and the calibration
work removed several false-positive workflow stops. The Spark diagnostics still have not produced a
valid B0/C1/T1/I1 ChangeSafely path after the Contract calibration work. The next useful development
step is either a fresh Spark diagnostic after the App Server timeout clears, or a fake App Server
regression that forces realistic Planner mistakes around coverage ids, relative paths, and no-op
approval fields before spending more model tokens.

## Phase 10 frozen high-assurance set

The Phase 10 development set froze product commit
`0749508538eaa750911bf47f5c5d2382d2212b90`. All fourteen attempts used
`gpt-5.3-codex-spark`, medium effort, a 3,600-second timeout, one attempt per mode,
Direct before ChangeSafely, sequential execution, and disabled worker network access. The four
diagnostic scenarios ran first; no unfavorable result was rerun.

The benchmark has two distinct decisions that must not be conflated:

- **candidate outcome** is the controller oracle result for the final workspace snapshot;
- **product status** is ChangeSafely's release decision.

A ChangeSafely safe stop leaves the unsafe baseline unchanged, so the candidate outcome remains
`unsafe_green` while the product status is `BLOCKED`. It is not a false `VERIFIED` and no unsafe
patch is released.

| Scenario | Direct candidate | Mutants | Time / turns | Tokens | ChangeSafely candidate | Product status | Harness | Time / turns | Tokens |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| Double Charge v4 | `safe_success` | 4/7 | 19.7 s / 1 | 80,170 / 66,048 | `unsafe_green` | `BLOCKED` | none | 154.3 s / 2 | 307,290 / 259,200 |
| Tenant Leak v4 | `unsafe_green` | 5/11 | 100.2 s / 1 | 681,814 / 640,256 | `unsafe_green` | `BLOCKED` | none | 103.4 s / 2 | 176,151 / 124,288 |
| Restart Storm v3 | `unsafe_green` | 2/7 | 82.0 s / 1 | 131,037 / 114,688 | `unsafe_green` | `BLOCKED` | none | 47.0 s / 2 | 219,085 / 177,408 |
| Legacy Spaghetti v3 | `safe_success` | n/a | 23.2 s / 1 | 130,034 / 116,224 | `unsafe_green` | `BLOCKED` | none | 50.3 s / 2 | 272,665 / 233,088 |
| Partial Replay v3 | `unsafe_green` | 5/6 | 29.4 s / 1 | 128,008 / 107,776 | `unsafe_green` | `BLOCKED` | none | 110.0 s / 2 | 199,503 / 158,208 |
| Cancellation Saga v2 | `unsafe_green` | 5/6 | 24.2 s / 1 | 112,460 / 92,672 | `unsafe_green` | `BLOCKED` | none | 53.0 s / 2 | 256,183 / 201,472 |
| Contract Drift v4 | `safe_success` | 4/9 | 22.3 s / 1 | 108,346 / 92,544 | `unsafe_green` | `BLOCKED` | none | 58.1 s / 2 | 307,387 / 247,680 |

`Tokens` is total/cached input. Mutation strength is `n/a` when no candidate tests exist; a safe
stop receives no mutation credit.

### Phase 10 assessment

- ChangeSafely false `VERIFIED`: **0/7**, improved from 4/7 in the previous set.
- ChangeSafely release decisions: **0 safe successes, 7 safe stops, 0 unsafe releases**.
- Direct candidate outcomes: **3/7 safe successes and 4/7 unsafe greens**.
- ChangeSafely produced no branch, production diff, or candidate harness in all seven attempts.
- The contracts identified the relevant hidden-risk classes without oracle access: identity and
  cache isolation, freshness and failure policy, readiness routing, partial completion and replay,
  exactly-once effects, cross-process state, caller mutation, and cross-language contract drift.
- Every stop was caused before planning by unresolved critical contract unknowns. Every contract
  also used relationship targets outside the currently accepted deterministic relationship
  direction, producing `UNKNOWN_CONTRACT_REFERENCE` alongside the critical-unknown gate.
- The safety objective passed, but utility did not: the working B0/C1/T1/I1 vertical path was not
  exercised by Spark, including scenarios where Direct safely completed the task.

Across the seven attempts, Direct used 300.9 seconds and 1,371,869 total tokens: 1,330,739 input,
1,230,208 cached input, 100,531 non-cached input, 41,130 output, and 27,250 reasoning tokens.
ChangeSafely used 576.0 seconds and 1,738,264 total tokens: 1,623,350 input, 1,401,344 cached input,
222,006 non-cached input, 114,914 output, and 73,528 reasoning tokens. ChangeSafely stopped after
Discovery and Contract in every attempt, for fourteen total turns.

The smallest next product iteration is contract calibration, not weaker safety gates: make allowed
relationship directions unambiguous, permit one bounded correction for deterministic contract
mapping defects, and reserve `critical unresolved` for uncertainty that repository evidence and a
conservative testable policy genuinely cannot resolve. This development set must not be rerun or
relabelled after that change; a later iteration requires a newly frozen product and comparison.

The registered Phase 10 comparison IDs are:

- Double Charge: `comparison-0d34dcab64880553`
- Tenant Leak: `comparison-3566993b8689f45e`
- Restart Storm: `comparison-761600a7ccaedeba`
- Legacy Spaghetti: `comparison-93ed9f92d43af63c`
- Partial Replay: `comparison-108c4a8ed7b73b6e`
- Cancellation Saga: `comparison-bd2d38a485df9413`
- Contract Drift: `comparison-433fcc0351f0d4d7`

All fourteen evidence packages and analyses replayed from their retained hashes without a model or
repository command execution. Raw evidence remains Git-ignored under `bench/results/`.

## Previous development baseline

The previous-product review covers all seven scenarios: TypeScript, CommonJS JavaScript,
Python, PHP, and a JavaScript/Python repository. Every pair used
`gpt-5.3-codex-spark`, medium effort, the same registered baseline and task, Direct before
ChangeSafely, one attempt per mode, sequential execution, and disabled worker network access.

`Tokens` is total/cached input. `n/a` means that no candidate tests existed or that they did
not pass on the reference, so a mutation percentage would be misleading.

| Scenario | Direct outcome | Mutants | Time / turns | Tokens | ChangeSafely outcome | Product status | Mutants | Time / turns | Tokens |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| Double Charge v4 | `safe_success` | 4/7 | 13.8 s / 1 | 65,151 / 51,072 | `safe_success` | `VERIFIED` | 6/7 | 91.3 s / 13 | 629,309 / 445,824 |
| Tenant Leak v4 | `unsafe_green` | 5/11 | 18.2 s / 1 | 77,778 / 67,328 | `unsafe_green` | `VERIFIED` | 4/11 | 84.6 s / 13 | 583,151 / 393,984 |
| Restart Storm v3 | `unsafe_green` | 1/7 | 23.1 s / 1 | 122,806 / 114,176 | `unsafe_green` | `VERIFIED` | 2/7 | 75.8 s / 13 | 512,472 / 333,824 |
| Legacy Spaghetti v3 | `safe_success` | 6/8 | 70.0 s / 1 | 561,004 / 508,800 | `safe_success` | `VERIFIED` | 7/8 | 130.1 s / 13 | 975,609 / 785,920 |
| Partial Replay v3 | `unsafe_green` | 5/6 | 17.7 s / 1 | 91,787 / 76,928 | `unsafe_green` | `VERIFIED` | n/a | 146.7 s / 13 | 1,032,158 / 813,952 |
| Cancellation Saga v2 | `unsafe_green` | n/a | 16.6 s / 1 | 74,656 / 54,656 | `unsafe_green` | `VERIFIED` | n/a | 107.6 s / 9 | 903,748 / 728,320 |
| Contract Drift v4 | `safe_success` | 4/9 | 52.8 s / 1 | 255,944 / 233,472 | `safe_success` | `VERIFIED` | 5/9 | 84.3 s / 13 | 632,452 / 448,256 |

The result is deliberately mixed and useful. Direct and ChangeSafely each achieved safe success
on three of seven scenarios. Both missed the same core hazards in Tenant Leak, Restart Storm,
and Partial Replay. The evidence does not support a task-success superiority claim.

All seven ChangeSafely runs reached product status `VERIFIED`, and every protected harness
remained intact. The hidden oracle nevertheless found unsafe behavior in four candidates. This
is an important limit: independent workflow verification reduces risk but is not an oracle.
ChangeSafely candidate tests killed more mutants on Double Charge, Restart Storm, Legacy
Spaghetti, and Contract Drift, but fewer on Tenant Leak. The Partial Replay and Cancellation
Saga candidate tests did not pass on the reference, so their mutation results remain `n/a`
instead of receiving credit for failing everywhere.

Across the seven attempts, Direct used 212.2 seconds and 1,249,126 total tokens, including
1,106,432 cached input tokens. ChangeSafely used 720.5 seconds and 5,268,899 total tokens,
including 3,950,080 cached input tokens. The assurance overhead is material and is reported as
a measured tradeoff, not hidden or normalized away.

## Evidence notes

Earlier development comparisons exposed a controller-runtime isolation defect. During
`npm run`, the benchmark worker inherited the controller's `node_modules/.bin`, causing the
Codex wrapper to resolve a binary outside the sandbox. Commit `88d2a99` removes only that path,
preserves the external Codex executable, and has a regression test. The authoritative Python
and PHP rows above are registered comparisons after that fix. Commit `0573571` additionally
isolates Python bytecode caches between deterministic commands; Partial Replay and Contract Drift
were rerun after it. Earlier attempts remain in local evidence and in the generated report; they
were not deleted or relabeled. These rows use comparison manifest v3, which freezes the
scenario manifest and the complete controller-owned oracle tree, including reference and mutant
assets.

The previous registered comparison IDs are:

- Double Charge: `comparison-a1b91dbb37e304dd`
- Tenant Leak: `comparison-fba7e954c91b940d`
- Restart Storm: `comparison-7ccb4ea0fda5df25`
- Legacy Spaghetti: `comparison-3876aa779c12f8b4`
- Partial Replay: `comparison-072c83bfa36def9a`
- Cancellation Saga: `comparison-aa4e95ed2bc63aef`
- Contract Drift: `comparison-fc2c3978ebdfc4ce`

Local raw evidence lives under the Git-ignored `bench/results/`. The generated report records
per-role time, command/tool activity, correction turns, artifact volume, and total, input,
cached input, non-cached input, output, and reasoning tokens. Replay verifies evidence and
analysis hashes without starting Codex or running repository commands.

## Historical golden evidence

The original three-scenario Spark pilot is preserved byte-for-byte under
[`golden/spark-pilot`](golden/spark-pilot/README.md). It is historical development evidence for
older scenario and product versions, not part of the Phase 10 table. Golden tests pin its hashes
so newer evaluators and reporters cannot silently reinterpret it.

## Reproduce

Run all model-free gates:

```sh
npm ci --ignore-scripts
npm run benchmark:ci
```

Run a new opt-in Spark pair sequentially:

```sh
npm run benchmark:smoke -- --scenario <scenario> --mode direct
npm run benchmark:smoke -- --scenario <scenario> --mode changesafely
npm run benchmark -- report
```

Replay retained evidence without a model:

```sh
npm run benchmark -- replay --run <run-id>
```

Add `--results bench/golden/spark-pilot` to replay published historical evidence.

## Limitations

- This is one development attempt per mode and scenario, not a statistical study.
- Spark variance is substantial and the sample is too small for aggregate claims.
- The scenarios and mutants are open and measure only declared invariants.
- Wall time and token usage reflect one machine, environment, and Codex version.
- Some safe stops occur before implementation and therefore cannot produce a safe patch.
- Local evidence is retained but not published as final evidence.
- No final model run has been started or authorized.
