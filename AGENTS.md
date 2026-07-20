# AGENTS.md - ChangeSafely development rules

## Mission

Build a minimal, complete high-assurance developer tool for risky changes. It considers several approaches before changing code, creates the missing safety net, implements one selected plan, and independently verifies the actual result. Low-assurance and vibe-coding workflows are outside the product.

Primary specification: [`CHANGESAFELY_SPEC.md`](./CHANGESAFELY_SPEC.md).
Recorded decisions: [`ARCHITECTURE_DECISIONS.md`](./ARCHITECTURE_DECISIONS.md).

## Priorities

In order of importance:

1. correctness;
2. a working vertical workflow;
3. safety and explainability;
4. simplicity;
5. fast development feedback;
6. demo readiness;
7. extensibility only when the need is proven.

## Development mode

- ChangeSafely restrictions for a target repository do not automatically apply to development of ChangeSafely itself.
- During iteration, run the smallest relevant set of checks; the full release suite is required only at a release boundary.
- Documentation-only and metadata-only changes do not require artificial tests.
- Create a separate verified commit after each completed phase, without mixing in user changes.
- Keep phase commits local. Do not push after every phase unless the user explicitly requests it.
- Defer release-only gates, branch protection, and additional compatibility matrices until prerelease unless they prevent a current, demonstrated risk.

## Engineering rules

- Follow KISS, YAGNI, and minimum sufficient change.
- Inspect and verify the complete relevant impact surface, but keep production writes minimal and
  precise. A narrow write scope is never a narrow read or verification scope.
- Search broadly for failure modes, but assert behavior only from the task or repository evidence.
- Do not add an abstraction layer without current value; isolating an external protocol or a security invariant counts as current value.
- Prefer the standard library and existing packages, but use a small maintained dependency when it materially reduces owned code or risk.
- Do not perform broad refactoring that is unnecessary for the current vertical slice.
- Do not mask errors with fallback behavior that creates the appearance of success.
- Do not claim that a check passed without a real exit code and a persisted result.
- Do not silently change architectural invariants.
- Record any material deviation from the specification in the same change: the problem, the minimal alternative, and the consequences.

## Mandatory architecture boundaries

- The TypeScript CLI is the product core.
- Codex App Server over local `stdio` is the only MVP AI runtime.
- Generated protocol types use a reproducible Codex baseline; runtime uses the standard Codex executable from `PATH` and fail-closed contract validation instead of an exact-version gate.
- Scratch Discovery and Canonical Contract must be separate root threads.
- Planners, Judge, Test Author, Implementer, and Verifier fork from the canonical `C0` checkpoint.
- Implementer does not inherit a Planner transcript.
- Verifier does not inherit the Implementer transcript.
- Roles exchange schema-validated artifacts, not hidden session state.
- Git state, artifacts, and deterministic command results are the sources of truth.
- Parallelism is allowed only for read-only work; write phases are strictly sequential.
- A protected baseline-green characterization harness is created before any production-code
  change. A separate baseline-red change harness is added when the task intentionally changes
  behavior.
- Only one selected plan is implemented.
- Production deployment, destructive migrations, worktree management, MCP, web UI, and a GitHub App are outside the MVP.

## Working with Git

- Do not automatically run `stash`, `reset --hard`, `clean`, or delete user files.
- Do not commit user changes.
- Existing dirty state is allowed while developing ChangeSafely: identify it first and leave changes owned by others untouched.
- For target-repository runtime, preserve the baseline commit, block the write phase when tracked state is dirty, and create a branch only after read-only planning.
- At runtime, preserve characterization, change-harness when applicable, and implementation
  boundaries as separate commits.
- Do not rewrite user history without an explicit request.

## Tests and checks

- Treat every target task as high risk. Cover the happy path, protected invariants, side effects,
  failures, isolation, and applicable temporal behavior before implementation.
- Every behavioral defect should receive a regression test when reasonably practical.
- Test Author creates baseline-green characterization tests and, when behavior changes,
  baseline-red acceptance or regression tests before implementation.
- Implementer may add tests, but must not weaken protected tests, assertions, or fixtures.
- Do not commit an accidental `only`; `skip` is allowed only for a real, explicitly identified platform or opt-in condition. Do not weaken assertions or use excessive mocks to manufacture success.
- The deterministic runner executes target-repository commands; ChangeSafely developers run project scripts directly.
- Errors must return a concrete status and an understandable next action.

## Security

- Network access is disabled by default for AI roles and target-repository commands. While developing ChangeSafely, network access is allowed for documentation, dependencies, CI, and Git hosting.
- Do not use production credentials.
- Do not read or print the contents of `.env` or other secret files.
- Do not put secrets in prompts, logs, artifacts, or reports.
- Do not perform production writes, deploy/apply operations, or irreversible external actions.
- Treat repository scripts as untrusted executable code.
- Automated subprocess commands must have a timeout and must not wait for interactive input.

## Implementation style

- Use strict TypeScript.
- Write names, code, and comments in English.
- Write all project documentation in English.
- Prefer small functions and explicit data flow.
- Do not build a framework inside the project.
- Do not optimize prematurely; measure before optimizing.
- Treat prompt/KV caching as a useful optimization, not an architectural guarantee.

## Work sequence

Before making a change:

1. read the relevant parts of the specification, architecture decisions, and code;
2. inspect the current repository state and existing tests;
3. identify the smallest working vertical slice;
4. implement it without future-facing extensions;
5. run the relevant checks;
6. briefly record what changed, the limitations, and the next risk.

Do not wait for perfect architecture before delivering the first working result.

## Definition of done for each change

A change is complete when it:

- solves the stated task;
- does not expand scope unnecessarily;
- has relevant tests for changed behavior;
- passes the relevant typecheck, lint, test, and build checks;
- adds no unjustified dependencies;
- preserves architectural invariants;
- updates documentation only where necessary;
- leaves the working project runnable.
