import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildBenchmarkReport, replayBenchmarkRun } from "../bench/src/report.js";

const goldenRoot = join(process.cwd(), "bench", "golden", "spark-pilot");
const runIds = [
  "tenant-leak-direct-20260719153314861-1cfee783",
  "tenant-leak-changesafely-20260719153505353-e2c443ab",
  "restart-storm-direct-20260719154714179-ec0b7c86",
  "restart-storm-changesafely-20260719154846674-ac381eee",
];

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
