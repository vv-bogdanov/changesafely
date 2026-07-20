import { resolve } from "node:path";
import {
  isCapabilityTestPath,
  type RepositoryCapabilities,
  requireRepositoryCheck,
} from "./repository-capabilities.js";
import { normalizeRepositoryPath, pathWithinPrefixes } from "./repository-policy.js";
import { type CommandResult, runCommand, toCommandEvidence } from "./runner.js";
import type { ChangeContract, CoverageEvidence, DetailedPlan, HarnessArtifact } from "./schemas.js";
import type { TraceWriter } from "./trace.js";

export interface CoverageFailure {
  code: string;
  message: string;
}

interface CoverageMarker {
  scope: string[];
  lines: { covered: number; total: number };
  branches: { covered: number; total: number };
}

interface RunCoverageOptions {
  repoPath: string;
  capabilities: RepositoryCapabilities;
  sandboxed: boolean;
  trace: TraceWriter;
  phase: string;
  permissionProfile?: string;
  signal?: AbortSignal;
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

function addFailure(
  failures: CoverageFailure[],
  code: string,
  values: string[],
  message: string,
): void {
  if (values.length > 0) failures.push({ code, message: `${message}: ${values.join(", ")}` });
}

export function evaluateCoveragePlan(
  contract: ChangeContract,
  plan: DetailedPlan,
  harness: HarnessArtifact,
  capabilities: RepositoryCapabilities,
): CoverageFailure[] {
  const failures: CoverageFailure[] = [];
  if (harness.coverage.status !== "declared") {
    failures.push({ code: "COVERAGE_PLAN_UNRESOLVED", message: "Coverage plan is unresolved" });
    return failures;
  }
  const impactedPaths: string[] = [];
  for (const path of harness.coverage.impactedPaths) {
    try {
      impactedPaths.push(normalizeRepositoryPath(path));
    } catch {
      failures.push({ code: "INVALID_COVERAGE_PATH", message: `Invalid impacted path: ${path}` });
    }
  }
  addFailure(
    failures,
    "DUPLICATE_COVERAGE_PATH",
    duplicateIds(impactedPaths),
    "Duplicate impacted coverage paths",
  );
  if (impactedPaths.length === 0) {
    failures.push({
      code: "COVERAGE_SCOPE_MISSING",
      message: "Coverage plan must name the impacted production slice",
    });
  }
  addFailure(
    failures,
    "COVERAGE_SCOPE_IS_TEST",
    impactedPaths.filter((path) => isCapabilityTestPath(capabilities, path)),
    "Coverage scope must name production behavior, not test paths",
  );
  const productionPaths = plan.files
    .map((file) => file.path)
    .filter((path) => !isCapabilityTestPath(capabilities, path));
  addFailure(
    failures,
    "COVERAGE_SCOPE_INCOMPLETE",
    productionPaths.filter((path) => !pathWithinPrefixes(path, impactedPaths)),
    "Planned production paths outside the coverage slice",
  );

  const knownChecks = new Set(harness.checks.map((check) => check.id));
  const knownRisks = new Set([
    ...contract.risks.map((risk) => risk.id),
    ...plan.risks.map((risk) => risk.id),
  ]);
  for (const [kind, assessment] of Object.entries(harness.coverage.matrix)) {
    addFailure(
      failures,
      "DUPLICATE_COVERAGE_CHECK",
      duplicateIds(assessment.checkIds),
      `${kind} coverage repeats check ids`,
    );
    addFailure(
      failures,
      "UNKNOWN_COVERAGE_CHECK",
      assessment.checkIds.filter((id) => !knownChecks.has(id)),
      `${kind} coverage references unknown checks`,
    );
    addFailure(
      failures,
      "UNKNOWN_COVERAGE_RISK",
      assessment.relatedRiskIds.filter((id) => !knownRisks.has(id)),
      `${kind} coverage references unknown risks`,
    );
    if (assessment.status === "covered" && assessment.checkIds.length === 0) {
      failures.push({
        code: "COVERAGE_MATRIX_CHECK_MISSING",
        message: `${kind} coverage is declared covered without an executable check`,
      });
    }
    if (assessment.status === "not-applicable" && assessment.checkIds.length > 0) {
      failures.push({
        code: "COVERAGE_MATRIX_STATUS_MISMATCH",
        message: `${kind} coverage is not applicable but names executable checks`,
      });
    }
  }
  for (const gap of harness.coverage.gaps) {
    let path = gap.path;
    try {
      path = normalizeRepositoryPath(gap.path);
    } catch {
      failures.push({
        code: "INVALID_COVERAGE_GAP_PATH",
        message: `Invalid gap path: ${gap.path}`,
      });
      continue;
    }
    if (!pathWithinPrefixes(path, impactedPaths)) {
      failures.push({
        code: "COVERAGE_GAP_OUTSIDE_SCOPE",
        message: `Coverage gap is outside the impacted slice: ${gap.path}`,
      });
    }
    addFailure(
      failures,
      "UNKNOWN_COVERAGE_GAP_RISK",
      gap.relatedRiskIds.filter((id) => !knownRisks.has(id)),
      `Coverage gap ${gap.path} references unknown risks`,
    );
    if (gap.criticalBehavior) {
      failures.push({
        code: "UNCOVERED_CRITICAL_BEHAVIOR",
        message: `Critical behavior remains uncovered at ${gap.path}: ${gap.detail}`,
      });
    }
  }
  return failures;
}

export async function runCoverageChecks(options: RunCoverageOptions): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const check of options.capabilities.checks.filter(
    (candidate) => candidate.kind === "coverage",
  )) {
    requireRepositoryCheck(options.capabilities, check.argv, check.cwd, "coverage");
    results.push(
      await runCommand(check.argv, resolve(options.repoPath, check.cwd), {
        sandboxed: options.sandboxed,
        trace: options.trace,
        phase: options.phase,
        ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
  }
  return results;
}

export function buildCoverageEvidence(
  stage: "baseline" | "final",
  harness: HarnessArtifact,
  results: CommandResult[],
  repoPath: string,
): CoverageEvidence {
  const impactedPaths = harness.coverage.impactedPaths.map(normalizeRepositoryPath);
  const markers = results.flatMap(coverageMarkers);
  if (markers.length === 0) {
    return {
      stage,
      mode: "matrix",
      impactedPaths,
      lines: null,
      branches: null,
      matrix: harness.coverage.matrix,
      gaps: harness.coverage.gaps,
      commands: toCommandEvidence(results, repoPath),
    };
  }
  const scopes = markers.flatMap((marker) => marker.scope);
  for (let index = 0; index < scopes.length; index += 1) {
    for (let other = index + 1; other < scopes.length; other += 1) {
      const left = scopes[index];
      const right = scopes[other];
      if (!left || !right) continue;
      if (pathWithinPrefixes(left, [right]) || pathWithinPrefixes(right, [left])) {
        throw new Error(`Coverage marker scopes overlap: ${left}, ${right}`);
      }
    }
  }
  if (!samePathSet(impactedPaths, scopes)) {
    throw new Error("Numeric coverage scope does not match the impacted production slice");
  }
  const lines = sumMetric(markers.map((marker) => marker.lines));
  const branches = sumMetric(markers.map((marker) => marker.branches));
  return {
    stage,
    mode: "numeric",
    impactedPaths,
    lines,
    branches,
    matrix: harness.coverage.matrix,
    gaps: harness.coverage.gaps,
    commands: toCommandEvidence(results, repoPath),
  };
}

export function compareCoverageEvidence(
  baseline: CoverageEvidence,
  final: CoverageEvidence,
): CoverageFailure[] {
  const failures: CoverageFailure[] = [];
  if (baseline.stage !== "baseline" || final.stage !== "final") {
    failures.push({
      code: "COVERAGE_BOUNDARY_MISMATCH",
      message: "Coverage evidence does not describe comparable baseline and final boundaries",
    });
  }
  if (!samePathSet(baseline.impactedPaths, final.impactedPaths)) {
    failures.push({
      code: "COVERAGE_SCOPE_CHANGED",
      message: "Baseline and final coverage measure different impacted production slices",
    });
  }
  for (const kind of ["branches", "stateTransitions", "failures"] as const) {
    if (baseline.matrix[kind].status === "covered" && final.matrix[kind].status !== "covered") {
      failures.push({
        code: "COVERAGE_MATRIX_REGRESSION",
        message: `${kind} coverage is no longer backed by executable evidence`,
      });
    }
  }
  if (baseline.mode === "numeric" && final.mode !== "numeric") {
    failures.push({
      code: "COVERAGE_NOT_REPRODUCIBLE",
      message: "Final coverage did not reproduce numeric baseline evidence",
    });
  }
  if (baseline.mode === "numeric" && final.mode === "numeric") {
    if (metricRatio(final.lines) < metricRatio(baseline.lines)) {
      failures.push({
        code: "LINE_COVERAGE_REGRESSION",
        message: "Impacted line coverage regressed",
      });
    }
    if (metricRatio(final.branches) < metricRatio(baseline.branches)) {
      failures.push({
        code: "BRANCH_COVERAGE_REGRESSION",
        message: "Impacted branch coverage regressed",
      });
    }
  }
  return failures;
}

function samePathSet(left: string[], right: string[]): boolean {
  const normalized = (values: string[]) => [...new Set(values.map(normalizeRepositoryPath))].sort();
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function coverageMarkers(result: CommandResult): CoverageMarker[] {
  const markers: CoverageMarker[] = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)) {
    if (!line.includes('"changesafelyCoverage"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Invalid ChangeSafely coverage JSON marker");
    }
    const marker = markerValue(value);
    if (!marker) throw new Error("Invalid ChangeSafely coverage marker schema");
    markers.push(marker);
  }
  return markers;
}

function markerValue(value: unknown): CoverageMarker | undefined {
  if (!isRecord(value) || !isRecord(value.changesafelyCoverage)) return undefined;
  const marker = value.changesafelyCoverage;
  if (
    marker.schemaVersion !== 1 ||
    !Array.isArray(marker.scope) ||
    marker.scope.length === 0 ||
    !marker.scope.every((path) => typeof path === "string")
  ) {
    return undefined;
  }
  const scope: string[] = [];
  try {
    scope.push(...marker.scope.map((path) => normalizeRepositoryPath(path as string)));
  } catch {
    return undefined;
  }
  const lines = metricValue(marker.lines);
  const branches = metricValue(marker.branches);
  if (!lines || !branches) return undefined;
  return { scope, lines, branches };
}

function metricValue(value: unknown): CoverageMarker["lines"] | undefined {
  if (!isRecord(value)) return undefined;
  const { covered, total } = value;
  if (
    !Number.isInteger(covered) ||
    !Number.isInteger(total) ||
    (covered as number) < 0 ||
    (total as number) < 0 ||
    (covered as number) > (total as number)
  ) {
    return undefined;
  }
  return { covered: covered as number, total: total as number };
}

function sumMetric(values: CoverageMarker["lines"][]): NonNullable<CoverageEvidence["lines"]> {
  const covered = values.reduce((sum, value) => sum + value.covered, 0);
  const total = values.reduce((sum, value) => sum + value.total, 0);
  return { covered, total, percent: total === 0 ? 100 : (covered / total) * 100 };
}

function metricRatio(value: CoverageEvidence["lines"]): number {
  if (!value) return -1;
  return value.total === 0 ? 1 : value.covered / value.total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
