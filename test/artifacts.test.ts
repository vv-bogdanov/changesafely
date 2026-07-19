import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArtifactStore,
  loadRunState,
  loadVerifiedArtifact,
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
});

test("validates run state on write and load", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "safechange-state-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();

  const state = validState(repoPath);
  await store.writeState(state);
  assert.deepEqual(await loadRunState(repoPath, "safe-run"), state);
  await assert.rejects(access(join(store.runPath, "context.json")));

  await assert.rejects(
    store.writeState({ ...state, repairCount: 2 }),
    /Invalid SafeChange run state/,
  );
  await store.writeText("state.json", '{"runId":"safe-run"}\n');
  await assert.rejects(loadRunState(repoPath, "safe-run"), /Invalid SafeChange run state/);
});

test("validates artifact payloads, hashes, and run identity", async (t) => {
  const repoPath = await mkdtemp(join(tmpdir(), "safechange-envelope-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const store = new ArtifactStore(repoPath, "safe-run", baselineCommit);
  await store.initialize();
  const evidence = {
    summary: "Fixture repository",
    facts: [],
    commands: [],
    testGaps: [],
    constraints: [],
    assumptions: [],
    unknowns: [],
  };
  const stored = await store.writeArtifact("evidence", "discovery", evidence);
  const state = validState(repoPath);
  state.artifacts.evidence = stored.hash;
  await store.writeState(state);
  assert.equal(
    (await loadVerifiedArtifact(repoPath, state, "evidence")).payload.summary,
    evidence.summary,
  );

  const wrongRunContent = `${JSON.stringify({
    meta: {
      runId: "other-run",
      baselineCommit,
      role: "discovery",
      createdAt: new Date().toISOString(),
      inputHashes: [],
    },
    payload: evidence,
  })}\n`;
  await store.writeText("evidence.json", wrongRunContent);
  state.artifacts.evidence = createHash("sha256").update(wrongRunContent).digest("hex");
  await assert.rejects(loadVerifiedArtifact(repoPath, state, "evidence"), /lineage mismatch/);

  const invalidPayloadContent = `${JSON.stringify({
    meta: { ...stored.envelope.meta },
    payload: { summary: "Missing required evidence fields" },
  })}\n`;
  await store.writeText("evidence.json", invalidPayloadContent);
  state.artifacts.evidence = createHash("sha256").update(invalidPayloadContent).digest("hex");
  await assert.rejects(
    loadVerifiedArtifact(repoPath, state, "evidence"),
    /Invalid evidence artifact/,
  );
});
