import { basename, resolve } from "node:path";
import {
  ArtifactStore,
  loadRunState,
  loadVerifiedArtifact,
  type RunState,
  type RunStatus,
} from "./artifacts.js";
import {
  acquireRepositoryLock,
  changedPaths,
  currentBranch,
  currentCommit,
  hashFiles,
  inspectBaseline,
  isAncestor,
} from "./git.js";
import { runHarness } from "./harness.js";
import { runImplementationAndVerification } from "./implementation.js";
import { implementationReport } from "./report.js";
import type { CommandEvidence } from "./runner.js";
import {
  type DecisionArtifact,
  type HarnessArtifact,
  type VerificationArtifact,
  validateChangeContract,
  validateCommandEvidenceList,
  validateDecisionArtifact,
  validateDetailedPlan,
  validateEvidenceArtifact,
  validatePlanEligibilityList,
  validateStoredHarnessArtifact,
  validateStoredImplementationArtifact,
  validateVerificationArtifact,
} from "./schemas.js";
import { runPlanning } from "./workflow.js";

interface StoredHarness extends HarnessArtifact {
  protectedHashes: Record<string, string>;
  testCommit: string;
}

export interface FullRunOptions {
  repoPath: string;
  task: string;
  plannerCount: number;
  model?: string;
  signal?: AbortSignal;
}

export interface FullRunResult {
  runId: string;
  status: RunStatus;
  reportPath: string;
  branch: string;
}

function hashesMatch(expected: Record<string, string>, actual: Record<string, string>): boolean {
  return Object.keys(expected).every((path) => expected[path] === actual[path]);
}

function artifactPath(name: string): string {
  if (/^plan-\d+$/.test(name)) return `plans/${name}.json`;
  const paths: Record<string, string> = {
    evidence: "evidence.json",
    contract: "contract.json",
    eligibility: "eligibility.json",
    decision: "decision.json",
    harness: "harness.json",
    commands: "commands.json",
    implementation: "implementation.json",
    verificationCommands: "verification-commands.json",
    verificationAttempt1: "verification-attempt-1.json",
    repair: "repair.json",
    verificationCommandsRepair: "verification-commands-repair.json",
    verification: "verification.json",
  };
  const path = paths[name];
  if (!path) throw new Error(`Unknown persisted artifact key: ${name}`);
  return path;
}

function validateArtifactPayload(name: string, payload: unknown): void {
  if (name === "evidence") validateEvidenceArtifact(payload);
  else if (name === "contract") validateChangeContract(payload);
  else if (/^plan-\d+$/.test(name)) validateDetailedPlan(payload);
  else if (name === "eligibility") validatePlanEligibilityList(payload);
  else if (name === "decision") validateDecisionArtifact(payload);
  else if (name === "harness") validateStoredHarnessArtifact(payload);
  else if (name === "implementation" || name === "repair") {
    validateStoredImplementationArtifact(payload);
  } else if (
    name === "commands" ||
    name === "verificationCommands" ||
    name === "verificationCommandsRepair"
  ) {
    validateCommandEvidenceList(payload);
  } else if (name === "verification" || name === "verificationAttempt1") {
    validateVerificationArtifact(payload);
  }
}

function validateLineage(state: RunState): void {
  const discovery = state.contexts.find((entry) => entry.role === "discovery");
  const contract = state.contexts.find((entry) => entry.role === "contract");
  if (
    !discovery?.turnId ||
    !contract?.turnId ||
    discovery.parentThreadId !== null ||
    contract.parentThreadId !== null ||
    discovery.threadId === contract.threadId
  ) {
    throw new Error("D0/C0 root-thread lineage is invalid");
  }
  for (const entry of state.contexts) {
    if (
      entry.role.startsWith("planner:") ||
      ["judge", "test-author", "implementer", "verifier", "verifier:repair"].includes(entry.role)
    ) {
      if (
        entry.parentThreadId !== contract.threadId ||
        entry.checkpointTurnId !== contract.turnId
      ) {
        throw new Error(`Role lineage is invalid for ${entry.role}`);
      }
    }
  }
  const repair = state.contexts.find((entry) => entry.role === "repair");
  const implementer = state.contexts.find((entry) => entry.role === "implementer");
  if (
    repair &&
    (!implementer ||
      repair.threadId !== implementer.threadId ||
      repair.parentThreadId !== contract.threadId)
  ) {
    throw new Error("Repair did not resume the original Implementer thread");
  }
  for (const correction of state.contexts.filter((entry) =>
    entry.role.startsWith("planner-correction:"),
  )) {
    const planId = correction.role.slice("planner-correction:".length);
    const planner = state.contexts.find((entry) => entry.role === `planner:${planId}`);
    if (
      !planner?.turnId ||
      correction.threadId !== planner.threadId ||
      correction.parentThreadId !== contract.threadId ||
      correction.checkpointTurnId !== planner.turnId
    ) {
      throw new Error(`Planner correction lineage is invalid for ${planId}`);
    }
  }
  const judgeCorrection = state.contexts.find((entry) => entry.role === "judge-correction");
  const judge = state.contexts.find((entry) => entry.role === "judge");
  if (
    judgeCorrection &&
    (!judge?.turnId ||
      judgeCorrection.threadId !== judge.threadId ||
      judgeCorrection.parentThreadId !== contract.threadId ||
      judgeCorrection.checkpointTurnId !== judge.turnId)
  ) {
    throw new Error("Judge correction lineage is invalid");
  }
}

export async function validateResumeBoundary(repoPath: string, runId: string): Promise<RunState> {
  const state = await loadRunState(repoPath, runId);
  state.repairCount ??= 0;
  state.model ??= "";
  state.baselineProtectedConfiguration ??= {};
  if (state.repoPath !== repoPath || state.runId !== runId || state.repairCount > 1) {
    throw new Error("Run state identity or repair bound is invalid");
  }
  for (const name of Object.keys(state.artifacts)) {
    const envelope = await loadVerifiedArtifact<unknown>(repoPath, state, name, artifactPath(name));
    validateArtifactPayload(name, envelope.payload);
  }
  validateLineage(state);

  const snapshot = await inspectBaseline(repoPath);
  if (state.phase === "planning-complete") {
    if (
      snapshot.commit !== state.baselineCommit ||
      snapshot.fingerprint !== state.baselineFingerprint ||
      state.branch ||
      state.testCommit ||
      state.implementationCommit
    ) {
      throw new Error("Planning resume boundary no longer matches B0");
    }
    return state;
  }
  if (!state.branch || snapshot.branch !== state.branch) {
    throw new Error("Resume branch does not match persisted state");
  }
  if (
    JSON.stringify(snapshot.protectedConfiguration) !==
    JSON.stringify(state.baselineProtectedConfiguration)
  ) {
    throw new Error("Protected configuration metadata changed before resume");
  }
  const expectedHead =
    state.phase === "harness-complete" ? state.testCommit : state.implementationCommit;
  if (!expectedHead || snapshot.commit !== expectedHead) {
    throw new Error("Resume HEAD does not match the completed phase commit");
  }
  if (!(await isAncestor(repoPath, state.baselineCommit, expectedHead))) {
    throw new Error("Recorded phase commit does not descend from B0");
  }
  const harness = (
    await loadVerifiedArtifact<StoredHarness>(repoPath, state, "harness", "harness.json")
  ).payload;
  if (harness.testCommit !== state.testCommit) {
    throw new Error("T1 artifact does not match persisted state");
  }
  const protectedActual = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
  if (!hashesMatch(harness.protectedHashes, protectedActual)) {
    throw new Error("Protected T1 hashes changed before resume");
  }
  return state;
}

async function finalizeVerifiedRun(repoPath: string, runId: string): Promise<FullRunResult> {
  const state = await loadRunState(repoPath, runId);
  state.repairCount ??= 0;
  state.model ??= "";
  state.baselineProtectedConfiguration ??= {};
  const store = new ArtifactStore(repoPath, runId, state.baselineCommit);
  try {
    await validateResumeBoundary(repoPath, runId);
    if (state.phase !== "verification-complete" || !state.implementationCommit) {
      throw new Error(`Run ${runId} has not completed independent verification`);
    }
    if (
      (await currentBranch(repoPath)) !== state.branch ||
      (await currentCommit(repoPath)) !== state.implementationCommit
    ) {
      throw new Error("Current branch or HEAD differs from recorded I1");
    }
    await inspectBaseline(repoPath);
    const harness = (
      await loadVerifiedArtifact<StoredHarness>(repoPath, state, "harness", "harness.json")
    ).payload;
    const protectedActual = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
    if (!hashesMatch(harness.protectedHashes, protectedActual)) {
      throw new Error("Protected T1 hashes changed before release gate");
    }
    const baselineCommands = (
      await loadVerifiedArtifact<CommandEvidence[]>(repoPath, state, "commands", "commands.json")
    ).payload;
    const finalCommandArtifact =
      state.repairCount === 1
        ? ["verificationCommandsRepair", "verification-commands-repair.json"]
        : ["verificationCommands", "verification-commands.json"];
    const verificationCommands = (
      await loadVerifiedArtifact<CommandEvidence[]>(
        repoPath,
        state,
        finalCommandArtifact[0] ?? "",
        finalCommandArtifact[1] ?? "",
      )
    ).payload;
    const allCommands = [...baselineCommands, ...verificationCommands];
    if (
      allCommands.length === 0 ||
      allCommands.some(
        (command) => !command.sandboxed || command.timedOut || command.exitCode === null,
      )
    ) {
      throw new Error("Release requires complete network-disabled sandbox command evidence");
    }
    if (
      verificationCommands.some((command) => command.exitCode !== 0) ||
      baselineCommands.some(
        (command) => command.exitCode === 0 && harness.expectedBaselineOutcome === "fail",
      )
    ) {
      throw new Error("Recorded command outcomes do not satisfy the harness and final checks");
    }
    const verification = (
      await loadVerifiedArtifact<VerificationArtifact>(
        repoPath,
        state,
        "verification",
        "verification.json",
      )
    ).payload;
    const accepted =
      verification.verdict === "accept" &&
      verification.contractFulfilled &&
      verification.invariantsPreserved &&
      verification.scopeConformant &&
      verification.evidenceSufficient &&
      !verification.findings.some((finding) => finding.severity === "error");
    if (!accepted) throw new Error("Independent Verifier did not accept the change");

    const releasePaths = await changedPaths(repoPath, state.baselineCommit);
    const forbidden = releasePaths.filter(
      (path) =>
        ["AGENTS.md", "package.json", "package-lock.json"].includes(basename(path)) ||
        /(?:^|\/)(?:migrations?|secrets?)(?:\/|$)/i.test(path),
    );
    if (forbidden.length > 0) {
      throw new Error(`Release diff contains approval-sensitive paths: ${forbidden.join(", ")}`);
    }

    const decision = (
      await loadVerifiedArtifact<DecisionArtifact>(repoPath, state, "decision", "decision.json")
    ).payload;
    state.status = "VERIFIED";
    state.phase = "verified";
    state.reason = verification.reason;
    state.nextAction =
      "Review the SafeChange branch and merge it through the normal repository process.";
    await store.writeState(state);
    const reportPath = await store.writeText(
      "report.md",
      implementationReport(state, decision, verificationCommands, verification),
    );
    return { runId, status: state.status, reportPath, branch: state.branch };
  } catch (error) {
    state.status = "BLOCKED";
    state.phase = "release-gate-blocked";
    state.reason = error instanceof Error ? error.message : String(error);
    state.nextAction = "Inspect release gate evidence and start a new run if artifacts are stale.";
    await store.writeState(state);
    throw error;
  }
}

async function continueFromPlanning(
  repoPath: string,
  runId: string,
  model?: string,
  signal?: AbortSignal,
): Promise<FullRunResult> {
  try {
    await runHarness({
      repoPath,
      runId,
      sandboxCommands: true,
      ...(model ? { model } : {}),
      ...(signal ? { signal } : {}),
    });
    return await continueFromHarness(repoPath, runId, model, signal);
  } catch {
    return persistedResult(repoPath, runId);
  }
}

async function continueFromHarness(
  repoPath: string,
  runId: string,
  model?: string,
  signal?: AbortSignal,
): Promise<FullRunResult> {
  try {
    const implementation = await runImplementationAndVerification({
      repoPath,
      runId,
      sandboxCommands: true,
      ...(model ? { model } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!implementation.accepted) {
      return persistedResult(repoPath, runId, implementation.reportPath);
    }
    return await finalizeVerifiedRun(repoPath, runId);
  } catch {
    return persistedResult(repoPath, runId);
  }
}

async function persistedResult(
  repoPath: string,
  runId: string,
  reportPath = resolve(repoPath, ".safechange", "runs", runId, "report.md"),
): Promise<FullRunResult> {
  const state = await loadRunState(repoPath, runId);
  return { runId, status: state.status, reportPath, branch: state.branch };
}

async function withRepositoryWriteLock<T>(
  repoPath: string,
  runId: string,
  action: () => Promise<T>,
): Promise<T> {
  const lock = await acquireRepositoryLock(repoPath, runId);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

export async function runFullWorkflow(options: FullRunOptions): Promise<FullRunResult> {
  const repoPath = resolve(options.repoPath);
  const planning = await runPlanning({
    repoPath,
    task: options.task,
    plannerCount: options.plannerCount,
    parallelPlanners: true,
    ...(options.model ? { model: options.model } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (planning.status !== "PLANNED") {
    return {
      runId: planning.runId,
      status: planning.status,
      reportPath: planning.reportPath,
      branch: "",
    };
  }
  return withRepositoryWriteLock(repoPath, planning.runId, () =>
    continueFromPlanning(repoPath, planning.runId, options.model, options.signal),
  );
}

export async function resumeRun(
  repoPathInput: string,
  runId: string,
  signal?: AbortSignal,
): Promise<FullRunResult> {
  const repoPath = resolve(repoPathInput);
  return withRepositoryWriteLock(repoPath, runId, async () => {
    const state = await validateResumeBoundary(repoPath, runId);
    const model = state.model || undefined;
    if (state.phase === "planning-complete" && state.status === "PLANNED") {
      return continueFromPlanning(repoPath, runId, model, signal);
    }
    if (state.phase === "harness-complete" && state.status === "RUNNING") {
      return continueFromHarness(repoPath, runId, model, signal);
    }
    if (state.phase === "verification-complete" && state.status === "RUNNING") {
      try {
        return await finalizeVerifiedRun(repoPath, runId);
      } catch {
        return persistedResult(repoPath, runId);
      }
    }
    if (state.phase === "verified" && state.status === "VERIFIED") {
      return {
        runId,
        status: state.status,
        reportPath: resolve(repoPath, ".safechange", "runs", runId, "report.md"),
        branch: state.branch,
      };
    }
    throw new Error(
      `Run ${runId} cannot resume safely from phase ${state.phase} with status ${state.status}`,
    );
  });
}
