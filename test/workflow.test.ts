import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AppServerClient } from "../src/app-server/client.js";
import type { RunState } from "../src/artifacts.js";
import { PreflightError } from "../src/git.js";
import { runHarness } from "../src/harness.js";
import { runImplementationAndVerification } from "../src/implementation.js";
import { validateResumeBoundary } from "../src/orchestrator.js";
import { runPlanning } from "../src/workflow.js";

const execFileAsync = promisify(execFile);

async function fixtureRepo(testScript = "node --test"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "safechange-plan-"));
  await mkdir(join(path, "src"));
  await writeFile(join(path, "AGENTS.md"), "# Fixture\n", "utf8");
  await writeFile(
    join(path, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { test: testScript } }, null, 2)}\n`,
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
        args: [fixture, "out-of-order"],
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      }),
    parallelPlanners: true,
  });

  assert.equal(result.status, "PLANNED");
  assert.equal(result.decision?.winnerPlanId, "plan-1");
  const state = JSON.parse(await readFile(join(result.runPath, "state.json"), "utf8")) as RunState;
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

test("corrects one planner artifact in the same fork before Judge", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: () =>
      new AppServerClient({
        command: process.execPath,
        args: [fixture, "planner-correction"],
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      }),
  });

  assert.equal(result.status, "PLANNED");
  const state = JSON.parse(await readFile(join(result.runPath, "state.json"), "utf8")) as RunState;
  const planner = state.contexts.find((entry) => entry.role === "planner:plan-1");
  const correction = state.contexts.find((entry) => entry.role === "planner-correction:plan-1");
  assert.equal(correction?.threadId, planner?.threadId);
  assert.equal(correction?.checkpointTurnId, planner?.turnId);
});

test("corrects one Judge decision in the same fork before planning completes", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");
  const result = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: () =>
      new AppServerClient({
        command: process.execPath,
        args: [fixture, "judge-correction"],
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      }),
  });

  assert.equal(result.status, "PLANNED");
  const state = JSON.parse(await readFile(join(result.runPath, "state.json"), "utf8")) as RunState;
  const judge = state.contexts.find((entry) => entry.role === "judge");
  const correction = state.contexts.find((entry) => entry.role === "judge-correction");
  assert.equal(correction?.threadId, judge?.threadId);
  assert.equal(correction?.checkpointTurnId, judge?.turnId);
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

test("stops when the baseline repository test script changes protected configuration", async (t) => {
  const repoPath = await fixtureRepo(
    `node -e "require('node:fs').writeFileSync('.env', 'changed')" && node --test`,
  );
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
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 1,
    clientFactory,
  });

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    /Protected configuration metadata changed/,
  );
  const state = JSON.parse(
    await readFile(join(planning.runPath, "state.json"), "utf8"),
  ) as RunState;
  assert.equal(state.status, "FAILED");
  assert.equal(Boolean(state.testCommit), false);
});

test("creates I1, preserves T1, runs commands, and verifies from a fresh C0 fork", async (t) => {
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
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 3,
    clientFactory,
  });
  const harness = await runHarness({ repoPath, runId: planning.runId, clientFactory });
  const protectedBefore = harness.protectedHashes["test/value.test.ts"];

  const implementation = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.equal(implementation.accepted, true);
  assert.equal(implementation.verification.verdict, "accept");
  assert.ok(implementation.commands.every((command) => command.exitCode === 0));
  const state = JSON.parse(
    await readFile(join(planning.runPath, "state.json"), "utf8"),
  ) as RunState;
  assert.equal(state.implementationCommit, implementation.implementationCommit);
  assert.equal(state.phase, "verification-complete");
  const harnessArtifact = JSON.parse(
    await readFile(join(planning.runPath, "harness.json"), "utf8"),
  ) as { payload: { protectedHashes: Record<string, string> } };
  assert.equal(harnessArtifact.payload.protectedHashes["test/value.test.ts"], protectedBefore);
  const { stdout: t1ToI1 } = await execFileAsync(
    "git",
    ["diff", "--name-only", state.testCommit, state.implementationCommit],
    { cwd: repoPath },
  );
  assert.equal(t1ToI1.trim(), "src/value.ts");
  const contract = state.contexts.find((entry) => entry.role === "contract");
  const implementer = state.contexts.find((entry) => entry.role === "implementer");
  const verifier = state.contexts.find((entry) => entry.role === "verifier");
  assert.equal(implementer?.parentThreadId, contract?.threadId);
  assert.equal(verifier?.parentThreadId, contract?.threadId);
  assert.notEqual(verifier?.parentThreadId, implementer?.threadId);
  const { stdout: log } = await execFileAsync("git", ["log", "--format=%s", "--reverse"], {
    cwd: repoPath,
  });
  assert.deepEqual(log.trim().split("\n"), [
    "fixture baseline",
    "test: add SafeChange safety harness",
    "feat: implement selected SafeChange plan",
  ]);
});

test("resumes the same Implementer once for a local repair and forks a fresh Verifier", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");
  const clientFactory = (): AppServerClient =>
    new AppServerClient({
      command: process.execPath,
      args: [fixture, "repair"],
      cwd: repoPath,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    });
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value without changing its export.",
    plannerCount: 3,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  const result = await runImplementationAndVerification({
    repoPath,
    runId: planning.runId,
    clientFactory,
  });

  assert.equal(result.accepted, true);
  const state = JSON.parse(
    await readFile(join(planning.runPath, "state.json"), "utf8"),
  ) as RunState;
  assert.equal(state.repairCount, 1);
  const implementer = state.contexts.find((entry) => entry.role === "implementer");
  const repair = state.contexts.find((entry) => entry.role === "repair");
  const verifiers = state.contexts.filter((entry) => entry.role.startsWith("verifier"));
  assert.equal(repair?.threadId, implementer?.threadId);
  assert.equal(verifiers.length, 2);
  assert.notEqual(verifiers[0]?.threadId, verifiers[1]?.threadId);
  const { stdout: log } = await execFileAsync("git", ["log", "--format=%s", "--reverse"], {
    cwd: repoPath,
  });
  assert.deepEqual(log.trim().split("\n"), [
    "fixture baseline",
    "test: add SafeChange safety harness",
    "feat: implement selected SafeChange plan",
    "fix: repair selected SafeChange implementation",
  ]);
});

test("refuses a planning resume when a persisted artifact hash changed", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory: () =>
      new AppServerClient({
        command: process.execPath,
        args: [fixture],
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      }),
  });
  await validateResumeBoundary(repoPath, planning.runId);
  await writeFile(join(planning.runPath, "contract.json"), "{}\n", "utf8");

  await assert.rejects(
    validateResumeBoundary(repoPath, planning.runId),
    /Artifact hash mismatch: contract\.json/,
  );
});

test("stops when the Implementer edits a protected T1 path", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");
  const clientFactory = (): AppServerClient =>
    new AppServerClient({
      command: process.execPath,
      args: [fixture, "protected-edit"],
      cwd: repoPath,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    });
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory,
  });
  await runHarness({ repoPath, runId: planning.runId, clientFactory });

  await assert.rejects(
    runImplementationAndVerification({ repoPath, runId: planning.runId, clientFactory }),
    /protected T1 path/,
  );
});

test("rejects malformed role output locally", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");

  await assert.rejects(
    runPlanning({
      repoPath,
      task: "Change the fixture value.",
      plannerCount: 1,
      clientFactory: () =>
        new AppServerClient({
          command: process.execPath,
          args: [fixture, "malformed"],
          requestTimeoutMs: 1_000,
          turnTimeoutMs: 1_000,
        }),
    }),
    /Invalid evidence artifact/,
  );
});

test("marks a clean but changed baseline before the first write", async (t) => {
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
  const planning = await runPlanning({
    repoPath,
    task: "Change the fixture value.",
    plannerCount: 1,
    clientFactory,
  });
  await writeFile(join(repoPath, "README.md"), "changed baseline\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "change baseline"], { cwd: repoPath });

  await assert.rejects(
    runHarness({ repoPath, runId: planning.runId, clientFactory }),
    /Baseline no longer matches/,
  );
  const state = JSON.parse(
    await readFile(join(planning.runPath, "state.json"), "utf8"),
  ) as RunState;
  assert.equal(state.status, "BASELINE_CHANGED");
});

for (const scenario of [
  {
    name: "scope expansion",
    mode: "scope-expansion",
    message: /expanded beyond selected plan/,
    status: "REPLAN_REQUIRED",
  },
  {
    name: "failed deterministic commands",
    mode: "failed-command",
    message: /Deterministic verification failed/,
    status: "FAILED",
  },
  {
    name: "protected configuration changes",
    mode: "protected-config",
    message: /Protected configuration metadata changed/,
    status: "FAILED",
  },
] as const) {
  test(`stops on ${scenario.name}`, async (t) => {
    const repoPath = await fixtureRepo();
    t.after(async () => rm(repoPath, { recursive: true, force: true }));
    const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");
    const clientFactory = (): AppServerClient =>
      new AppServerClient({
        command: process.execPath,
        args: [fixture, scenario.mode],
        cwd: repoPath,
        requestTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      });
    const planning = await runPlanning({
      repoPath,
      task: "Change the fixture value.",
      plannerCount: 1,
      clientFactory,
    });
    await runHarness({ repoPath, runId: planning.runId, clientFactory });

    await assert.rejects(
      runImplementationAndVerification({ repoPath, runId: planning.runId, clientFactory }),
      scenario.message,
    );
    const state = JSON.parse(
      await readFile(join(planning.runPath, "state.json"), "utf8"),
    ) as RunState;
    assert.equal(state.status, scenario.status);
    if (scenario.mode === "failed-command") {
      const commands = JSON.parse(
        await readFile(join(planning.runPath, "verification-commands.json"), "utf8"),
      ) as { payload: Array<{ exitCode: number | null }> };
      assert.ok(commands.payload.some((command) => command.exitCode !== 0));
    }
  });
}
