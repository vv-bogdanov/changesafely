import assert from "node:assert/strict";
import test from "node:test";
import {
  exitCodeForOutcome,
  formatJsonOutcome,
  formatRunOutcome,
  RUN_OUTCOME_VERSION,
  type RunOutcome,
} from "../src/outcome.js";
import type { RunStatus } from "../src/schemas.js";

function outcome(status: RunStatus): RunOutcome {
  return {
    outcomeVersion: RUN_OUTCOME_VERSION,
    runId: "run-1",
    status,
    phase:
      status === "VERIFIED" ? "verified" : status === "PLANNED" ? "planning-complete" : "failed",
    reasonCode: status,
    reason: "Concrete result",
    nextAction: "Take the next action.",
    selectedPlan: "plan-1",
    model: null,
    branch: null,
    testCommit: null,
    implementationCommit: null,
    runPath: "/repo/.changesafely/runs/run-1",
    statePath: "/repo/.changesafely/runs/run-1/state.json",
    reportPath: "/repo/.changesafely/runs/run-1/report.md",
    tracePath: "/repo/.changesafely/runs/run-1/trace.jsonl",
    manifestPath: "/repo/.changesafely/runs/run-1/manifest.json",
    artifactPaths: {},
  };
}

test("renders text and JSON from the same run outcome", () => {
  const value = outcome("PLANNED");
  const text = formatRunOutcome(value);
  const json = JSON.parse(formatJsonOutcome(value)) as RunOutcome;

  assert.match(text, /Run: run-1/);
  assert.match(text, /Status: PLANNED/);
  assert.match(text, /Trace: .*trace\.jsonl/);
  assert.deepEqual(json, value);
});

test("maps every persisted status to a stable terminal exit code", () => {
  const expected: Record<RunStatus, 0 | 1 | 2> = {
    RUNNING: 2,
    PLANNED: 0,
    BLOCKED: 2,
    HUMAN_DECISION_REQUIRED: 2,
    BASELINE_CHANGED: 2,
    REPLAN_REQUIRED: 2,
    FAILED: 1,
    VERIFIED: 0,
  };
  for (const [status, exitCode] of Object.entries(expected) as Array<[RunStatus, 0 | 1 | 2]>) {
    assert.equal(exitCodeForOutcome(outcome(status)), exitCode, status);
  }
});
