import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AppServerClient } from "../src/app-server/client.js";
import type { RunState } from "../src/artifacts.js";
import { PreflightError } from "../src/git.js";
import { runHarness } from "../src/harness.js";
import { runPlanning } from "../src/workflow.js";

const execFileAsync = promisify(execFile);

async function fixtureRepo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "safechange-plan-"));
  await mkdir(join(path, "src"));
  await writeFile(join(path, "AGENTS.md"), "# Fixture\n", "utf8");
  await writeFile(
    join(path, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(path, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "SafeChange Test"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "test@safechange.local"], { cwd: path });
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "fixture baseline"], { cwd: path });
  return path;
}

test("runs D0 and C0 as roots and decision roles as C0 forks", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");

  const result = await runPlanning({
    repoPath,
    task: "Add the requested fixture behavior without changing the public API.",
    plannerCount: 3,
    clientFactory: () =>
      new AppServerClient({
        command: process.execPath,
        args: [fixture],
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      }),
  });

  assert.equal(result.status, "PLANNED");
  assert.equal(result.decision?.winnerPlanId, "plan-1");
  const state = JSON.parse(
    await readFile(join(result.runPath, "state.json"), "utf8"),
  ) as RunState;
  const discovery = state.contexts.find((entry) => entry.role === "discovery");
  const contract = state.contexts.find((entry) => entry.role === "contract");
  assert.ok(discovery);
  assert.ok(contract);
  assert.notEqual(discovery.threadId, contract.threadId);
  assert.equal(discovery.parentThreadId, null);
  assert.equal(contract.parentThreadId, null);

  const decisionRoles = state.contexts.filter(
    (entry) => entry.role.startsWith("planner:") || entry.role === "judge",
  );
  assert.equal(decisionRoles.length, 4);
  for (const entry of decisionRoles) {
    assert.equal(entry.parentThreadId, contract.threadId);
    assert.equal(entry.checkpointTurnId, contract.turnId);
  }

  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no"],
    { cwd: repoPath },
  );
  assert.equal(status, "");
  assert.match(await readFile(result.reportPath, "utf8"), /Selected `plan-1`/);
});

test("blocks before App Server work when tracked state is dirty", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  await writeFile(join(repoPath, "src", "value.ts"), "export const value = 2;\n", "utf8");

  await assert.rejects(
    runPlanning({
      repoPath,
      task: "Change the value.",
      plannerCount: 1,
      clientFactory: () => {
        throw new Error("App Server must not start");
      },
    }),
    (error: unknown) =>
      error instanceof PreflightError && error.reasonCode === "DIRTY_TRACKED_STATE",
  );
});

test("creates a failing-first safety harness on a branch and commits T1", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");
  const clientFactory = (): AppServerClient =>
    new AppServerClient({
      command: process.execPath,
      args: [fixture],
      cwd: repoPath,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    });
  const { stdout: baseline } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
  });
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 3,
    clientFactory,
  });

  const harness = await runHarness({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.match(harness.branch, /^safechange\//);
  assert.equal(harness.command.exitCode, 1);
  assert.deepEqual(Object.keys(harness.protectedHashes), ["test/value.test.ts"]);
  const { stdout: changed } = await execFileAsync(
    "git",
    ["diff", "--name-only", baseline.trim(), harness.testCommit],
    { cwd: repoPath },
  );
  assert.equal(changed.trim(), "test/value.test.ts");
  const { stdout: log } = await execFileAsync("git", ["log", "--format=%s", "--reverse"], {
    cwd: repoPath,
  });
  assert.deepEqual(log.trim().split("\n"), [
    "fixture baseline",
    "test: add SafeChange safety harness",
  ]);
  const state = JSON.parse(
    await readFile(join(planning.runPath, "state.json"), "utf8"),
  ) as RunState;
  assert.equal(state.testCommit, harness.testCommit);
  assert.equal(state.phase, "harness-complete");
  const contract = state.contexts.find((entry) => entry.role === "contract");
  const testAuthor = state.contexts.find((entry) => entry.role === "test-author");
  assert.equal(testAuthor?.parentThreadId, contract?.threadId);
});
