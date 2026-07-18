import type { ChangeContract, DetailedPlan } from "./schemas.js";

export interface EligibilityFailure {
  code: string;
  message: string;
}

export interface PlanEligibility {
  planId: string;
  eligible: boolean;
  failures: EligibilityFailure[];
  humanDecisionReasons: string[];
}

function pathAllowed(path: string, prefixes: string[]): boolean {
  return prefixes.some((rawPrefix) => {
    const prefix = rawPrefix.replace(/^\.\//, "").replace(/\/$/, "");
    const candidate = path.replace(/^\.\//, "");
    return prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`);
  });
}

function missingIds(required: string[], covered: string[]): string[] {
  const coverage = new Set(covered);
  return required.filter((id) => !coverage.has(id));
}

export function evaluatePlan(
  contract: ChangeContract,
  plan: DetailedPlan,
): PlanEligibility {
  const failures: EligibilityFailure[] = [];
  const missingCriteria = missingIds(
    contract.acceptanceCriteria.map((item) => item.id),
    plan.acceptanceCoverage.map((item) => item.id),
  );
  if (missingCriteria.length > 0) {
    failures.push({
      code: "MISSING_ACCEPTANCE_COVERAGE",
      message: `Missing acceptance criteria: ${missingCriteria.join(", ")}`,
    });
  }

  const missingInvariants = missingIds(
    contract.protectedInvariants.map((item) => item.id),
    plan.invariantProtection.map((item) => item.id),
  );
  if (missingInvariants.length > 0) {
    failures.push({
      code: "MISSING_INVARIANT_PROTECTION",
      message: `Missing protected invariants: ${missingInvariants.join(", ")}`,
    });
  }

  const outsideScope = plan.files
    .map((file) => file.path)
    .filter((path) => !pathAllowed(path, contract.allowedPathPrefixes));
  if (outsideScope.length > 0) {
    failures.push({
      code: "OUTSIDE_ALLOWED_SCOPE",
      message: `Paths outside allowed scope: ${outsideScope.join(", ")}`,
    });
  }

  const unresolvedCritical = plan.unknowns.filter(
    (unknown) => unknown.critical && unknown.resolution.trim() === "",
  );
  if (unresolvedCritical.length > 0) {
    failures.push({
      code: "UNRESOLVED_CRITICAL_UNKNOWN",
      message: unresolvedCritical.map((unknown) => unknown.description).join("; "),
    });
  }

  if (plan.safetyTests.length === 0 || plan.verificationCommands.length === 0) {
    failures.push({
      code: "MISSING_VERIFICATION_STRATEGY",
      message: "Plan requires safety tests and deterministic verification commands",
    });
  }
  if (plan.recovery.length === 0) {
    failures.push({
      code: "MISSING_RECOVERY",
      message: "Plan does not define a recovery path",
    });
  }

  const humanDecisionReasons = [
    ...plan.approvalRequiredChanges,
    ...plan.dependencies.map((item) => `Dependency: ${item}`),
    ...plan.migrations.map((item) => `Migration: ${item}`),
  ];

  return {
    planId: plan.planId,
    eligible: failures.length === 0 && humanDecisionReasons.length === 0,
    failures,
    humanDecisionReasons,
  };
}

export function evaluatePlans(
  contract: ChangeContract,
  plans: DetailedPlan[],
): PlanEligibility[] {
  return plans.map((plan) => evaluatePlan(contract, plan));
}
