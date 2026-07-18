import type { PlanEligibility } from "./eligibility.js";
import type { DecisionArtifact, DetailedPlan } from "./schemas.js";
import type { VerificationArtifact } from "./schemas.js";
import type { RunState } from "./artifacts.js";
import type { CommandResult } from "./runner.js";

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

export function implementationReport(
  state: RunState,
  decision: DecisionArtifact,
  commands: CommandResult[],
  verification: VerificationArtifact,
): string {
  const commandLines = commands.map(
    (command) =>
      `- \`${command.argv.join(" ")}\`: exit ${command.exitCode}${command.timedOut ? " (timeout)" : ""}`,
  );
  const findingLines = verification.findings.map(
    (finding) =>
      `- **${finding.severity} ${finding.code}**${finding.path ? ` \`${finding.path}\`` : ""}: ${finding.message}`,
  );
  return `# SafeChange verification report

## Task

${state.task}

## Result

- Run id: \`${state.runId}\`
- Status: \`${state.status}\`
- Baseline B0: \`${state.baselineCommit}\`
- Safety harness T1: \`${state.testCommit}\`
- Implementation I1: \`${state.implementationCommit}\`
- Branch: \`${state.branch}\`
- Selected plan: \`${decision.winnerPlanId}\`

## Deterministic commands

${commandLines.join("\n")}

## Independent verification

${verification.verdict.toUpperCase()}: ${verification.reason}

${findingLines.length > 0 ? findingLines.join("\n") : "No findings."}

## Residual risks

${verification.residualRisks.map((risk) => `- ${risk}`).join("\n") || "- None recorded."}

## Rollback boundary

Discarding this branch returns tracked source code to B0. SafeChange does not roll back ignored files, local services, databases, queues, volumes, or external systems.

## Next action

${state.nextAction}
`;
}
