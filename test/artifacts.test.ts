import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore, loadArtifact, validateRunId } from "../src/artifacts.js";

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
