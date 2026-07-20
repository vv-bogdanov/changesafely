import type { ChangeContract, DetailedPlan, HarnessArtifact } from "./schemas.js";

export interface HarnessEvidenceFailure {
  code: string;
  message: string;
}

export interface HarnessEvidenceOptions {
  stage?: "characterization" | "change";
  final?: boolean;
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

function missingIds(required: string[], actual: string[]): string[] {
  const covered = new Set(actual);
  return required.filter((id) => !covered.has(id));
}

function unknownIds(actual: string[], known: Set<string>): string[] {
  return [...new Set(actual.filter((id) => !known.has(id)))];
}

function addFailure(
  failures: HarnessEvidenceFailure[],
  code: string,
  values: string[],
  message: string,
): void {
  if (values.length > 0) failures.push({ code, message: `${message}: ${values.join(", ")}` });
}

export function evaluateHarnessEvidence(
  contract: ChangeContract,
  plan: DetailedPlan,
  harness: HarnessArtifact,
  options: HarnessEvidenceOptions = {},
): HarnessEvidenceFailure[] {
  const failures: HarnessEvidenceFailure[] = [];
  const checkIds = harness.checks.map((check) => check.id);
  addFailure(
    failures,
    "DUPLICATE_HARNESS_CHECK_ID",
    duplicateIds(checkIds),
    "Duplicate harness check ids",
  );

  const criteriaIds = new Set(contract.acceptanceCriteria.map((item) => item.id));
  const invariantIds = new Set(contract.protectedInvariants.map((item) => item.id));
  const riskIds = new Set([
    ...contract.risks.map((item) => item.id),
    ...plan.risks.map((item) => item.id),
  ]);
  const testPaths = new Set(harness.testPaths);
  const protectedPaths = new Set(harness.protectedPaths);

  for (const check of harness.checks) {
    if (options.stage && check.kind !== options.stage) {
      failures.push({
        code: "HARNESS_CHECK_KIND_MISMATCH",
        message: `Check ${check.id} must be ${options.stage}, received ${check.kind}`,
      });
    }
    const requiredOutcome = check.kind === "characterization" ? "pass" : "fail";
    if (check.expectedBaselineOutcome !== requiredOutcome) {
      failures.push({
        code: "HARNESS_CHECK_OUTCOME_MISMATCH",
        message: `Check ${check.id} must expect baseline ${requiredOutcome}`,
      });
    }
    if (!testPaths.has(check.testPath) || !protectedPaths.has(check.testPath)) {
      failures.push({
        code: "HARNESS_CHECK_NOT_EXECUTABLE",
        message: `Check ${check.id} is not bound to a declared protected test path: ${check.testPath}`,
      });
    }
    addFailure(
      failures,
      "DUPLICATE_HARNESS_CHECK_REFERENCE",
      [
        ...duplicateIds(check.coveredCriteriaIds),
        ...duplicateIds(check.coveredInvariantIds),
        ...duplicateIds(check.coveredRiskIds),
      ],
      `Check ${check.id} repeats coverage ids`,
    );
    addFailure(
      failures,
      "UNKNOWN_HARNESS_CRITERION",
      unknownIds(check.coveredCriteriaIds, criteriaIds),
      `Check ${check.id} references unknown criteria`,
    );
    addFailure(
      failures,
      "UNKNOWN_HARNESS_INVARIANT",
      unknownIds(check.coveredInvariantIds, invariantIds),
      `Check ${check.id} references unknown invariants`,
    );
    addFailure(
      failures,
      "UNKNOWN_HARNESS_RISK",
      unknownIds(check.coveredRiskIds, riskIds),
      `Check ${check.id} references unknown risks`,
    );
  }

  const knownCheckIds = new Set(checkIds);
  addFailure(
    failures,
    "DUPLICATE_NON_INTERFERENCE_CHECK",
    duplicateIds(harness.nonInterference.checkIds),
    "Duplicate non-interference check ids",
  );
  addFailure(
    failures,
    "UNKNOWN_NON_INTERFERENCE_CHECK",
    unknownIds(harness.nonInterference.checkIds, knownCheckIds),
    "Unknown non-interference check ids",
  );
  if (harness.nonInterference.status === "unknown") {
    failures.push({
      code: "NON_INTERFERENCE_UNRESOLVED",
      message: "Non-interference applicability is unresolved",
    });
  } else if (harness.nonInterference.status === "applicable") {
    if (harness.nonInterference.targets.length === 0) {
      failures.push({
        code: "NON_INTERFERENCE_TARGET_MISSING",
        message: "Applicable non-interference evidence requires a target",
      });
    }
    if (harness.nonInterference.checkIds.length === 0) {
      failures.push({
        code: "NON_INTERFERENCE_CHECK_MISSING",
        message: "Applicable non-interference evidence requires an executable check",
      });
    }
    const missingTargets = harness.nonInterference.checkIds.filter((id) => {
      const check = harness.checks.find((candidate) => candidate.id === id);
      return check && check.nonInterferenceTarget.trim() === "";
    });
    addFailure(
      failures,
      "NON_INTERFERENCE_ASSERTION_MISSING",
      missingTargets,
      "Non-interference checks require an observable isolation target",
    );
  } else if (
    harness.nonInterference.targets.length > 0 ||
    harness.nonInterference.checkIds.length > 0 ||
    harness.checks.some((check) => check.nonInterferenceTarget.trim() !== "")
  ) {
    failures.push({
      code: "NON_INTERFERENCE_STATUS_MISMATCH",
      message: "Non-applicable evidence cannot declare non-interference targets or checks",
    });
  }

  const coveredCriteria = harness.checks.flatMap((check) => check.coveredCriteriaIds);
  const coveredInvariants = harness.checks.flatMap((check) => check.coveredInvariantIds);
  const coveredRisks = harness.checks.flatMap((check) => check.coveredRiskIds);
  if (options.stage === "characterization" || options.final) {
    addFailure(
      failures,
      "MISSING_HARNESS_INVARIANT",
      missingIds([...invariantIds], coveredInvariants),
      "Protected invariants without executable evidence",
    );
  }
  if (options.stage === "change" || options.final) {
    addFailure(
      failures,
      "MISSING_HARNESS_CRITERION",
      missingIds([...criteriaIds], coveredCriteria),
      "Acceptance criteria without executable evidence",
    );
  }
  if (options.final) {
    const criticalRisks = [
      ...contract.risks.filter((risk) => risk.critical).map((risk) => risk.id),
      ...plan.risks.filter((risk) => risk.critical).map((risk) => risk.id),
    ];
    addFailure(
      failures,
      "MISSING_HARNESS_CRITICAL_RISK",
      missingIds(criticalRisks, coveredRisks),
      "Critical risks without executable evidence",
    );
  }
  return failures;
}
