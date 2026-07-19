import { resolve } from "node:path";
import { AppServerClient } from "./app-server/client.js";
import { parsePlanArtifactKey } from "./artifact-key.js";
import {
  ArtifactStore,
  artifactInputs,
  loadRunState,
  loadSelectedPlanArtifacts,
  loadVerifiedArtifact,
} from "./artifacts.js";
import {
  assertNoUntrackedFiles,
  assertProtectedConfigurationUnchanged,
  changedPaths,
  commitPaths,
  currentBranch,
  currentCommit,
  diffFrom,
  hashFiles,
} from "./git.js";
import { implementerPrompt, repairPrompt, verifierPrompt } from "./prompts.js";
import { implementationReport } from "./report.js";
import { isApprovalSensitivePath, pathWithinPrefixes } from "./repository-policy.js";
import {
  completeContext,
  parseRoleArtifact,
  readOnlyPolicy,
  startContext,
  workspaceWritePolicy,
} from "./role-runtime.js";
import { type CommandResult, runCommand, toCommandEvidence } from "./runner.js";
import {
  type DetailedPlan,
  type ImplementationArtifact,
  implementationArtifactSchema,
  type RunPhase,
  type StoredHarnessArtifact,
  type VerificationArtifact,
  validateImplementationArtifact,
  validateVerificationArtifact,
  verificationArtifactSchema,
} from "./schemas.js";
import { hashRecordsEqual, verificationAccepted } from "./verification.js";

export interface ImplementationOptions {
  repoPath: string;
  runId: string;
  clientFactory?: () => AppServerClient;
  sandboxCommands?: boolean;
  model?: string;
  signal?: AbortSignal;
}

export interface ImplementationResult {
  implementationCommit: string;
  commands: CommandResult[];
  verification: VerificationArtifact;
  accepted: boolean;
  reportPath: string;
}

function projectCommands(harness: StoredHarnessArtifact, plan: DetailedPlan): string[][] {
  const commands = [
    harness.targetedCommand.argv,
    ...plan.verificationCommands.map(({ argv }) => argv),
  ];
  const seen = new Set<string>();
  return commands.filter((argv) => {
    const key = JSON.stringify(argv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function repairableVerification(verification: VerificationArtifact, planPaths: string[]): boolean {
  const errors = verification.findings.filter((finding) => finding.severity === "error");
  return (
    verification.verdict === "reject" &&
    verification.scopeConformant &&
    verification.evidenceSufficient &&
    errors.length > 0 &&
    errors.every((finding) => finding.path !== "" && pathWithinPrefixes(finding.path, planPaths))
  );
}

async function validateImplementationChange(input: {
  repoPath: string;
  fromCommit: string;
  artifact: ImplementationArtifact;
  harness: StoredHarnessArtifact;
  planPaths: string[];
  state: Awaited<ReturnType<typeof loadRunState>>;
}): Promise<string[]> {
  await assertProtectedConfigurationUnchanged(
    input.repoPath,
    input.state.baselineProtectedConfiguration ?? {},
  );
  const actualPaths = await changedPaths(input.repoPath, input.fromCommit);
  if (actualPaths.length === 0) throw new Error("Implementer made no production change");
  const protectedAfter = await hashFiles(
    input.repoPath,
    Object.keys(input.harness.protectedHashes),
  );
  if (!hashRecordsEqual(input.harness.protectedHashes, protectedAfter)) {
    throw new Error("Implementer changed a protected T1 path");
  }
  const outsidePlan = actualPaths.filter((path) => !pathWithinPrefixes(path, input.planPaths));
  if (outsidePlan.length > 0) {
    input.state.status = "REPLAN_REQUIRED";
    throw new Error(`Implementation expanded beyond selected plan: ${outsidePlan.join(", ")}`);
  }
  const sensitive = actualPaths.filter(isApprovalSensitivePath);
  if (sensitive.length > 0) {
    input.state.status = "HUMAN_DECISION_REQUIRED";
    throw new Error(`Implementation changed approval-sensitive paths: ${sensitive.join(", ")}`);
  }
  const declaredPaths = new Set(input.artifact.changedPaths);
  const omittedPaths = actualPaths.filter((path) => !declaredPaths.has(path));
  if (omittedPaths.length > 0) {
    throw new Error(`Implementation artifact omitted changed paths: ${omittedPaths.join(", ")}`);
  }
  return actualPaths;
}

async function runProjectCommands(
  repoPath: string,
  harness: StoredHarnessArtifact,
  plan: DetailedPlan,
  sandboxed: boolean,
  protectedConfiguration: Record<string, string>,
  signal?: AbortSignal,
): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const argv of projectCommands(harness, plan)) {
    results.push(
      await runCommand(argv, repoPath, {
        sandboxed,
        ...(signal ? { signal } : {}),
      }),
    );
  }
  const protectedFinal = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
  if (!hashRecordsEqual(harness.protectedHashes, protectedFinal)) {
    throw new Error("Protected T1 paths changed during deterministic verification");
  }
  await assertProtectedConfigurationUnchanged(repoPath, protectedConfiguration);
  return results;
}

function assertCommandsPassed(results: CommandResult[]): void {
  const failed = results.filter((result) => result.exitCode !== 0 || result.timedOut);
  if (failed.length > 0) {
    throw new Error(
      `Deterministic verification failed: ${failed
        .map((result) => `${result.argv.join(" ")} exit ${result.exitCode}`)
        .join("; ")}`,
    );
  }
}

export async function runImplementationAndVerification(
  options: ImplementationOptions,
): Promise<ImplementationResult> {
  const repoPath = resolve(options.repoPath);
  const roleEffort = options.model ? "medium" : "low";
  const state = await loadRunState(repoPath, options.runId);
  state.repairCount ??= 0;
  if (state.phase !== "harness-complete" || !state.testCommit || !state.branch) {
    throw new Error(`Run ${state.runId} is not ready for implementation`);
  }
  if (
    (await currentCommit(repoPath)) !== state.testCommit ||
    (await currentBranch(repoPath)) !== state.branch
  ) {
    throw new Error("Current Git branch or HEAD does not match the recorded T1 state");
  }
  await assertNoUntrackedFiles(repoPath);

  const { contract, decision, plan } = await loadSelectedPlanArtifacts(repoPath, state);
  const selectedPlanKey = parsePlanArtifactKey(decision.winnerPlanId);
  const harness = (await loadVerifiedArtifact(repoPath, state, "harness")).payload;
  const harnessCommandEvidence = (await loadVerifiedArtifact(repoPath, state, "commands")).payload;
  if (harness.testCommit !== state.testCommit) {
    throw new Error("Harness artifact does not match T1");
  }
  const protectedBefore = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
  if (!hashRecordsEqual(harness.protectedHashes, protectedBefore)) {
    throw new Error("Protected harness differs from its recorded T1 hashes");
  }
  const contractContext = state.contexts.find((entry) => entry.role === "contract");
  if (!contractContext?.turnId) throw new Error("Canonical C0 checkpoint is missing");

  const store = new ArtifactStore(repoPath, state.runId, state.baselineCommit);
  state.phase = "implementer";
  state.nextAction = "Wait for the one selected implementation.";
  await store.writeState(state);
  const client =
    options.clientFactory?.() ??
    new AppServerClient({ cwd: repoPath, ...(options.signal ? { signal: options.signal } : {}) });
  let implementationCommit = "";
  let commandResults: CommandResult[] = [];
  let verification: VerificationArtifact | undefined;

  try {
    await client.start();
    const implementationFork = await client.forkThread({
      threadId: contractContext.threadId,
      lastTurnId: contractContext.turnId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const implementerContext = startContext(
      "implementer",
      implementationFork.thread.id,
      contractContext.threadId,
      contractContext.turnId,
    );
    state.contexts.push(implementerContext);
    await store.writeState(state);
    const implementationTurn = await client.runTurn(
      implementationFork.thread.id,
      implementerPrompt(
        contract,
        plan,
        decision,
        state.testCommit,
        Object.keys(harness.protectedHashes),
      ),
      {
        cwd: repoPath,
        sandboxPolicy: workspaceWritePolicy(repoPath),
        effort: roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: implementationArtifactSchema,
      },
    );
    completeContext(implementerContext, implementationTurn.turnId);
    let implementation = parseRoleArtifact(
      implementationTurn.message,
      validateImplementationArtifact,
    );
    const planPaths = [...new Set(plan.files.map((file) => file.path))];
    let actualPaths = await validateImplementationChange({
      repoPath,
      fromCommit: state.testCommit,
      artifact: implementation,
      harness,
      planPaths,
      state,
    });

    implementationCommit = await commitPaths(
      repoPath,
      actualPaths,
      "feat: implement selected SafeChange plan",
    );
    state.implementationCommit = implementationCommit;
    const implementationStored = await store.writeArtifact(
      "implementation",
      "implementer",
      { ...implementation, implementationCommit, actualPaths },
      artifactInputs(state, "decision", "harness", selectedPlanKey),
    );
    state.artifacts.implementation = implementationStored.hash;
    state.phase = "deterministic-verification";
    await store.writeState(state);

    commandResults = await runProjectCommands(
      repoPath,
      harness,
      plan,
      options.sandboxCommands ?? false,
      state.baselineProtectedConfiguration ?? {},
      options.signal,
    );
    let commandsStored = await store.writeArtifact(
      "verificationCommands",
      "deterministic-runner",
      toCommandEvidence(commandResults),
      artifactInputs(state, "implementation"),
    );
    state.artifacts.verificationCommands = commandsStored.hash;
    await store.writeState(state);
    assertCommandsPassed(commandResults);

    const verify = async (
      role: Extract<RunPhase, "verifier" | "verifier:repair">,
    ): Promise<VerificationArtifact> => {
      const actualDiff = await diffFrom(repoPath, state.baselineCommit);
      state.phase = role;
      await store.writeState(state);
      const verifierFork = await client.forkThread({
        threadId: contractContext.threadId,
        lastTurnId: contractContext.turnId,
        cwd: repoPath,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const verifierContext = startContext(
        role,
        verifierFork.thread.id,
        contractContext.threadId,
        contractContext.turnId,
      );
      state.contexts.push(verifierContext);
      await store.writeState(state);
      const verifierTurn = await client.runTurn(
        verifierFork.thread.id,
        verifierPrompt({
          contract,
          plan,
          decision,
          baselineCommit: state.baselineCommit,
          testCommit: state.testCommit,
          implementationCommit,
          diff: actualDiff,
          commandResults: {
            harnessBaseline: harnessCommandEvidence,
            final: toCommandEvidence(commandResults),
          },
        }),
        {
          cwd: repoPath,
          sandboxPolicy: readOnlyPolicy,
          effort: roleEffort,
          ...(options.model ? { model: options.model } : {}),
          outputSchema: verificationArtifactSchema,
        },
      );
      completeContext(verifierContext, verifierTurn.turnId);
      return parseRoleArtifact(verifierTurn.message, validateVerificationArtifact);
    };

    verification = await verify("verifier");
    if (repairableVerification(verification, planPaths)) {
      const firstVerificationStored = await store.writeArtifact(
        "verificationAttempt1",
        "verifier",
        verification,
        artifactInputs(state, "implementation", "verificationCommands"),
      );
      state.artifacts.verificationAttempt1 = firstVerificationStored.hash;
      state.phase = "repair";
      state.repairCount = 1;
      state.nextAction = "Wait for the single bounded local repair.";
      await store.writeState(state);

      await assertNoUntrackedFiles(repoPath);

      await client.resumeThread({
        threadId: implementationFork.thread.id,
        cwd: repoPath,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      });
      const repairContext = startContext(
        "repair",
        implementationFork.thread.id,
        contractContext.threadId,
        implementerContext.turnId,
      );
      state.contexts.push(repairContext);
      await store.writeState(state);
      const repairTurn = await client.runTurn(
        implementationFork.thread.id,
        repairPrompt({
          contract,
          plan,
          verification,
          protectedPaths: Object.keys(harness.protectedHashes),
        }),
        {
          cwd: repoPath,
          sandboxPolicy: workspaceWritePolicy(repoPath),
          effort: roleEffort,
          ...(options.model ? { model: options.model } : {}),
          outputSchema: implementationArtifactSchema,
        },
      );
      completeContext(repairContext, repairTurn.turnId);
      implementation = parseRoleArtifact(repairTurn.message, validateImplementationArtifact);
      actualPaths = await validateImplementationChange({
        repoPath,
        fromCommit: implementationCommit,
        artifact: implementation,
        harness,
        planPaths,
        state,
      });
      implementationCommit = await commitPaths(
        repoPath,
        actualPaths,
        "fix: repair selected SafeChange implementation",
      );
      state.implementationCommit = implementationCommit;
      const repairStored = await store.writeArtifact(
        "repair",
        "repair",
        { ...implementation, implementationCommit, actualPaths },
        artifactInputs(state, "verificationAttempt1"),
      );
      state.artifacts.repair = repairStored.hash;
      commandResults = await runProjectCommands(
        repoPath,
        harness,
        plan,
        options.sandboxCommands ?? false,
        state.baselineProtectedConfiguration ?? {},
        options.signal,
      );
      commandsStored = await store.writeArtifact(
        "verificationCommandsRepair",
        "deterministic-runner",
        toCommandEvidence(commandResults),
        artifactInputs(state, "repair"),
      );
      state.artifacts.verificationCommandsRepair = commandsStored.hash;
      await store.writeState(state);
      assertCommandsPassed(commandResults);
      verification = await verify("verifier:repair");
    }

    const verificationStored = await store.writeArtifact(
      "verification",
      state.repairCount === 1 ? "verifier:repair" : "verifier",
      verification,
      state.repairCount === 1
        ? artifactInputs(state, "repair", "verificationCommandsRepair")
        : artifactInputs(state, "implementation", "verificationCommands"),
    );
    state.artifacts.verification = verificationStored.hash;
    const accepted = verificationAccepted(verification);
    state.phase = "verification-complete";
    state.status = accepted ? "RUNNING" : "FAILED";
    state.reason = verification.reason;
    state.nextAction = accepted
      ? "Apply the final deterministic release gate."
      : state.repairCount === 1
        ? "The bounded repair was exhausted; inspect findings and start a new plan."
        : "Verifier findings are not safely repairable within the selected scope.";
    await store.writeState(state);
    const reportPath = await store.writeText(
      "report.md",
      implementationReport(state, decision, toCommandEvidence(commandResults), verification),
    );
    return { implementationCommit, commands: commandResults, verification, accepted, reportPath };
  } catch (error) {
    if (state.status === "RUNNING") {
      state.status =
        options.sandboxCommands && error instanceof Error && /sandbox/i.test(error.message)
          ? "BLOCKED"
          : "FAILED";
    }
    state.phase = "implementation-failed";
    state.reason = error instanceof Error ? error.message : String(error);
    state.nextAction = "Inspect the branch and persisted artifacts; no cleanup was performed.";
    await store.writeState(state);
    throw error;
  } finally {
    await client.close();
  }
}
