import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  acquireRepositoryLock,
  assertProtectedConfigurationUnchanged,
  createChangeSafelyBranch,
  inspectBaseline,
  PreflightError,
} from "../src/git.js";
import { createTestRepo } from "./support/repository.js";

test("blocks a write phase when non-ignored untracked files exist", async (t) => {
  const repoPath = await createTestRepo(t, { files: { "tracked.txt": "baseline\n" } });
  const baseline = await inspectBaseline(repoPath);
  await writeFile(join(repoPath, "user-notes.txt"), "do not commit\n", "utf8");

  await assert.rejects(
    createChangeSafelyBranch(baseline, "test-run"),
    (error: unknown) =>
      error instanceof PreflightError && error.reasonCode === "UNTRACKED_FILES_PRESENT",
  );
});

test("allows only one ChangeSafely writer per repository", async (t) => {
  const repoPath = await createTestRepo(t, { files: { "tracked.txt": "baseline\n" } });

  const lock = await acquireRepositoryLock(repoPath, "run-1");
  await assert.rejects(
    acquireRepositoryLock(repoPath, "run-2"),
    (error: unknown) => error instanceof PreflightError && error.reasonCode === "REPOSITORY_LOCKED",
  );
  await lock.release();

  const nextLock = await acquireRepositoryLock(repoPath, "run-2");
  await nextLock.release();
});

test("protects ignored Composer authentication by metadata only", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: {
      ".gitignore": "auth.json\n",
      "auth.json": "first-private-value\n",
      "tracked.txt": "baseline\n",
    },
  });
  const baseline = await inspectBaseline(repoPath);
  assert.match(baseline.protectedConfiguration["auth.json"] ?? "", /^[a-f0-9]{64}$/u);

  await writeFile(
    join(repoPath, "auth.json"),
    "second-private-value-with-different-size\n",
    "utf8",
  );
  await assert.rejects(
    assertProtectedConfigurationUnchanged(repoPath, baseline.protectedConfiguration),
    /Protected configuration metadata changed/u,
  );
});
