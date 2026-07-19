import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppServerClient } from "./app-server/client.js";
import { parsePlanArtifactKey } from "./artifact-key.js";
import {
  ArtifactStore,
  artifactInputs,
  loadRunState,
  loadSelectedPlanArtifacts,
} from "./artifacts.js";
import { abortReason, SafeChangeError } from "./errors.js";
import {
  assertProtectedConfigurationUnchanged,
  changedPaths,
  commitPaths,
  createSafeChangeBranch,
  diffFrom,
  hashFiles,
  inspectBaseline,
} from "./git.js";
import { type ProgressReporter, reportProgress } from "./progress.js";
import { testAuthorPrompt } from "./prompts.js";
import { isTestPath, pathWithinPrefixes } from "./repository-policy.js";
import {
  completeContext,
  parseRoleArtifact,
  startContext,
  workspaceWritePolicy,
} from "./role-runtime.js";
import {
  type CommandResult,
  isSafetyTestCommand,
  runCommand,
  toCommandEvidence,
} from "./runner.js";
import {
  type DetailedPlan,
  type HarnessArtifact,
  harnessArtifactSchema,
  validateHarnessArtifact,
} from "./schemas.js";

export interface HarnessOptions {
  repoPath: string;
  runId: string;
  clientFactory?: () => AppServerClient;
  sandboxCommands?: boolean;
  model?: string;
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
}

export interface HarnessResult {
  branch: string;
  testCommit: string;
  protectedHashes: Record<string, string>;
  command: CommandResult;
  harness: HarnessArtifact;
}

function harnessError(code: string, message: string, exitCode: 1 | 2 = 1): SafeChangeError {
  return new SafeChangeError(code, message, {
    exitCode,
    nextAction: "Inspect the Test Author evidence and start a new run after fixing the cause.",
  });
}

function selectedTestPaths(plan: DetailedPlan): string[] {
  const paths = new Set<string>();
  for (const file of plan.files) if (isTestPath(file.path)) paths.add(file.path);
  for (const step of plan.steps) {
    for (const path of step.paths) if (isTestPath(path)) paths.add(path);
  }
  if (paths.size === 0) {
    throw harnessError("HARNESS_PLAN_INVALID", "Selected plan does not declare a test path", 2);
  }
  return [...paths];
}

export function diffRemovesExistingLines(diff: string): boolean {
  return diff.split("\n").some((line) => line.startsWith("-") && !line.startsWith("---"));
}

export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const startedAt = Date.now();
  const repoPath = resolve(options.repoPath);
  const roleEffort = options.model ? "medium" : "low";
  const state = await loadRunState(repoPath, options.runId);
  if (state.status !== "PLANNED") {
    throw harnessError(
      "HARNESS_NOT_READY",
      `Run ${state.runId} is not ready for harness creation: ${state.status}`,
      2,
    );
  }
  const baseline = await inspectBaseline(repoPath);
  if (
    baseline.commit !== state.baselineCommit ||
    baseline.fingerprint !== state.baselineFingerprint
  ) {
    state.status = "BASELINE_CHANGED";
    state.phase = "baseline-changed";
    state.reason = "Baseline no longer matches planning artifacts.";
    state.nextAction = "Start a new planning run from the current baseline.";
    const failedStore = new ArtifactStore(repoPath, state.runId, state.baselineCommit);
    await failedStore.writeState(state);
    reportProgress(options.onProgress, state.runId, state.phase, state.reason, startedAt);
    throw harnessError("BASELINE_CHANGED", state.reason, 2);
  }

  const { contract, decision, plan } = await loadSelectedPlanArtifacts(repoPath, state);
  const allowedTestPaths = selectedTestPaths(plan);
  const contractContext = state.contexts.find((entry) => entry.role === "contract");
  if (!contractContext?.turnId) {
    throw harnessError("CANONICAL_CONTEXT_MISSING", "Canonical C0 checkpoint is missing", 2);
  }

  const store = new ArtifactStore(repoPath, state.runId, state.baselineCommit);
  let branch: string;
  try {
    branch = await createSafeChangeBranch(baseline, state.runId);
  } catch (error) {
    state.status = "BLOCKED";
    state.phase = "write-preflight-blocked";
    state.reason = error instanceof Error ? error.message : String(error);
    state.nextAction = "Move or commit pre-existing files, then start a new SafeChange run.";
    await store.writeState(state);
    reportProgress(options.onProgress, state.runId, state.phase, state.reason, startedAt);
    throw error;
  }
  state.branch = branch;
  state.phase = "test-author";
  state.status = "RUNNING";
  state.nextAction = "Wait for the protected safety harness.";
  await store.writeState(state);
  reportProgress(
    options.onProgress,
    state.runId,
    state.phase,
    "Creating and proving the protected safety harness",
    startedAt,
  );

  const client =
    options.clientFactory?.() ??
    new AppServerClient({ cwd: repoPath, ...(options.signal ? { signal: options.signal } : {}) });
  try {
    await client.start();
    const fork = await client.forkThread({
      threadId: contractContext.threadId,
      lastTurnId: contractContext.turnId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const roleContext = startContext(
      "test-author",
      fork.thread.id,
      contractContext.threadId,
      contractContext.turnId,
    );
    state.contexts.push(roleContext);
    await store.writeState(state);
    const turn = await client.runTurn(
      fork.thread.id,
      testAuthorPrompt(contract, plan, decision, allowedTestPaths),
      {
        cwd: repoPath,
        sandboxPolicy: workspaceWritePolicy(repoPath),
        effort: roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: harnessArtifactSchema,
      },
    );
    completeContext(roleContext, turn.turnId);
    const harness = parseRoleArtifact(turn.message, validateHarnessArtifact);
    await assertProtectedConfigurationUnchanged(
      repoPath,
      state.baselineProtectedConfiguration ?? {},
    );
    const paths = await changedPaths(repoPath, "HEAD");
    if (paths.length === 0) {
      throw harnessError("HARNESS_EMPTY", "Test Author did not create a safety harness");
    }
    const unexpected = paths.filter(
      (path) => !isTestPath(path) || !pathWithinPrefixes(path, allowedTestPaths),
    );
    if (unexpected.length > 0) {
      throw harnessError(
        "HARNESS_SCOPE_VIOLATION",
        `Test Author changed paths outside test scope: ${unexpected.join(", ")}`,
      );
    }
    const declared = new Set(harness.protectedPaths);
    const undeclared = paths.filter((path) => !declared.has(path));
    if (undeclared.length > 0) {
      throw harnessError(
        "HARNESS_PROTECTION_INCOMPLETE",
        `Harness omitted protected paths: ${undeclared.join(", ")}`,
      );
    }
    const harnessDiff = await diffFrom(repoPath, "HEAD");
    if (diffRemovesExistingLines(harnessDiff)) {
      throw harnessError(
        "HARNESS_WEAKENED_EXISTING_TESTS",
        "Harness removed or rewrote existing test/fixture lines",
      );
    }
    const changedContents = (
      await Promise.all(paths.map((path) => readFile(resolve(repoPath, path), "utf8")))
    ).join("\n");
    if (/\.(?:skip|only)\s*\(/.test(changedContents)) {
      throw harnessError("HARNESS_SKIP_ONLY", "Harness contains forbidden skip/only usage");
    }

    const plannedSafetyCommands = new Set(
      plan.safetyTests.map((test) => JSON.stringify(test.argv)),
    );
    if (
      !isSafetyTestCommand(harness.targetedCommand.argv) ||
      !plannedSafetyCommands.has(JSON.stringify(harness.targetedCommand.argv))
    ) {
      throw harnessError(
        "HARNESS_COMMAND_INVALID",
        "Harness targeted command must be a selected-plan test command",
      );
    }
    const command = await runCommand(harness.targetedCommand.argv, repoPath, {
      sandboxed: options.sandboxCommands ?? false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await assertProtectedConfigurationUnchanged(
      repoPath,
      state.baselineProtectedConfiguration ?? {},
    );
    const combinedOutput = `${command.stdout}\n${command.stderr}`;
    const expectedPass = harness.expectedBaselineOutcome === "pass";
    if ((command.exitCode === 0) !== expectedPass) {
      throw harnessError(
        "HARNESS_BASELINE_OUTCOME_MISMATCH",
        `Harness baseline outcome mismatch: expected ${harness.expectedBaselineOutcome}, exit ${command.exitCode}; output: ${combinedOutput.slice(-1000)}`,
      );
    }
    if (
      harness.expectedBaselineOutcome === "fail" &&
      !/(?:failing tests|not ok|AssertionError|Error \[|fail\s+[1-9])/i.test(combinedOutput)
    ) {
      throw harnessError(
        "HARNESS_FAILURE_SIGNAL_MISSING",
        `Harness exited non-zero without an observable test-failure signal: ${combinedOutput.slice(-1000)}`,
      );
    }

    const testCommit = await commitPaths(repoPath, paths, "test: add SafeChange safety harness");
    const protectedHashes = await hashFiles(repoPath, paths);
    const harnessStored = await store.writeArtifact(
      "harness",
      "test-author",
      { ...harness, protectedHashes, testCommit },
      artifactInputs(state, "contract", "decision", parsePlanArtifactKey(decision.winnerPlanId)),
    );
    state.artifacts.harness = harnessStored.hash;
    const commandStored = await store.writeArtifact(
      "commands",
      "deterministic-runner",
      toCommandEvidence([command]),
      artifactInputs(state, "harness"),
    );
    state.artifacts.commands = commandStored.hash;
    state.testCommit = testCommit;
    state.phase = "harness-complete";
    state.status = "RUNNING";
    state.reason = "Protected safety harness committed before implementation.";
    state.nextAction = "Run the Implementer from C0 using the selected plan and T1.";
    await store.writeState(state);
    const committed = await inspectBaseline(repoPath);
    if (committed.commit !== testCommit) {
      throw harnessError(
        "HARNESS_COMMIT_MISMATCH",
        "Git HEAD does not match the recorded safety harness commit",
      );
    }
    reportProgress(
      options.onProgress,
      state.runId,
      state.phase,
      "Safety harness committed as T1",
      startedAt,
    );
    return { branch, testCommit, protectedHashes, command, harness };
  } catch (error) {
    const failure = abortReason(options.signal, error);
    state.status =
      options.sandboxCommands &&
      failure instanceof Error &&
      /sandbox|test-failure signal/i.test(failure.message)
        ? "BLOCKED"
        : "FAILED";
    state.phase = "test-author-failed";
    state.reason = failure instanceof Error ? failure.message : String(failure);
    state.nextAction =
      "Inspect the SafeChange branch and Test Author diff; no cleanup was performed.";
    await store.writeState(state);
    reportProgress(
      options.onProgress,
      state.runId,
      state.phase,
      "Safety harness stopped",
      startedAt,
    );
    throw failure;
  } finally {
    await client.close();
  }
}
