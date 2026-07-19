import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ArtifactStore, type RunState } from "../src/artifacts.js";
import { main } from "../src/cli.js";
import { RUN_STATE_VERSION } from "../src/schemas.js";
import { VERSION } from "../src/version.js";
import { createTestRepo, git } from "./support/repository.js";

const execFileAsync = promisify(execFile);

test("runs the CLI through an npm-style symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "safechange-cli-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const link = join(directory, "safechange");
  await symlink(join(process.cwd(), "dist", "src", "cli.js"), link);

  const { stdout: version } = await execFileAsync(process.execPath, [link, "--version"]);
  const { stdout: help } = await execFileAsync(process.execPath, [link, "--help"]);
  assert.equal(version, "0.1.0\n");
  assert.match(help, /safechange run --task/);
});

test("implements help, version, and invalid CLI contracts", async (t) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });

  assert.equal(await main(["--version"]), 0);
  assert.equal(await main(["--help"]), 0);
  assert.equal(await main(["unknown"]), 1);
  assert.equal(await main(["plan", "--task", "bounded", "--plans", "0"]), 1);
  assert.equal(await main(["resume"]), 1);

  assert.match(stdout.join(""), /0\.1\.0/);
  assert.match(stdout.join(""), /safechange resume/);
  assert.match(stdout.join(""), /safechange status/);
  assert.match(stderr.join(""), /Unknown command: unknown/);
  assert.match(stderr.join(""), /--plans must be an integer from 1 to 5/);
  assert.match(stderr.join(""), /--run is required/);
});

test("prints one JSON document for errors", async (t) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });

  assert.equal(await main(["unknown", "--json"]), 1);
  const value = JSON.parse(stdout.join("")) as { status?: string; reasonCode?: string };
  assert.equal(value.status, "ERROR");
  assert.equal(value.reasonCode, "INVALID_ARGUMENTS");
  assert.match(stderr.join(""), /Unknown command: unknown/);
});

test("reads persisted status as JSON without changing repository or artifacts", async (t) => {
  const repoPath = await createTestRepo(t, {
    prefix: "safechange-cli-status-",
    files: {
      ".gitignore": ".safechange/\n",
      "package.json": '{"name":"fixture"}\n',
    },
  });
  const baselineCommit = await git(repoPath, ["rev-parse", "HEAD"]);
  const state: RunState = {
    stateVersion: RUN_STATE_VERSION,
    producerVersion: VERSION,
    runId: "status-run",
    task: "Inspect the run",
    repoPath,
    baselineCommit,
    baselineFingerprint: "b".repeat(64),
    baselineProtectedConfiguration: {},
    phase: "planning-complete",
    status: "PLANNED",
    reason: "Selected plan-1",
    nextAction: "Continue with the harness.",
    artifacts: {},
    contexts: [],
    branch: "",
    testCommit: "",
    implementationCommit: "",
    repairCount: 0,
    model: "",
  };
  const store = new ArtifactStore(repoPath, state.runId, baselineCommit);
  await store.initialize();
  await store.writeState(state);
  await store.writeText("report.md", "# Report\n");
  const stateBefore = await readFile(join(store.runPath, "state.json"), "utf8");
  const gitBefore = await git(repoPath, ["status", "--porcelain=v1"]);
  const stdout: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });

  assert.equal(await main(["status", "--run", state.runId, "--repo", repoPath, "--json"]), 0);
  const outcome = JSON.parse(stdout.join("")) as {
    runId?: string;
    status?: string;
    selectedPlan?: string | null;
  };
  assert.equal(outcome.runId, state.runId);
  assert.equal(outcome.status, "PLANNED");
  assert.equal(outcome.selectedPlan, null);
  assert.equal(await readFile(join(store.runPath, "state.json"), "utf8"), stateBefore);
  assert.equal(await git(repoPath, ["status", "--porcelain=v1"]), gitBefore);
});
