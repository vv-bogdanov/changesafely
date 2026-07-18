import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { AppServerClient } from "./app-server/client.js";
import {
  ArtifactStore,
  loadArtifact,
  loadRunState,
  type ContextEntry,
} from "./artifacts.js";
import {
  changedPaths,
  commitPaths,
  currentBranch,
  currentCommit,
  diffFrom,
  hashFiles,
} from "./git.js";
import { implementerPrompt, verifierPrompt } from "./prompts.js";
import { implementationReport } from "./report.js";
import { runCommand, type CommandResult } from "./runner.js";
import {
  implementationArtifactSchema,
  verificationArtifactSchema,
  type ChangeContract,
  type DecisionArtifact,
  type DetailedPlan,
  type HarnessArtifact,
  type ImplementationArtifact,
  type VerificationArtifact,
  validateImplementationArtifact,
  validateVerificationArtifact,
} from "./schemas.js";

interface StoredHarness extends HarnessArtifact {
  protectedHashes: Record<string, string>;
  testCommit: string;
}

export interface ImplementationOptions {
  repoPath: string;
  runId: string;
  clientFactory?: () => AppServerClient;
}

export interface ImplementationResult {
  implementationCommit: string;
  commands: CommandResult[];
  verification: VerificationArtifact;
  accepted: boolean;
  reportPath: string;
}

function parseStructured<T>(message: string, validate: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error(`Role returned invalid JSON: ${message.slice(0, 300)}`);
  }
  return validate(value);
}

function pathMatches(path: string, allowed: string[]): boolean {
  const candidate = path.replace(/^\.\//, "");
  return allowed.some((raw) => {
    const prefix = raw.replace(/^\.\//, "").replace(/\/$/, "");
    return prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`);
  });
}

function sameHashes(
  expected: Record<string, string>,
  actual: Record<string, string>,
): boolean {
  return Object.keys(expected).every((path) => expected[path] === actual[path]);
}

async function projectCommands(repoPath: string, harness: StoredHarness): Promise<string[][]> {
  const commands: string[][] = [harness.targetedCommand.argv];
  const packageJson = JSON.parse(await readFile(resolve(repoPath, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const name of ["test", "typecheck", "build"]) {
    if (packageJson.scripts?.[name]) {
      commands.push(name === "test" ? ["npm", "test"] : ["npm", "run", name]);
    }
  }
  const seen = new Set<string>();
  return commands.filter((argv) => {
    const key = JSON.stringify(argv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runImplementationAndVerification(
  options: ImplementationOptions,
): Promise<ImplementationResult> {
  const repoPath = resolve(options.repoPath);
  const state = await loadRunState(repoPath, options.runId);
  if (state.phase !== "harness-complete" || !state.testCommit || !state.branch) {
    throw new Error(`Run ${state.runId} is not ready for implementation`);
  }
  if (
    (await currentCommit(repoPath)) !== state.testCommit ||
    (await currentBranch(repoPath)) !== state.branch
  ) {
    throw new Error("Current Git branch or HEAD does not match the recorded T1 state");
  }

  const contract = (
    await loadArtifact<ChangeContract>(repoPath, state.runId, "contract.json")
  ).payload;
  const decision = (
    await loadArtifact<DecisionArtifact>(repoPath, state.runId, "decision.json")
  ).payload;
  const plan = (
    await loadArtifact<DetailedPlan>(
      repoPath,
      state.runId,
      `plans/${decision.winnerPlanId}.json`,
    )
  ).payload;
  const harness = (
    await loadArtifact<StoredHarness>(repoPath, state.runId, "harness.json")
  ).payload;
  if (harness.testCommit !== state.testCommit) {
    throw new Error("Harness artifact does not match T1");
  }
  const protectedBefore = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
  if (!sameHashes(harness.protectedHashes, protectedBefore)) {
    throw new Error("Protected harness differs from its recorded T1 hashes");
  }
  const contractContext = state.contexts.find((entry) => entry.role === "contract");
  if (!contractContext?.turnId) throw new Error("Canonical C0 checkpoint is missing");

  const store = new ArtifactStore(repoPath, state.runId, state.baselineCommit);
  state.phase = "implementer";
  state.nextAction = "Wait for the one selected implementation.";
  await store.writeState(state);
  const client = options.clientFactory?.() ?? new AppServerClient({ cwd: repoPath });
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
    const implementerContext: ContextEntry = {
      role: "implementer",
      threadId: implementationFork.thread.id,
      parentThreadId: contractContext.threadId,
      checkpointTurnId: contractContext.turnId,
      turnId: null,
      status: "started",
    };
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
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [repoPath],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        outputSchema: implementationArtifactSchema,
      },
    );
    implementerContext.turnId = implementationTurn.turnId;
    implementerContext.status = "completed";
    const implementation = parseStructured<ImplementationArtifact>(
      implementationTurn.message,
      validateImplementationArtifact,
    );
    const actualPaths = await changedPaths(repoPath, state.testCommit);
    if (actualPaths.length === 0) throw new Error("Implementer made no production change");
    const protectedAfter = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
    if (!sameHashes(harness.protectedHashes, protectedAfter)) {
      throw new Error("Implementer changed a protected T1 path");
    }
    const planPaths = [...new Set(plan.files.map((file) => file.path))];
    const outsidePlan = actualPaths.filter((path) => !pathMatches(path, planPaths));
    if (outsidePlan.length > 0) {
      state.status = "REPLAN_REQUIRED";
      throw new Error(`Implementation expanded beyond selected plan: ${outsidePlan.join(", ")}`);
    }
    const protectedNames = new Set(["AGENTS.md", "package.json", "package-lock.json"]);
    const sensitive = actualPaths.filter(
      (path) =>
        protectedNames.has(basename(path)) ||
        /(?:^|\/)(?:migrations?|secrets?)(?:\/|$)/i.test(path),
    );
    if (sensitive.length > 0) {
      state.status = "HUMAN_DECISION_REQUIRED";
      throw new Error(`Implementation changed approval-sensitive paths: ${sensitive.join(", ")}`);
    }
    const declaredPaths = new Set(implementation.changedPaths);
    const omittedPaths = actualPaths.filter((path) => !declaredPaths.has(path));
    if (omittedPaths.length > 0) {
      throw new Error(`Implementation artifact omitted changed paths: ${omittedPaths.join(", ")}`);
    }

    implementationCommit = await commitPaths(
      repoPath,
      actualPaths,
      "feat: implement selected SafeChange plan",
    );
    state.implementationCommit = implementationCommit;
    const implementationStored = await store.writeArtifact(
      "implementation.json",
      "implementer",
      { ...implementation, implementationCommit, actualPaths },
      [state.artifacts.decision ?? "", state.artifacts.harness ?? ""],
    );
    state.artifacts.implementation = implementationStored.hash;
    state.phase = "deterministic-verification";
    await store.writeState(state);

    for (const argv of await projectCommands(repoPath, harness)) {
      commandResults.push(await runCommand(argv, repoPath));
    }
    const failed = commandResults.filter(
      (result) => result.exitCode !== 0 || result.timedOut,
    );
    const protectedFinal = await hashFiles(repoPath, Object.keys(harness.protectedHashes));
    if (!sameHashes(harness.protectedHashes, protectedFinal)) {
      throw new Error("Protected T1 paths changed during deterministic verification");
    }
    const commandsStored = await store.writeArtifact(
      "verification-commands.json",
      "deterministic-runner",
      commandResults,
      [implementationStored.hash],
    );
    state.artifacts.verificationCommands = commandsStored.hash;
    if (failed.length > 0) {
      throw new Error(
        `Deterministic verification failed: ${failed
          .map((result) => `${result.argv.join(" ")} exit ${result.exitCode}`)
          .join("; ")}`,
      );
    }

    const actualDiff = await diffFrom(repoPath, state.baselineCommit);
    state.phase = "verifier";
    await store.writeState(state);
    const verifierFork = await client.forkThread({
      threadId: contractContext.threadId,
      lastTurnId: contractContext.turnId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const verifierContext: ContextEntry = {
      role: "verifier",
      threadId: verifierFork.thread.id,
      parentThreadId: contractContext.threadId,
      checkpointTurnId: contractContext.turnId,
      turnId: null,
      status: "started",
    };
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
        commandResults,
      }),
      {
        cwd: repoPath,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: verificationArtifactSchema,
      },
    );
    verifierContext.turnId = verifierTurn.turnId;
    verifierContext.status = "completed";
    verification = parseStructured<VerificationArtifact>(
      verifierTurn.message,
      validateVerificationArtifact,
    );
    const verificationStored = await store.writeArtifact(
      "verification.json",
      "verifier",
      verification,
      [implementationStored.hash, commandsStored.hash],
    );
    state.artifacts.verification = verificationStored.hash;
    const accepted =
      verification.verdict === "accept" &&
      verification.contractFulfilled &&
      verification.invariantsPreserved &&
      verification.scopeConformant &&
      verification.evidenceSufficient &&
      !verification.findings.some((finding) => finding.severity === "error");
    state.phase = "verification-complete";
    state.status = accepted ? "RUNNING" : "FAILED";
    state.reason = verification.reason;
    state.nextAction = accepted
      ? "Apply Stage 4 security, recovery, and release gates before VERIFIED."
      : "Inspect verifier findings; replan if the required fix exceeds selected scope.";
    await store.writeState(state);
    const reportPath = await store.writeText(
      "report.md",
      implementationReport(state, decision, commandResults, verification),
    );
    return { implementationCommit, commands: commandResults, verification, accepted, reportPath };
  } catch (error) {
    if (state.status === "RUNNING") state.status = "FAILED";
    state.phase = "implementation-failed";
    state.reason = error instanceof Error ? error.message : String(error);
    state.nextAction = "Inspect the branch and persisted artifacts; no cleanup was performed.";
    await store.writeState(state);
    throw error;
  } finally {
    await client.close();
  }
}
