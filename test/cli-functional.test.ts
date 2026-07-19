import assert from "node:assert/strict";
import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadVerifiedArtifact, type RunState } from "../src/artifacts.js";
import { runHarness } from "../src/harness.js";
import { runPlanning } from "../src/workflow.js";
import { fakeAppServerFactory } from "./support/app-server.js";
import {
  cliEnvironment,
  createFakeCodex,
  createFunctionalRepository,
  installPackedCli,
  type ProcessResult,
  protocolVersion,
  runSuccessful,
  spawnCaptured,
} from "./support/packed-cli.js";

interface JsonOutcome {
  runId: string;
  status: string;
  phase: string;
  reasonCode: string;
  model: string | null;
  statePath: string;
}

const root = process.cwd();
const fakeFixture = join(root, "dist", "test", "fixtures", "fake-app-server.js");

async function readState(path: string): Promise<RunState> {
  return JSON.parse(await readFile(path, "utf8")) as RunState;
}

async function waitFor(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function parseOutcome(result: ProcessResult): JsonOutcome {
  return JSON.parse(result.stdout) as JsonOutcome;
}

test("packed CLI preserves its functional workflow contracts", { timeout: 180_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-cli-functional-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const { changesafely } = await installPackedCli(root, temporaryRoot);
  const codexVersion = await protocolVersion(root);

  const environment = async (mode = "default"): Promise<NodeJS.ProcessEnv> =>
    cliEnvironment(await createFakeCodex(temporaryRoot, codexVersion, fakeFixture, mode));

  const repository = async (name: string): Promise<string> => {
    const path = join(temporaryRoot, name);
    await createFunctionalRepository(path);
    return path;
  };

  const prepareHarness = async (name: string): Promise<{ repoPath: string; runId: string }> => {
    const repoPath = await repository(name);
    const clientFactory = fakeAppServerFactory(repoPath);
    const planning = await runPlanning({
      repoPath,
      task: "Change the fixture value.",
      plannerCount: 1,
      clientFactory,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = (await environment()).PATH;
    try {
      await runHarness({
        repoPath,
        runId: planning.runId,
        clientFactory,
        sandboxCommands: true,
      });
    } finally {
      process.env.PATH = previousPath;
    }
    return { repoPath, runId: planning.runId };
  };

  await t.test("plan emits clean JSON and accepts an explicit Spark model", async () => {
    const repoPath = await repository("plan-json");
    const result = await spawnCaptured(
      changesafely,
      [
        "plan",
        "--task",
        "Change the fixture value.",
        "--plans",
        "1",
        "--model",
        "gpt-5.3-codex-spark",
        "--repo",
        repoPath,
        "--json",
      ],
      temporaryRoot,
      await environment("expect-workflow-spark"),
    ).result;
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "PLANNED");
    assert.equal(outcome.model, "gpt-5.3-codex-spark");
    assert.equal(await runSuccessful("git", ["status", "--porcelain=v1"], repoPath), "");
  });

  await t.test("full run reports human progress on stderr", async () => {
    const repoPath = await repository("full-run");
    const result = await spawnCaptured(
      changesafely,
      ["run", "--task", "Change the fixture value.", "--plans", "1", "--repo", repoPath],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Status: VERIFIED/);
    assert.match(result.stderr, /\[changesafely\].*discovery/);
    assert.match(result.stderr, /\[changesafely\].*verified/);
    assert.equal(await runSuccessful("git", ["rev-list", "--count", "HEAD"], repoPath), "3");
    const runId = result.stdout.match(/^Run: (.+)$/m)?.[1];
    assert.ok(runId);
    const state = await readState(join(repoPath, ".changesafely", "runs", runId, "state.json"));
    assert.equal(await runSuccessful("git", ["branch", "--show-current"], repoPath), state.branch);
    assert.equal(
      await runSuccessful(
        "git",
        ["diff", "--name-only", state.baselineCommit, state.testCommit],
        repoPath,
      ),
      "test/value.test.ts",
    );
    const harness = await loadVerifiedArtifact(repoPath, state, "harness");
    const verification = await loadVerifiedArtifact(repoPath, state, "verification");
    assert.ok(harness.payload.protectedHashes["test/value.test.ts"]);
    assert.equal(verification.payload.verdict, "accept");
    assert.match(
      await readFile(join(repoPath, ".changesafely", "runs", runId, "report.md"), "utf8"),
      /VERIFIED/,
    );
  });

  await t.test("canonicalizes a repository path alias across phases", async () => {
    if (process.platform === "win32") return;
    const repoPath = await repository("canonical-repository");
    const alias = join(temporaryRoot, "repository-alias");
    await symlink(repoPath, alias, "dir");
    const result = await spawnCaptured(
      changesafely,
      ["run", "--task", "Change the fixture value.", "--plans", "1", "--repo", alias, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(result.exitCode, 0);
    const state = await readState(parseOutcome(result).statePath);
    assert.equal(state.repoPath, await realpath(repoPath));
  });

  await t.test("resume continues from planning and harness boundaries", async () => {
    const planningRepo = await repository("resume-planning");
    const plan = await spawnCaptured(
      changesafely,
      [
        "plan",
        "--task",
        "Change the fixture value.",
        "--plans",
        "1",
        "--repo",
        planningRepo,
        "--json",
      ],
      temporaryRoot,
      await environment(),
    ).result;
    const planned = parseOutcome(plan);
    const planningResume = await spawnCaptured(
      changesafely,
      ["resume", "--run", planned.runId, "--repo", planningRepo, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(planningResume.exitCode, 0);
    assert.equal(parseOutcome(planningResume).status, "VERIFIED");

    const harness = await prepareHarness("resume-harness");
    const harnessResume = await spawnCaptured(
      changesafely,
      ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(harnessResume.exitCode, 0);
    assert.equal(parseOutcome(harnessResume).status, "VERIFIED");
  });

  await t.test("verifier rejection is explicit and persisted", async () => {
    const repoPath = await repository("verifier-reject");
    const result = await spawnCaptured(
      changesafely,
      ["run", "--task", "Change the fixture value.", "--plans", "1", "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment("verifier-reject"),
    ).result;
    assert.equal(result.exitCode, 1);
    const outcome = parseOutcome(result);
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reasonCode, "VERIFICATION_REJECTED");
    assert.equal((await readState(outcome.statePath)).status, "FAILED");
  });

  await t.test("status rejects corrupt and incompatible state without mutating it", async () => {
    const repoPath = await repository("incompatible-state");
    const plan = await spawnCaptured(
      changesafely,
      ["plan", "--task", "Change the fixture value.", "--plans", "1", "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    const outcome = parseOutcome(plan);
    const incompatible = `${JSON.stringify({ ...(await readState(outcome.statePath)), stateVersion: 2 }, null, 2)}\n`;
    await writeFile(outcome.statePath, incompatible, "utf8");
    const status = await spawnCaptured(
      changesafely,
      ["status", "--run", outcome.runId, "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(status.exitCode, 2);
    assert.equal(
      (JSON.parse(status.stdout) as { reasonCode: string }).reasonCode,
      "UNSUPPORTED_STATE_VERSION",
    );
    assert.equal(await readFile(outcome.statePath, "utf8"), incompatible);

    await writeFile(outcome.statePath, "{\n", "utf8");
    const corrupt = await spawnCaptured(
      changesafely,
      ["status", "--run", outcome.runId, "--repo", repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(corrupt.exitCode, 2);
    assert.equal(
      (JSON.parse(corrupt.stdout) as { reasonCode: string }).reasonCode,
      "INVALID_PERSISTED_JSON",
    );
    assert.equal(await readFile(outcome.statePath, "utf8"), "{\n");
  });

  for (const [signal, expectedExit] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    await t.test(`${signal} preserves T1 and permits a safe resume`, async () => {
      if (process.platform === "win32") return;
      const harness = await prepareHarness(`interrupt-${signal.toLowerCase()}`);
      const processRun = spawnCaptured(
        changesafely,
        ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
        temporaryRoot,
        await environment("delay-implementer"),
      );
      await waitFor(join(harness.repoPath, ".changesafely", "test-implementer-started"));
      processRun.child.kill(signal);
      const interrupted = await processRun.result;
      assert.equal(interrupted.exitCode, expectedExit);
      const interruptedOutcome = parseOutcome(interrupted);
      assert.equal(interruptedOutcome.status, "RUNNING");
      assert.equal(interruptedOutcome.phase, "harness-complete");
      assert.equal(interruptedOutcome.reasonCode, "INTERRUPTED");
      const state = await readState(interruptedOutcome.statePath);
      assert.equal(
        await runSuccessful("git", ["rev-parse", "HEAD"], harness.repoPath),
        state.testCommit,
      );
      assert.equal(await runSuccessful("git", ["status", "--porcelain=v1"], harness.repoPath), "");
      await assert.rejects(access(join(harness.repoPath, ".git", "changesafely.lock")));

      const resumed = await spawnCaptured(
        changesafely,
        ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
        temporaryRoot,
        await environment(),
      ).result;
      assert.equal(resumed.exitCode, 0);
      assert.equal(parseOutcome(resumed).status, "VERIFIED");
    });
  }

  await t.test("total timeout preserves T1 and permits a safe resume", async () => {
    const harness = await prepareHarness("timeout");
    const timed = await spawnCaptured(
      changesafely,
      ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--timeout", "1", "--json"],
      temporaryRoot,
      await environment("delay-implementer"),
    ).result;
    assert.equal(timed.exitCode, 2);
    const outcome = parseOutcome(timed);
    assert.equal(outcome.status, "RUNNING");
    assert.equal(outcome.phase, "harness-complete");
    assert.equal(outcome.reasonCode, "WORKFLOW_TIMEOUT");
    const resumed = await spawnCaptured(
      changesafely,
      ["resume", "--run", harness.runId, "--repo", harness.repoPath, "--json"],
      temporaryRoot,
      await environment(),
    ).result;
    assert.equal(resumed.exitCode, 0);
    assert.equal(parseOutcome(resumed).status, "VERIFIED");
  });
});
