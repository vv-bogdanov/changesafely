import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  acquireRepositoryLock,
  createSafeChangeBranch,
  inspectBaseline,
  PreflightError,
} from "../src/git.js";

const execFileAsync = promisify(execFile);

async function fixtureRepo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "safechange-git-"));
  await writeFile(join(path, "tracked.txt"), "baseline\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "SafeChange Test"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "test@safechange.local"], { cwd: path });
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: path });
  return path;
}

test("blocks a write phase when non-ignored untracked files exist", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const baseline = await inspectBaseline(repoPath);
  await writeFile(join(repoPath, "user-notes.txt"), "do not commit\n", "utf8");

  await assert.rejects(
    createSafeChangeBranch(baseline, "test-run"),
    (error: unknown) =>
      error instanceof PreflightError && error.reasonCode === "UNTRACKED_FILES_PRESENT",
  );
});

test("allows only one SafeChange writer per repository", async (t) => {
  const repoPath = await fixtureRepo();
  t.after(async () => rm(repoPath, { recursive: true, force: true }));

  const lock = await acquireRepositoryLock(repoPath, "run-1");
  await assert.rejects(
    acquireRepositoryLock(repoPath, "run-2"),
    (error: unknown) => error instanceof PreflightError && error.reasonCode === "REPOSITORY_LOCKED",
  );
  await lock.release();

  const nextLock = await acquireRepositoryLock(repoPath, "run-2");
  await nextLock.release();
});
