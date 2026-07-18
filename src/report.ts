import type { PlanEligibility } from "./eligibility.js";
import type { DecisionArtifact, DetailedPlan } from "./schemas.js";
import type { RunState } from "./artifacts.js";

export function planningReport(
  state: RunState,
  plans: DetailedPlan[],
  eligibility: PlanEligibility[],
  decision?: DecisionArtifact,
): string {
  const eligibilityById = new Map(eligibility.map((item) => [item.planId, item]));
  const planLines = plans.map((plan) => {
    const gate = eligibilityById.get(plan.planId);
    const result = gate?.eligible
      ? "eligible"
      : `rejected: ${[
          ...(gate?.failures.map((failure) => failure.message) ?? []),
          ...(gate?.humanDecisionReasons ?? []),
        ].join("; ")}`;
    return `- **${plan.planId}: ${plan.title}** (${plan.lens}) - ${result}`;
  });

  return `# SafeChange report

## Task

${state.task}

## Run

- Run id: \`${state.runId}\`
- Baseline: \`${state.baselineCommit}\`
- Status: \`${state.status}\`
- Phase: \`${state.phase}\`

## Plans

${planLines.length > 0 ? planLines.join("\n") : "No valid plans were produced."}

## Decision

${decision ? `Selected \`${decision.winnerPlanId}\`: ${decision.reason}` : state.reason || "No decision."}

## Tradeoffs

${decision?.tradeoffs.map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Residual risks

${decision?.residualRisks.map((item) => `- ${item}`).join("\n") || "- None recorded."}

## Next action

${state.nextAction || "No next action recorded."}
`;
}
