import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArtifactStore,
  loadArtifact,
  loadRunState,
  type RunState,
  validateRunId,
} from "../src/artifacts.js";

const baselineCommit = "a".repeat(40);

function validState(repoPath: string): RunState {
  return {
    runId: "safe-run",
    task: "Make a bounded change",
    repoPath,
    baselineCommit,
    baselineFingerprint: "b".repeat(64),
    baselineProtectedConfiguration: {},
    phase: "preflight",
    status: "RUNNING",
    reason: "",
    nextAction: "Continue planning.",
    artifacts: {},
    contexts: [],
    branch: "",
    testCommit: "",
    implementationCommit: "",
    repairCount: 0,
    model: "",
  };
}

test("rejects unsafe run ids and artifact paths", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "safechange-artifacts-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));

  assert.throws(() => validateRunId("../../outside"), /Invalid SafeChange run id/);
  assert.throws(() => new ArtifactStore(repoPath, "../outside", "baseline"));

  const store = new ArtifactStore(repoPath, "safe-run", "baseline");
  await store.initialize();
  await assert.rejects(store.writeText("../outside.json", "unsafe"), /escapes/);
  await assert.rejects(loadArtifact(repoPath, "safe-run", "../../outside.json"), /escapes/);
});

test("validates run state on write and load", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "safechange-state-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();

  const state = validState(repoPath);
  await store.writeState(state);
  assert.deepEqual(await loadRunState(repoPath, "safe-run"), state);

  await assert.rejects(
    store.writeState({ ...state, repairCount: 2 }),
    /Invalid SafeChange run state/,
  );
  await store.writeText("state.json", '{"runId":"safe-run"}\n');
  await assert.rejects(loadRunState(repoPath, "safe-run"), /Invalid SafeChange run state/);
});

test("validates artifact envelopes and run identity", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "safechange-envelope-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  await store.writeArtifact("evidence.json", "discovery", { value: 1 });
  assert.equal(
    (await loadArtifact<{ value: number }>(repoPath, "safe-run", "evidence.json")).payload.value,
    1,
  );

  await store.writeText(
    "evidence.json",
    `${JSON.stringify({
      meta: {
        runId: "other-run",
        baselineCommit,
        role: "discovery",
        createdAt: new Date().toISOString(),
        inputHashes: [],
      },
      payload: {},
    })}\n`,
  );
  await assert.rejects(
    loadArtifact(repoPath, "safe-run", "evidence.json"),
    /run identity mismatch/,
  );
});
