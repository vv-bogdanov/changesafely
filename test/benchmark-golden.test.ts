import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { buildBenchmarkReport, replayBenchmarkRun } from "../bench/src/report.js";

const goldenRoot = join(process.cwd(), "bench", "golden", "spark-pilot");
const runIds = [
  "tenant-leak-direct-20260719153314861-1cfee783",
  "tenant-leak-changesafely-20260719153505353-e2c443ab",
  "restart-storm-direct-20260719154714179-ec0b7c86",
  "restart-storm-changesafely-20260719154846674-ac381eee",
];

test("published Spark evidence remains byte-for-byte frozen", async () => {
  const hash = createHash("sha256");
  const files = (await listFiles(goldenRoot)).sort();
  assert.equal(files.length, 77);
  for (const path of files) {
    hash.update(relative(goldenRoot, path));
    hash.update("\0");
    hash.update(await readFile(path));
  }
  assert.equal(
    hash.digest("hex"),
    "b603ad62f16b85ab8890fbf0894b9d0842894c57633d56e37755684f358a3023",
  );
});

test("published Spark evidence replays and matches its stable report", async () => {
  for (const runId of runIds) {
    const replay = await replayBenchmarkRun(goldenRoot, runId);
    assert.equal(replay.verified, true, runId);
    assert.ok(replay.analysis, runId);
    assert.ok(replay.caseCard, runId);
  }

  const report = await buildBenchmarkReport(goldenRoot);
  assert.equal(report.reportVersion, 3);
  assert.equal(report.comparisons.length, 2);
  assert.ok(report.comparisons.every((comparison) => comparison.paired));
  assert.ok(report.comparisons.every((comparison) => comparison.measurement === "development"));
  const tenantLeak = report.comparisons.find((comparison) => comparison.scenario === "tenant-leak");
  const tenantLeakRun = tenantLeak?.runs.find((run) => run.mode === "changesafely");
  assert.equal(tenantLeakRun?.tokens.inputTokens, 515_704);
  assert.equal(tenantLeakRun?.tokens.cachedInputTokens, 342_912);
  assert.equal(tenantLeakRun?.tokens.outputTokens, 36_757);
  const restartStorm = report.comparisons.find(
    (comparison) => comparison.scenario === "restart-storm",
  );
  const restartStormRun = restartStorm?.runs.find((run) => run.mode === "changesafely");
  assert.equal(restartStormRun?.tokens.inputTokens, 486_859);
  assert.equal(restartStormRun?.tokens.cachedInputTokens, 355_328);
  assert.equal(restartStormRun?.tokens.outputTokens, 25_112);
  assert.deepEqual(JSON.parse(await readFile(join(goldenRoot, "report.json"), "utf8")), report);
});

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
