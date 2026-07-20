import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCoverageEvidence,
  compareCoverageEvidence,
  evaluateCoveragePlan,
} from "../src/coverage.js";
import type { RepositoryCapabilities } from "../src/repository-capabilities.js";
import type { CommandResult } from "../src/runner.js";
import type { CoverageEvidence } from "../src/schemas.js";
import { validContract, validHarness, validPlan } from "./support/artifacts.js";

const capabilities: RepositoryCapabilities = {
  checks: [
    { id: "npm:.:test", kind: "test", argv: ["npm", "test"], cwd: "." },
    {
      id: "npm:.:test:coverage",
      kind: "coverage",
      argv: ["npm", "run", "test:coverage"],
      cwd: ".",
    },
  ],
  testPathPrefixes: ["test"],
  testFilePatterns: ["*.test.ts"],
  controlFiles: ["package.json"],
  sources: ["npm:package.json"],
};

function result(stdout: string): CommandResult {
  return {
    commandId: "coverage-1",
    argv: ["npm", "run", "test:coverage"],
    cwd: "/repo",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    durationMs: 1_000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutSha256: "a".repeat(64),
    stderrSha256: "b".repeat(64),
    stdoutTruncated: false,
    stderrTruncated: false,
    sandboxed: true,
  };
}

function marker(
  lines: [number, number],
  branches: [number, number],
  scope = ["src/value.ts"],
): string {
  return JSON.stringify({
    changesafelyCoverage: {
      schemaVersion: 1,
      scope,
      lines: { covered: lines[0], total: lines[1] },
      branches: { covered: branches[0], total: branches[1] },
    },
  });
}

test("accepts a traceable impacted-slice coverage plan", () => {
  assert.deepEqual(
    evaluateCoveragePlan(validContract(), validPlan(), validHarness(), capabilities),
    [],
  );
});

test("blocks incomplete scope, unknown checks, test-only scope, and critical gaps", () => {
  const harness = validHarness();
  harness.coverage.impactedPaths = ["test/value.test.ts"];
  harness.coverage.matrix.branches.checkIds = ["CHK-MISSING"];
  harness.coverage.gaps = [
    {
      path: "test/value.test.ts",
      detail: "A required failure path has no executable observation.",
      criticalBehavior: true,
      relatedRiskIds: ["R1"],
      evidenceBasis: [
        {
          source: "repository",
          detail: "The path is observable in the repository.",
          references: [{ path: "src/value.ts", detail: "Impacted implementation." }],
        },
      ],
    },
  ];

  const codes = evaluateCoveragePlan(validContract(), validPlan(), harness, capabilities).map(
    (failure) => failure.code,
  );
  assert.ok(codes.includes("COVERAGE_SCOPE_IS_TEST"));
  assert.ok(codes.includes("COVERAGE_SCOPE_INCOMPLETE"));
  assert.ok(codes.includes("UNKNOWN_COVERAGE_CHECK"));
  assert.ok(codes.includes("UNCOVERED_CRITICAL_BEHAVIOR"));
});

test("uses an explicit behavioral matrix when no numeric signal is available", () => {
  const evidence = buildCoverageEvidence("baseline", validHarness(), [], "/repo");
  assert.equal(evidence.mode, "matrix");
  assert.equal(evidence.lines, null);
  assert.equal(evidence.branches, null);
  assert.deepEqual(evidence.commands, []);
});

test("parses scoped numeric evidence and detects line and branch regressions", () => {
  const baseline = buildCoverageEvidence(
    "baseline",
    validHarness(),
    [result(marker([9, 10], [4, 5]))],
    "/repo",
  );
  const final = buildCoverageEvidence(
    "final",
    validHarness(),
    [result(marker([8, 10], [3, 5]))],
    "/repo",
  );

  assert.equal(baseline.mode, "numeric");
  assert.equal(baseline.lines?.percent, 90);
  assert.deepEqual(
    compareCoverageEvidence(baseline, final).map((failure) => failure.code),
    ["LINE_COVERAGE_REGRESSION", "BRANCH_COVERAGE_REGRESSION"],
  );
});

test("accepts zero executable branches without fabricating uncovered work", () => {
  const evidence = buildCoverageEvidence(
    "baseline",
    validHarness(),
    [result(marker([1, 1], [0, 0]))],
    "/repo",
  );
  assert.deepEqual(evidence.branches, { covered: 0, total: 0, percent: 100 });
});

test("rejects incomparable scope and matrix regressions", () => {
  const baseline = buildCoverageEvidence("baseline", validHarness(), [], "/repo");
  const final = structuredClone(baseline) as CoverageEvidence;
  final.stage = "final";
  final.impactedPaths = ["src/other.ts"];
  final.matrix.branches.status = "not-applicable";
  final.matrix.branches.checkIds = [];

  const codes = compareCoverageEvidence(baseline, final).map((failure) => failure.code);
  assert.ok(codes.includes("COVERAGE_SCOPE_CHANGED"));
  assert.ok(codes.includes("COVERAGE_MATRIX_REGRESSION"));
});

test("rejects malformed, overlapping, or incomplete numeric markers", () => {
  assert.throws(
    () =>
      buildCoverageEvidence(
        "baseline",
        validHarness(),
        [result('{"changesafelyCoverage":')],
        "/repo",
      ),
    /Invalid ChangeSafely coverage JSON marker/u,
  );
  assert.throws(
    () =>
      buildCoverageEvidence(
        "baseline",
        validHarness(),
        [result(`${marker([1, 1], [1, 1], ["src"])}\n${marker([1, 1], [1, 1])}`)],
        "/repo",
      ),
    /scopes overlap/u,
  );
  assert.throws(
    () =>
      buildCoverageEvidence(
        "baseline",
        validHarness(),
        [result(marker([1, 1], [1, 1], ["src/other.ts"]))],
        "/repo",
      ),
    /does not match the impacted production slice/u,
  );
});
