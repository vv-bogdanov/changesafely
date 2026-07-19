# ChangeSafely - technical specification for a coding agent

**Status:** accepted initial specification for the PoC and MVP; retained as a design record

**Project:** ChangeSafely
**Track:** OpenAI Build Week - Developer Tools
**Primary stack:** TypeScript / Node.js
**Primary interface:** CLI
**AI runtime:** Codex App Server over local `stdio` transport

---

## 1. Project context

ChangeSafely is being built for OpenAI Build Week. The project belongs to the **Developer Tools** category, which includes tools for testing, DevOps, agentic workflows, and security.

The hackathon evaluates projects across four equally weighted dimensions:

1. technical implementation and genuine use of Codex;
2. product completeness and functionality;
3. potential practical impact;
4. quality and originality of the idea.

A submission requires a working project, a repository with clear startup instructions, a public demo video shorter than three minutes, and a way to test the developer tool without rebuilding it from scratch. The deadline is **July 21, 2026, 5:00 PM PT**, which is **July 22, 2026, 7:00 AM in Bangkok**.

The team's goal is not merely to show a technical experiment, but to build a small, complete, and convincing tool that demonstrates a new way of working with coding agents.

### Why ChangeSafely was chosen

A modern coding agent often performs the entire cycle in one context:

```text
understand the task
-> choose the first plausible solution
-> change the code
-> change or add tests
-> evaluate the result itself
```

This process has systemic weaknesses:

- the first idea may not be the best one and creates anchoring;
- planning is often insufficiently separated from implementation;
- the agent may not notice missing checks before changing code;
- tests may be tailored to the chosen implementation;
- the change scope may expand unnoticed;
- the change author is inclined to confirm its own solution;
- "tests passed" does not mean the original contract was satisfied;
- a long session becomes polluted with logs, incorrect hypotheses, and intermediate attempts;
- Git rollback restores source code, but not necessarily external state.

ChangeSafely must reduce these risks through a structured process, not promise that breakage is absolutely impossible.

---

## 2. Product concept

ChangeSafely is an orchestration and verification layer around Codex for safely making changes to an existing repository.

The user states an intent in ordinary language, for example:

> Add automatic payment retries when the provider fails temporarily, but prevent duplicate charges and do not change the public API.

ChangeSafely:

1. explores the repository;
2. formalizes the task and protected properties;
3. independently considers several approaches;
4. selects the minimally sufficient safe plan;
5. first creates the missing safety net;
6. implements one selected plan on a separate Git branch;
7. runs objective checks;
8. independently compares the actual result with the original task;
9. delivers a ready branch and report or stops with a concrete reason.

### Short product pitch

> **ChangeSafely explores multiple approaches before touching code, builds the missing safety net, implements the safest minimal plan, and independently verifies the actual change.**

### Core formula

```text
COMPARE BEFORE CODING
→ TEST BEFORE IMPLEMENTATION
→ VERIFY AGAINST THE ORIGINAL CONTRACT
```

---

## 3. Target audience

The primary MVP audience:

- developers who use Codex to change existing projects;
- teams that care about regressions, scope control, and explainable decisions;
- DevOps engineers who use agents to change configuration and infrastructure code;
- owners of critical product areas: payments, authentication, permissions, data, and integrations.

The MVP is optimized for **TypeScript / Node.js repositories**, but the architecture must not artificially couple orchestration to a particular test framework.

---

## 4. MVP goals

The ChangeSafely MVP must prove the following product hypotheses.

### 4.1. Several independent plans are more useful than the first answer

The user sets the number of plans `N`. The default is 3; a reasonable MVP range is 1 to 5.

Each planner must propose an independent approach, not a cosmetic variation, and then turn it into a concrete plan for the current repository.

### 4.2. Context can be preserved without contaminating roles

A shared understanding of the task must be preserved by forking the canonical Codex session, while one actor's intermediate reasoning must not automatically pass to another.

### 4.3. Checks must be created before implementation

ChangeSafely must first identify what evidence is missing for the selected change and create a protected safety harness before implementing production code.

### 4.4. Implementation must match the selected scope

Actual changes must be compared with the plan. An unexpected dependency, migration, protected-file change, or scope expansion must cause a stop or replanning.

### 4.5. The result must be verified independently

Verifier must assess the change against the original Change Contract and actual command results without inheriting the Implementer transcript.

### 4.6. The user must receive a complete artifact

A successful run ends with:

- a separate Git branch;
- a clear commit history;
- added checks;
- an implemented change;
- a verification report;
- explicit residual risk and rollback limitations.

---

## 5. MVP non-goals

The following capabilities are deliberately excluded until the core workflow is proven:

- web UI;
- GitHub App;
- MCP integrations;
- production deployment;
- running `terraform apply`, `kubectl apply`, or other production writes;
- a real canary rollout;
- automatic rollback of external systems;
- Git worktree management;
- implementing multiple competing plans;
- a universal policy language;
- support for every language and package manager;
- a full CI/CD platform;
- proof that every possible regression is absent;
- a complex multi-agent framework or workflow engine;
- long agent debates and recursive brainstorming trees.

Do not add these capabilities "for the future" until the core vertical workflow is complete and demonstrated.

---

## 6. Core principles

### 6.1. KISS and YAGNI

Choose the simplest solution that fully supports the approved workflow. Do not create general abstraction layers without a real second use case.

### 6.2. No evidence - no change

If a significant requirement or protected property lacks a sufficient check, ChangeSafely must create that check first or stop honestly.

### 6.3. The simplest eligible plan, not the shortest plan

KISS applies after excluding plans that fail the contract, cannot be verified sufficiently, or have an unacceptable recovery path.

### 6.4. One writer

Parallelism is allowed for read-only planning. Working-directory changes are performed strictly sequentially by one write actor at a time.

### 6.5. Fail closed

When state is unknown, the baseline has changed, a result is ambiguous, or work exceeds scope, the system stops instead of continuing on assumptions.

### 6.6. Threads carry context; artifacts carry commitments

A fork helps a role understand the original task. The inter-role contract is always expressed as a schema-validated artifact, not hidden conversation history.

### 6.7. The source of truth is not model opinion

The sources of truth are:

```text
Git state
+ validated artifacts
+ deterministic command results
```

The LLM analyzes and explains results, but does not replace exit codes, the Git diff, or file contents.

### 6.8. Verification independence

Verifier must not inherit the Implementer's reasoning or self-assessment.

### 6.9. Honest rollback boundary

The MVP guarantees the ability to return to the original **tracked source code** through the baseline branch or commit. It does not claim to roll back local databases, Docker volumes, queues, external APIs, or production state.

---

## 7. Canonical workflow

```text
PREFLIGHT
  ↓
SCRATCH DISCOVERY (D0)
  ↓
VALIDATED EVIDENCE ARTIFACT
  ↓
CANONICAL CONTRACT THREAD (C0)
  ↓
PLANNERS × N
  ↓
ELIGIBILITY FILTER + JUDGE
  ↓
BASELINE REVALIDATION
  ↓
CREATE CHANGESAFELY BRANCH
  ↓
TEST AUTHOR → PROTECTED SAFETY HARNESS
  ↓
TEST COMMIT (T1)
  ↓
IMPLEMENTER
  ↓
IMPLEMENTATION COMMIT (I1)
  ↓
DETERMINISTIC VERIFICATION
  ↓
INDEPENDENT VERIFIER
  ↓
REPORT / VERIFIED BRANCH / EXPLICIT BLOCK
```

### 7.1. Preflight

Before expensive work, ChangeSafely checks that:

- the run is inside a Git repository;
- the current branch and baseline commit are known;
- there are no uncommitted tracked or staged changes;
- no merge or rebase is in progress;
- the working state is suitable for a safe run;
- Codex App Server is available;
- environment requirements do not conflict with the MVP safe mode.

ChangeSafely must not automatically run `stash`, `reset --hard`, or `clean`, commit user changes, or delete files.

Ignored files, including local configuration and dependencies, remain in the current checkout. ChangeSafely must not copy `.env`, disclose its contents, or include secrets in prompts or reports.

### 7.2. Scratch Discovery - `D0`

Discovery runs in a new read-only session.

Its task is to:

- understand the relevant part of the project;
- find existing execution paths;
- identify available test, build, lint, and validation commands;
- find current tests and gaps;
- record constraints from repository instructions;
- identify unknown factors;
- collect verifiable references to files, symbols, and commands.

`D0` is exploratory and potentially noisy. It may contain incorrect intermediate hypotheses, so it **is not the parent of all subsequent roles**.

The result of `D0` is a compact `Evidence Artifact` containing confirmed facts, assumptions, unknowns, and evidence references.

### 7.3. Canonical Contract - `C0`

`C0` is created as a new clean session, not as a continuation of Discovery.

It receives:

- the user's original intent;
- validated evidence;
- critical repository constraints.

When needed, `C0` selectively rechecks facts and creates the canonical Change Contract:

- goal;
- acceptance criteria;
- protected invariants;
- non-goals;
- allowed scope;
- forbidden or approval-required changes;
- known evidence gaps;
- risk flags;
- unresolved unknowns.

The completed `C0` turn becomes an immutable checkpoint from which independent roles fork.

`C0` must not contain raw logs, planner debates, implementation attempts, or long stack traces.

### 7.4. Independent planners

Create `N` forks from the canonical `C0` checkpoint.

Each planner:

1. formulates an independent high-level approach;
2. checks it against the real repository;
3. expands it into a detailed plan;
4. may conclude that its approach is unsuitable.

Standard lenses for `N = 3`:

#### Minimal-change lens

- minimal diff;
- existing abstractions;
- no speculative architecture;
- no optional dependencies.

#### Reversible-change lens

- backward compatibility;
- preservation of the old path when justified;
- inexpensive rollback;
- gradual switching.

#### Risk-first lens

- minimal operational blast radius;
- isolation of dangerous effects;
- strong verifiability;
- explicit stop and recovery conditions.

For other values of `N`, additional or user-provided lenses are allowed, but the MVP architecture must not become a separate brainstorming platform.

Each planner returns a self-contained `Detailed Plan Artifact` that includes:

- approach and rationale;
- acceptance coverage;
- expected components and file scope;
- change order;
- required safety tests;
- existing verification commands;
- dependencies and migrations;
- risks, assumptions, and unknowns;
- recovery strategy;
- reasons the plan may be rejected.

Plans do not see one another's transcripts.

### 7.5. Eligibility filter and Judge

First, ordinary code and formal rules exclude plans that:

- do not cover the acceptance criteria;
- clearly violate protected invariants;
- lack a verification strategy;
- lack a realistic source or recovery path;
- require unexplained scope expansion;
- conceal critical unknowns;
- require an unjustified new dependency or migration;
- cannot be verified sufficiently in the available environment.

Then a separate Judge forks from `C0` and receives only:

- eligible Plan Artifacts;
- results from the formal gates.

The Judge compares plans by:

- completeness in satisfying the goal;
- blast radius;
- reversibility;
- testability;
- complexity;
- new dependencies;
- operational risk;
- expected diff.

Do not use a pseudo-precise rating system. The result must contain a concrete explanation of:

- why the winner was selected;
- why the alternatives were rejected;
- what tradeoffs remain;
- whether a human decision is required.

### 7.6. Revalidate baseline

Before the first write, ChangeSafely rechecks:

- baseline commit;
- Git status;
- relevant manifests;
- repository instruction sources;
- protected environment-file fingerprints, if they are tracked without reading secrets.

If the original state changed, artifacts are considered stale and the run stops with `BASELINE_CHANGED` status.

### 7.7. Branch creation

Only after read-only planning is complete does ChangeSafely create a separate branch from the baseline.

Work continues in the current checkout to preserve the already configured local environment, `.env`, dependencies, IDE, and local services.

ChangeSafely does not manage worktrees in the MVP. A user or Codex App may run ChangeSafely inside an existing worktree, but the product core must not create and configure one itself.

### 7.8. Test Author and safety harness

Test Author forks from `C0` and receives:

- Change Contract;
- selected plan;
- evidence gaps;
- allowed test scope.

It does not receive the Implementer transcript and must not tailor checks to the future implementation.

The Test Author's task is to create the minimally sufficient safety net for the selected change.

Depending on the task type:

- bug fix: a regression test must reproduce the problem on the baseline;
- feature: an acceptance check must demonstrate that the required behavior is absent;
- refactoring: characterization tests capture current behavior and pass on the baseline;
- DevOps/configuration: use validation, dry runs, rendered diffs, policy checks, or health checks.

If a sufficient check cannot be created in the available environment, ChangeSafely must return `INSUFFICIENT_VERIFICATION_ENVIRONMENT` rather than generate a meaningless mock for formal success.

After the safety harness is verified, create a separate `T1` commit.

Tests and assertions designated as protected are recorded for later verification.

### 7.9. Implementer

Implementer forks from `C0`, not from the selected Planner.

It receives only formal inputs:

- Change Contract;
- selected plan;
- Judge decision;
- test commit;
- allowed scope;
- current Git state.

This keeps the Detailed Plan self-contained and independent of the hidden Planner transcript.

Implementer may add new tests and fixtures, but may not:

- remove protected tests;
- weaken protected assertions;
- add `skip` or `only` to bypass verification;
- modify protected fixtures so that a test loses its meaning;
- silently expand scope.

If implementation requires work outside the approved area, ChangeSafely returns `REPLAN_REQUIRED`.

After implementation, create a separate `I1` commit.

### 7.10. Deterministic verification

Ordinary TypeScript code, not the model, runs and records:

- targeted tests;
- the full test suite when available and justified;
- typecheck;
- lint;
- build;
- project-owned validation commands;
- Git diff and changed paths;
- changes to package manifests and lockfiles;
- newly added migrations;
- changes to protected files and instruction sources;
- the state of protected safety tests.

ChangeSafely must compare the baseline, `T1`, and `I1` to distinguish the safety harness from the implementation.

The LLM cannot declare verification successful without confirmed command results.

### 7.11. Independent Verifier

Verifier forks from `C0`, not from Implementer, Judge, or Test Author.

It receives:

- Change Contract;
- selected plan;
- Judge constraints;
- baseline commit;
- test commit;
- implementation commit;
- actual diff;
- deterministic command results;
- residual unknowns.

It does not receive the Implementer transcript, self-assessment, or explanation of why the code should be correct.

Verifier answers three questions:

1. Was the original Change Contract satisfied?
2. Were the stated protected invariants preserved within the available evidence?
3. Does the actual diff match the selected plan and allowed scope?

If Verifier finds a local defect within the approved plan, one bounded repair loop may `resume` the same Implementer. After the fix, a new Verifier forks from `C0` and verifies the change again.

If scope must change, replan instead of applying a local repair.

---

## 8. Session management rules

ChangeSafely must distinguish `new thread`, `fork`, and `resume`.

### New thread

Use when the previous context may be contaminated or may impose an incorrect hypothesis:

- Scratch Discovery `D0`;
- Canonical Contract `C0`;
- a possible future cold audit.

### Fork from `C0`

Use when shared facts and the contract are needed, but the role must remain independent:

- each Planner;
- Judge;
- Test Author;
- Implementer;
- Verifier.

### Resume

Use only when the same actor continues the same hypothesis and scope:

- Planner refines its own plan;
- Test Author fixes its own invalid harness;
- Implementer fixes a local error within the selected plan.

### Forbidden lineage

Do not construct these chains:

```text
Planner → Implementer
Implementer → Verifier
Judge → Implementer
Test Author → Implementer
Planner A → Planner B
```

Artifacts, not transcripts, pass between these roles.

### Prompt/KV caching

The shared `C0` checkpoint and identical planner-fork prefix should favor prompt caching. A cache hit is not guaranteed and must not affect workflow correctness.

The context graph is designed for quality, independence, and manageability. Cached token usage and latency should be measured as optimizations.

---

## 9. Product architecture

### 9.1. Core components

```text
ChangeSafely TypeScript CLI
│
├── Workflow Orchestrator
├── Codex Runtime Client
├── Context Graph Registry
├── Artifact Store
├── Git Controller
├── Deterministic Runner
└── Report Generator
```

### Workflow Orchestrator

Manages approved phases, transitions, and statuses. Do not use a separate state-machine framework while a normal sequence of TypeScript operations remains clear.

### Codex Runtime Client

A thin client for `codex app-server` over local `stdio` JSON-RPC transport.

All roles in one run use the same explicitly recorded model. The public CLI defaults
to `gpt-5.6-sol`; role-specific model routing is outside the MVP.

Required conceptual operations:

- start thread;
- start turn;
- fork a thread at a completed checkpoint;
- resume role thread;
- interrupt turn;
- wait for the result and events;
- obtain schema-constrained output.

Do not build a general App Server SDK or support multiple Codex backends at once.

Protocol types and JSON Schema must be generated reproducibly from the fixed development/CI App Server version rather than maintained by hand. Runtime uses the standard Codex executable from `PATH` and must fail closed on actual incompatibility in the handshake or used messages, not merely on a version-string mismatch.

### Context Graph Registry

Stores the relationship:

```text
role
thread id
session id
parent thread/checkpoint
turn id
status
```

It exists for traceability, not to store business artifacts.

The trace records fork lineage and cumulative App Server token snapshots. Ordinary
TypeScript derives per-turn and aggregate input, cached input, non-cached input,
output, reasoning, timing, command, tool, correction, and artifact metrics. Forked
thread usage must be computed as a delta from the inherited checkpoint; unavailable
baselines remain `null` and are never estimated.

### Artifact Store

Stores schema-validated phase results:

- evidence;
- contract;
- plans;
- decision;
- verification plan/harness metadata;
- deterministic results;
- verifier report.

Each artifact must be associated with:

- run id;
- baseline commit;
- contract version;
- role;
- hashes of input artifacts;
- evidence references;
- assumptions and unknowns.

### Git Controller

Is responsible only for safe, explainable operations:

- checking state;
- recording the baseline;
- creating the ChangeSafely branch;
- obtaining the diff;
- checking changed paths;
- creating the two primary commits;
- refusing destructive cleanup.

### Deterministic Runner

Runs approved project commands, records exit code, stdout, and stderr, and does not accept interactive confirmations.

Repository-controlled commands must run in a restricted environment without production credentials and without network access by default.

### Report Generator

Creates a concise human-readable report:

- original task;
- plans considered;
- selection and reasons;
- checks created;
- actual changes;
- command results;
- residual risks;
- rollback boundary;
- final status.

### 9.2. Codex App Server

Use App Server because the project requires:

- `thread/fork` at a specific completed turn;
- persisted session trees;
- streaming lifecycle events;
- per-turn `outputSchema`;
- explicit sandbox policies;
- version-specific generated protocol types.

Use stable `stdio` transport for the MVP. Do not use the experimental WebSocket transport.

Each role receives an explicit sandbox rather than relying on implicit inheritance:

```text
Discovery      read-only, network off
Contract       read-only, network off
Planners       read-only, network off
Judge          read-only, network off
Test Author    workspace write, network off
Implementer    workspace write, network off
Verifier       read-only, network off
```

Do not use APIs that execute commands outside the sandbox unless required for an explicitly initiated user action.

### 9.3. CLI and Skill

The product core is a standalone CLI.

Add a Codex Skill after the CLI reliably executes the core workflow. The Skill must be a thin entry point that:

- accepts the user's intent;
- starts the CLI;
- shows the final report;
- helps interpret `BLOCKED`, `REPLAN_REQUIRED`, or `HUMAN_DECISION_REQUIRED`.

Do not put core orchestration logic in `SKILL.md`.

---

## 10. Git and working environment

### 10.1. Current checkout and separate branch

The MVP works in the current checkout and creates a separate ChangeSafely branch before the first write.

This preserves the existing local environment:

- `.env` and `.env.local`;
- installed dependencies;
- IDE configuration;
- Docker Compose and local services;
- already configured credentials for test environments.

### 10.2. Change history

Minimum target history:

```text
B0  baseline commit
 │
 T1  safety harness commit
 │
 I1  implementation commit
```

`T1` must make it possible to see separately which checks were added before implementation.

### 10.3. Fingerprint and invalidation

Before and after read-only phases, ChangeSafely must detect baseline changes in:

- HEAD;
- tracked Git state;
- relevant manifests;
- instruction sources;
- protected configuration fingerprints without revealing contents.

Any mismatch invalidates planning results.

### 10.4. Rollback limitation

MVP guarantee:

> The user can discard the ChangeSafely branch and return to baseline tracked source code.

Automatic restoration is not guaranteed for:

- local or remote databases;
- Docker volumes;
- queues;
- generated ignored files;
- external API side effects;
- production infrastructure.

The MVP therefore prohibits production writes and destructive migrations.

---

## 11. Structured artifacts

Thread history is useful to the model, but must not be the only state store.

Minimum persistent run state:

```text
.changesafely/runs/<run-id>/
├── state.json
├── evidence.json
├── contract.json
├── plans/
├── decision.json
├── verification.json
└── report.md
```

The exact internal structure is left to the implementation, but the system must be able to:

- identify the last successfully completed phase;
- associate artifacts with the baseline and contract version;
- avoid unnecessarily repeating a completed expensive phase;
- explain how a decision was derived;
- reconstruct a human-readable report after process interruption.

Do not use an external database for the MVP.

---

## 12. Final statuses

The system must distinguish at least:

### `VERIFIED`

The contract is satisfied within the stated evidence; the actual diff is acceptable; deterministic checks passed.

### `BLOCKED`

The environment, requirements, or evidence are insufficient to continue safely.

### `BASELINE_CHANGED`

The repository or critical instructions/configuration changed after analysis.

### `REPLAN_REQUIRED`

Implementation requires leaving the selected scope, or the original plan proved inapplicable.

### `HUMAN_DECISION_REQUIRED`

Explicit informed approval is required, for example for:

- a new production dependency;
- public API change;
- schema/data migration;
- new permissions or secrets;
- an irreversible action;
- a change to a protected invariant.

### `FAILED`

Commands or checks failed with an error that was not safely corrected within the allowed repair loop.

Every status must include a concrete reason and a recommended next action.

---

## 13. Golden demo scenario

The hackathon needs one controlled TypeScript demo repository. It serves as a product test, but must not be hard-coded into the general architecture.

Recommended scenario:

> Add an automatic retry for a payment operation after a transient timeout while preserving the public API and preventing duplicate charges.

Expected competing approaches:

1. a naive retry around the current call - minimal but potentially dangerous;
2. a retry with an idempotency mechanism in the existing adapter - moderate and reversible;
3. a queue/outbox or larger architectural redesign - reliable but excessive for the task.

ChangeSafely must:

- produce materially different plans;
- reject or downgrade the unsafe minimal plan;
- reject the excessive YAGNI option;
- select the minimally sufficient idempotency-aware plan;
- add tests for timeout, retry, and duplicate effects before implementation;
- implement the selected change;
- show two separate commits;
- prove completion through real command results;
- produce a short report understandable in a three-minute video.

An additional negative demo may deliberately make Implementer change a protected test or add a new dependency to demonstrate the automatic gate.

---

## 14. Acceptance criteria MVP

The MVP is ready when it demonstrates the following on the golden path:

1. The CLI accepts a task and plan count.
2. Scratch Discovery and Canonical Contract are separate.
3. `N` planners fork from one `C0` checkpoint.
4. With `N = 3`, the approaches are materially different.
5. Plan artifacts share the same validated shape.
6. Ineligible plans are excluded before the LLM Judge.
7. The Judge gives an explainable choice without a pseudo-precise score.
8. The baseline is rechecked before the first write.
9. A separate Git branch is created.
10. Test Author creates a meaningful safety harness before implementation.
11. The safety harness is recorded in a separate commit.
12. Implementer does not inherit a planner transcript.
13. Protected tests cannot be weakened unnoticed.
14. Implementation is recorded in a separate commit.
15. Tests, typecheck/build, and the Git diff are checked deterministically.
16. Verifier does not inherit the Implementer transcript.
17. Unexpected scope expansion causes a stop.
18. The user receives a runnable branch and a clear report.
19. Judges can install and test the project without rebuilding it from scratch.
20. The complete core workflow can be demonstrated convincingly in under three minutes.

---

## 15. Development approach

Development must proceed in working vertical slices, not by building components "for the future."

### First prove the core

The first working slice must test only the central hypothesis:

```text
canonical context
→ independent planners
→ plan comparison
```

It may run read-only and leave the repository unchanged.

### Then complete one end-to-end path

Add:

```text
selected plan
→ safety harness
→ implementation
→ deterministic verification
→ independent verifier
```

Only for one prepared TypeScript demo repository.

### Then improve reliability

Improve:

- structured errors;
- interrupted-run recovery;
- artifact validation;
- baseline invalidation;
- protected test checks;
- CLI experience;
- installation and demo packaging.

### Only then expand the surface

Add a Codex Skill, a second DevOps dry-run example, and more flexible lenses only after the golden path works.

Keep a runnable project version at every stage. Do not build all future capabilities at once.

---

## 16. Critical architecture invariants

A coding agent must not change the following decisions without explicit agreement:

1. The primary language is TypeScript.
2. The primary product is a CLI.
3. The AI runtime is Codex App Server over `stdio`.
4. Scratch Discovery and Canonical Contract are separate root threads.
5. All decision roles fork from `C0`.
6. Implementer does not fork from Planner.
7. Verifier does not fork from Implementer.
8. Roles exchange schema-validated artifacts.
9. Git, artifacts, and command results are the sources of truth.
10. Only read-only planners run in parallel; writers are sequential.
11. A protected safety harness is created before implementation.
12. The MVP creates one implementation branch and implements one plan.
13. ChangeSafely does not perform production deployment or destructive external actions.
14. Worktree management is outside the MVP.
15. The core workflow must not depend on a hidden transcript or cache hit.

If a reason to change an invariant is found, the coding agent must first describe the problem, the minimal alternative, and the consequences instead of silently making an architectural change.

---

## 17. Project definition of done

The project is ready for submission when:

- the core golden demo works reliably and repeatedly;
- the CLI has clear installation and help;
- the README lets a user run the demo without knowing the internal architecture;
- a sample task and expected result are available;
- failures are explainable and do not leave ambiguous state;
- there are no production credentials or irreversible operations;
- repository history shows genuine use of Codex;
- the `/feedback` Codex Session ID for the primary development session is preserved;
- a video shorter than three minutes is prepared;
- documentation clearly shows where Codex, GPT-5.6, thread forking, and independent verification are used;
- the product looks like a complete developer tool, not a collection of unrelated scripts.

---

## 18. Official sources

- OpenAI Build Week overview and requirements: https://openai.devpost.com/
- Codex App Server: https://developers.openai.com/codex/app-server
- Codex subagents and context management: https://developers.openai.com/codex/subagents
- Codex skills: https://developers.openai.com/codex/build-skills
- Codex best practices: https://developers.openai.com/codex/learn/best-practices
