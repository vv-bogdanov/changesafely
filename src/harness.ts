import { resolve } from "node:path";
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
  createSafeChangeBranch,
  hashFiles,
  inspectBaseline,
} from "./git.js";
import { testAuthorPrompt } from "./prompts.js";
import { runCommand, type CommandResult } from "./runner.js";
import {
  harnessArtifactSchema,
  type ChangeContract,
  type DecisionArtifact,
  type DetailedPlan,
  type HarnessArtifact,
  validateHarnessArtifact,
} from "./schemas.js";

export interface HarnessOptions {
  repoPath: string;
  runId: string;
  clientFactory?: () => AppServerClient;
}

export interface HarnessResult {
  branch: string;
  testCommit: string;
  protectedHashes: Record<string, string>;
  command: CommandResult;
  harness: HarnessArtifact;
}

function parseHarness(message: string): HarnessArtifact {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error(`Test Author returned invalid JSON: ${message.slice(0, 300)}`);
  }
  return validateHarnessArtifact(value);
}

function isTestPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.some((part) => ["test", "tests", "__tests__", "fixtures"].includes(part)) ||
    /(?:\.test\.|\.spec\.)/.test(path)
  );
}

function matchesAllowed(path: string, allowed: string[]): boolean {
  return allowed.some((raw) => {
    const prefix = raw.replace(/^\.\//, "").replace(/\/$/, "");
    const candidate = path.replace(/^\.\//, "");
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  });
}

function selectedTestPaths(plan: DetailedPlan): string[] {
  const paths = new Set<string>();
  for (const file of plan.files) if (isTestPath(file.path)) paths.add(file.path);
  for (const step of plan.steps) {
    for (const path of step.paths) if (isTestPath(path)) paths.add(path);
  }
  if (paths.size === 0) throw new Error("Selected plan does not declare a test path");
  return [...paths];
}

export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const repoPath = resolve(options.repoPath);
  const state = await loadRunState(repoPath, options.runId);
  if (state.status !== "PLANNED") {
    throw new Error(`Run ${state.runId} is not ready for harness creation: ${state.status}`);
  }
  const baseline = await inspectBaseline(repoPath);
  if (
    baseline.commit !== state.baselineCommit ||
    baseline.fingerprint !== state.baselineFingerprint
  ) {
    state.status = "BASELINE_CHANGED";
    state.reason = "Baseline no longer matches planning artifacts.";
    state.nextAction = "Start a new planning run from the current baseline.";
    const failedStore = new ArtifactStore(repoPath, state.runId, state.baselineCommit);
    await failedStore.writeState(state);
    throw new Error(state.reason);
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
  const allowedTestPaths = selectedTestPaths(plan);
  const contractContext = state.contexts.find((entry) => entry.role === "contract");
  if (!contractContext?.turnId) throw new Error("Canonical C0 checkpoint is missing");

  const store = new ArtifactStore(repoPath, state.runId, state.baselineCommit);
  const branch = await createSafeChangeBranch(baseline, state.runId);
  state.branch = branch;
  state.phase = "test-author";
  state.status = "RUNNING";
  state.nextAction = "Wait for the protected safety harness.";
  await store.writeState(state);

  const client = options.clientFactory?.() ?? new AppServerClient({ cwd: repoPath });
  try {
    await client.start();
    const fork = await client.forkThread({
      threadId: contractContext.threadId,
      lastTurnId: contractContext.turnId,
      cwd: repoPath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const roleContext: ContextEntry = {
      role: "test-author",
      threadId: fork.thread.id,
      parentThreadId: contractContext.threadId,
      checkpointTurnId: contractContext.turnId,
      turnId: null,
      status: "started",
    };
    state.contexts.push(roleContext);
    await store.writeState(state);
    const turn = await client.runTurn(
      fork.thread.id,
      testAuthorPrompt(contract, plan, decision, allowedTestPaths),
      {
        cwd: repoPath,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [repoPath],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        outputSchema: harnessArtifactSchema,
      },
    );
    roleContext.turnId = turn.turnId;
    roleContext.status = "completed";
    const harness = parseHarness(turn.message);
    const paths = await changedPaths(repoPath, "HEAD");
    if (paths.length === 0) throw new Error("Test Author did not create a safety harness");
    const unexpected = paths.filter(
      (path) => !isTestPath(path) || !matchesAllowed(path, allowedTestPaths),
    );
    if (unexpected.length > 0) {
      throw new Error(`Test Author changed paths outside test scope: ${unexpected.join(", ")}`);
    }
    const declared = new Set(harness.protectedPaths);
    const undeclared = paths.filter((path) => !declared.has(path));
    if (undeclared.length > 0) {
      throw new Error(`Harness omitted protected paths: ${undeclared.join(", ")}`);
    }
    const changedContents = (
      await Promise.all(paths.map((path) => readFile(resolve(repoPath, path), "utf8")))
    ).join("\n");
    if (/\.(?:skip|only)\s*\(/.test(changedContents)) {
      throw new Error("Harness contains forbidden skip/only usage");
    }

    const command = await runCommand(harness.targetedCommand.argv, repoPath);
    const combinedOutput = `${command.stdout}\n${command.stderr}`;
    const expectedPass = harness.expectedBaselineOutcome === "pass";
    if ((command.exitCode === 0) !== expectedPass) {
      throw new Error(
        `Harness baseline outcome mismatch: expected ${harness.expectedBaselineOutcome}, exit ${command.exitCode}; output: ${combinedOutput.slice(-1000)}`,
      );
    }
    if (
      harness.expectedBaselineOutcome === "fail" &&
      !/(?:failing tests|not ok|AssertionError|Error \[|fail\s+[1-9])/i.test(combinedOutput)
    ) {
      throw new Error(
        `Harness exited non-zero without an observable test-failure signal: ${combinedOutput.slice(-1000)}`,
      );
    }

    const testCommit = await commitPaths(
      repoPath,
      paths,
      "test: add SafeChange safety harness",
    );
    const protectedHashes = await hashFiles(repoPath, paths);
    const harnessStored = await store.writeArtifact(
      "harness.json",
      "test-author",
      { ...harness, protectedHashes, testCommit },
      [state.artifacts.contract ?? "", state.artifacts.decision ?? ""],
    );
    state.artifacts.harness = harnessStored.hash;
    const commandStored = await store.writeArtifact(
      "commands.json",
      "deterministic-runner",
      [command],
      [harnessStored.hash],
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
      throw new Error("Git HEAD does not match the recorded safety harness commit");
    }
    return { branch, testCommit, protectedHashes, command, harness };
  } catch (error) {
    state.status = "FAILED";
    state.phase = "test-author-failed";
    state.reason = error instanceof Error ? error.message : String(error);
    state.nextAction = "Inspect the SafeChange branch and Test Author diff; no cleanup was performed.";
    await store.writeState(state);
    throw error;
  } finally {
    await client.close();
  }
}
