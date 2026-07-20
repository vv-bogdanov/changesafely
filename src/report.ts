import { artifactDefinition } from "./artifact-catalog.js";
import { type ArtifactKey, isArtifactKey, parsePlanArtifactKey } from "./artifact-key.js";
import { loadVerifiedArtifact, type RunState } from "./artifacts.js";
import type { PlanEligibility } from "./eligibility.js";
import { analyzeTrace, type RunAnalytics } from "./run-analytics.js";
import type {
  ChangeContract,
  CommandEvidence,
  CoverageEvidence,
  DecisionArtifact,
  DetailedPlan,
  HarnessReviewArtifact,
  StoredHarnessArtifact,
  VerificationArtifact,
} from "./schemas.js";
import { loadTrace } from "./trace.js";

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

  return `# ChangeSafely report

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

interface EvidenceReference {
  key: ArtifactKey;
  path: string;
  sha256: string;
}

interface TraceabilityClaim {
  kind: "acceptance" | "invariant" | "critical-risk";
  id: string;
  statement: string;
  checkIds: string[];
}

interface CommandGroup {
  label: string;
  artifactKey: ArtifactKey;
  commands: CommandEvidence[];
}

export interface AssuranceProfile {
  profileVersion: 1;
  runId: string;
  task: string;
  status: RunState["status"];
  phase: RunState["phase"];
  reason: string;
  nextAction: string;
  branch: string;
  selectedPlanId: string;
  commits: {
    b0: string;
    c1: string;
    t1: string | null;
    i1: string;
    r1: string | null;
  };
  evidence: EvidenceReference[];
  traceability: TraceabilityClaim[];
  harness: StoredHarnessArtifact;
  harnessReview: HarnessReviewArtifact;
  commandGroups: CommandGroup[];
  coverage: {
    baseline: CoverageEvidence;
    final: CoverageEvidence;
  };
  verification: VerificationArtifact;
  analytics: RunAnalytics;
}

function evidenceReferences(state: RunState): EvidenceReference[] {
  return Object.entries(state.artifacts)
    .filter((entry): entry is [ArtifactKey, string] => isArtifactKey(entry[0]))
    .map(([key, sha256]) => ({ key, path: artifactDefinition(key).path, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function traceabilityClaims(
  contract: ChangeContract,
  plan: DetailedPlan,
  harness: StoredHarnessArtifact,
): TraceabilityClaim[] {
  const checkIds = (kind: TraceabilityClaim["kind"], id: string): string[] =>
    harness.checks
      .filter((check) =>
        kind === "acceptance"
          ? check.coveredCriteriaIds.includes(id)
          : kind === "invariant"
            ? check.coveredInvariantIds.includes(id)
            : check.coveredRiskIds.includes(id),
      )
      .map((check) => check.id);
  return [
    ...contract.acceptanceCriteria.map((claim) => ({
      kind: "acceptance" as const,
      id: claim.id,
      statement: claim.statement,
      checkIds: checkIds("acceptance", claim.id),
    })),
    ...contract.protectedInvariants.map((claim) => ({
      kind: "invariant" as const,
      id: claim.id,
      statement: claim.statement,
      checkIds: checkIds("invariant", claim.id),
    })),
    ...[...contract.risks, ...plan.risks]
      .filter((claim) => claim.critical)
      .map((claim) => ({
        kind: "critical-risk" as const,
        id: claim.id,
        statement: claim.statement,
        checkIds: checkIds("critical-risk", claim.id),
      })),
  ];
}

export async function loadAssuranceProfile(
  repoPath: string,
  state: RunState,
): Promise<AssuranceProfile> {
  const decision = (await loadVerifiedArtifact(repoPath, state, "decision")).payload;
  const planKey = parsePlanArtifactKey(decision.winnerPlanId);
  const plan = (await loadVerifiedArtifact(repoPath, state, planKey)).payload;
  const contract = (await loadVerifiedArtifact(repoPath, state, "contract")).payload;
  const harness = (await loadVerifiedArtifact(repoPath, state, "harness")).payload;
  const harnessReview = (await loadVerifiedArtifact(repoPath, state, "harnessReview")).payload;
  const characterizationCommands = (
    await loadVerifiedArtifact(repoPath, state, "characterizationCommands")
  ).payload;
  const harnessCommands = (await loadVerifiedArtifact(repoPath, state, "commands")).payload;
  const coverageBaseline = (await loadVerifiedArtifact(repoPath, state, "coverageBaseline"))
    .payload;
  const implementation = (await loadVerifiedArtifact(repoPath, state, "implementation")).payload;
  const repair = state.artifacts.repair
    ? (await loadVerifiedArtifact(repoPath, state, "repair")).payload
    : undefined;
  const finalCommandKey = state.artifacts.verificationCommandsRepair
    ? "verificationCommandsRepair"
    : "verificationCommands";
  const finalCoverageKey = state.artifacts.coverageFinalRepair
    ? "coverageFinalRepair"
    : "coverageFinal";
  const finalCommands = (await loadVerifiedArtifact(repoPath, state, finalCommandKey)).payload;
  const coverageFinal = (await loadVerifiedArtifact(repoPath, state, finalCoverageKey)).payload;
  const verification = (await loadVerifiedArtifact(repoPath, state, "verification")).payload;
  const trace = await loadTrace(repoPath, state.runId);
  let boundaryIndex = -1;
  for (let index = trace.events.length - 1; index >= 0; index -= 1) {
    const event = trace.events[index];
    if (event?.event === "state.transition" && event.phase === state.phase) {
      boundaryIndex = index;
      break;
    }
  }
  const analytics = analyzeTrace(
    boundaryIndex >= 0 ? trace.events.slice(0, boundaryIndex + 1) : trace.events,
  );
  return {
    profileVersion: 1,
    runId: state.runId,
    task: state.task,
    status: state.status,
    phase: state.phase,
    reason: state.reason,
    nextAction: state.nextAction,
    branch: state.branch,
    selectedPlanId: decision.winnerPlanId,
    commits: {
      b0: state.baselineCommit,
      c1: state.characterizationCommit || state.testCommit,
      t1:
        state.characterizationCommit && state.characterizationCommit !== state.testCommit
          ? state.testCommit
          : null,
      i1: implementation.implementationCommit,
      r1: repair?.implementationCommit ?? null,
    },
    evidence: evidenceReferences(state),
    traceability: traceabilityClaims(contract, plan, harness),
    harness,
    harnessReview,
    commandGroups: [
      {
        label: "C1 characterization",
        artifactKey: "characterizationCommands",
        commands: characterizationCommands,
      },
      { label: "T1 harness baseline", artifactKey: "commands", commands: harnessCommands },
      { label: "final verification", artifactKey: finalCommandKey, commands: finalCommands },
      {
        label: "baseline coverage",
        artifactKey: "coverageBaseline",
        commands: coverageBaseline.commands,
      },
      {
        label: "final coverage",
        artifactKey: finalCoverageKey,
        commands: coverageFinal.commands,
      },
    ],
    coverage: { baseline: coverageBaseline, final: coverageFinal },
    verification,
    analytics,
  };
}

function evidence(profile: AssuranceProfile, key: ArtifactKey): string {
  const item = profile.evidence.find((candidate) => candidate.key === key);
  return item
    ? `[${item.path}](${item.path}) \`${item.sha256.slice(0, 16)}...\``
    : `missing \`${key}\` evidence`;
}

function metric(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function coverageSummary(coverage: CoverageEvidence): string {
  if (coverage.mode === "numeric" && coverage.lines && coverage.branches) {
    return `lines ${coverage.lines.covered}/${coverage.lines.total} (${coverage.lines.percent.toFixed(2)}%), branches ${coverage.branches.covered}/${coverage.branches.total} (${coverage.branches.percent.toFixed(2)}%)`;
  }
  const matrix = Object.entries(coverage.matrix)
    .map(([name, item]) => `${name}=${item.status}[${item.checkIds.join(", ") || "none"}]`)
    .join("; ");
  return `executable matrix: ${matrix}`;
}

function basisSummary(entries: StoredHarnessArtifact["checks"][number]["evidenceBasis"]): string {
  return entries
    .map((entry) => {
      const references = entry.references.map((reference) => reference.path).join(", ");
      return `${entry.source}: ${entry.detail}${references ? ` [${references}]` : ""}`;
    })
    .join(" | ");
}

export function renderAssuranceReport(profile: AssuranceProfile): string {
  const assuranceDecision =
    profile.status === "VERIFIED"
      ? "accepted after the final deterministic release gate"
      : profile.status === "RUNNING" && profile.phase === "verification-complete"
        ? "independent verification accepted; final release gate pending"
        : profile.verification.verdict === "accept"
          ? `rejected because the accept verdict retained ${profile.verification.findings.length} finding(s) and ${profile.verification.residualRisks.length} residual risk(s)`
          : `rejected: ${profile.reason}`;
  const commitLines = [
    `- Baseline B0: \`${profile.commits.b0}\``,
    `- Characterization C1: \`${profile.commits.c1}\``,
    `- Change harness T1: ${profile.commits.t1 ? `\`${profile.commits.t1}\`` : "not required"}`,
    `- Implementation I1: \`${profile.commits.i1}\``,
    `- Repair R1: ${profile.commits.r1 ? `\`${profile.commits.r1}\`` : "not used"}`,
  ];
  const traceabilityLines = profile.traceability.map(
    (claim) =>
      `| ${claim.kind} | \`${claim.id}\` | ${claim.statement} | ${claim.checkIds.map((id) => `\`${id}\``).join(", ") || "none"} |`,
  );
  const checkLines = profile.harness.checks.map((check) => {
    const mappings = [
      ...check.coveredCriteriaIds,
      ...check.coveredInvariantIds,
      ...check.coveredRiskIds,
    ];
    const boundaries = [
      check.failureBoundary ? `failure: ${check.failureBoundary}` : "",
      check.nonInterferenceTarget ? `non-interference: ${check.nonInterferenceTarget}` : "",
    ].filter(Boolean);
    return `- \`${check.id}\` (${check.kind}) in \`${check.testPath}\`: ${check.observable}; maps ${mappings.map((id) => `\`${id}\``).join(", ") || "none"}${boundaries.length > 0 ? `; ${boundaries.join("; ")}` : ""}; grounded by ${basisSummary(check.evidenceBasis)}`;
  });
  const commandLines = profile.commandGroups.flatMap((group) => [
    `- **${group.label}** - ${evidence(profile, group.artifactKey)}`,
    ...(group.commands.length > 0
      ? group.commands.map(
          (command) =>
            `  - \`${command.commandId}\` \`${command.command}\`: exit ${command.exitCode}, ${command.durationMs} ms${command.timedOut ? ", timeout" : ""}`,
        )
      : ["  - No registered command for this boundary."]),
  ]);
  const gapLines = profile.coverage.final.gaps.map(
    (gap) =>
      `- \`${gap.path}\`: ${gap.detail}; risks ${gap.relatedRiskIds.map((id) => `\`${id}\``).join(", ") || "none"}${gap.criticalBehavior ? "; **critical**" : ""}`,
  );
  const protectedLines = Object.entries(profile.harness.protectedHashes).map(
    ([path, hash]) => `- \`${path}\`: \`${hash}\``,
  );
  const reviewLines = profile.harnessReview.attempts.map(
    (attempt, index) =>
      `- Attempt ${index + 1}: **${attempt.verdict.toUpperCase()}** - ${attempt.reason}`,
  );
  const findingLines = profile.verification.findings.map(
    (finding) =>
      `- **${finding.severity} ${finding.code}**${finding.path ? ` \`${finding.path}\`` : ""}: ${finding.message}`,
  );
  const roleLines = profile.analytics.roleTurns.map(
    (turn) =>
      `| \`${turn.role}\` | \`${turn.phase}\` | ${turn.status} | ${metric(turn.durationMs)} | ${metric(turn.toolCalls)} | ${metric(turn.toolFailures)} | ${metric(turn.tokens.inputTokens)} | ${metric(turn.tokens.cachedInputTokens)} | ${metric(turn.tokens.nonCachedInputTokens)} | ${metric(turn.tokens.outputTokens)} | ${metric(turn.tokens.reasoningTokens)} |`,
  );
  const evidenceLines = profile.evidence.map(
    (item) => `- [${item.path}](${item.path}): \`${item.sha256}\``,
  );
  return `# ChangeSafely assurance report

## Task

${profile.task}

## Result

- Run id: \`${profile.runId}\`
- Status: \`${profile.status}\` / \`${profile.phase}\`
- Branch: \`${profile.branch}\`
- Selected plan: \`${profile.selectedPlanId}\`
- Final verifier: **${profile.verification.verdict.toUpperCase()}** - ${profile.verification.reason}
- Assurance decision: ${assuranceDecision}

\`VERIFIED\` means that the declared, evidence-linked assurance case passed its release gates. It is
not a claim of absolute safety beyond the recorded scope, environment, and rollback boundary.

Evidence: ${evidence(profile, "decision")}, ${evidence(profile, "verification")}.

## Git boundaries

${commitLines.join("\n")}

Evidence: ${evidence(profile, "characterization")}, ${evidence(profile, "harness")}, ${evidence(profile, "implementation")}${profile.commits.r1 ? `, ${evidence(profile, "repair")}` : ""}.

## Traceability

| Kind | ID | Declared behavior or risk | Executable checks |
| --- | --- | --- | --- |
${traceabilityLines.join("\n")}

Evidence: ${evidence(profile, "contract")}, ${evidence(profile, parsePlanArtifactKey(profile.selectedPlanId))}, ${evidence(profile, "harness")}.

## Protected checks

${checkLines.join("\n") || "No protected checks were recorded."}

Non-interference: **${profile.harness.nonInterference.status}**; targets ${profile.harness.nonInterference.targets.map((item) => `\`${item}\``).join(", ") || "none"}; checks ${profile.harness.nonInterference.checkIds.map((item) => `\`${item}\``).join(", ") || "none"}.

Grounding: ${basisSummary(profile.harness.nonInterference.evidenceBasis)}.

Evidence: ${evidence(profile, "harness")}.

## Harness review H1

${reviewLines.join("\n")}

- Corrections: ${profile.harnessReview.corrections.length}
- Final protected commit: \`${profile.harnessReview.finalHarnessCommit}\`

Evidence: ${evidence(profile, "harnessReview")}.

## Deterministic commands

${commandLines.join("\n")}

## Impacted coverage

- Scope: ${profile.coverage.final.impactedPaths.map((path) => `\`${path}\``).join(", ")}
- Baseline: ${coverageSummary(profile.coverage.baseline)}
- Final: ${coverageSummary(profile.coverage.final)}

${gapLines.length > 0 ? gapLines.join("\n") : "No recorded coverage gaps."}

Evidence: ${evidence(profile, "coverageBaseline")}, ${evidence(profile, profile.commits.r1 ? "coverageFinalRepair" : "coverageFinal")}.

## Protected harness integrity

${protectedLines.join("\n")}

Evidence: ${evidence(profile, "harness")}; final command replay: ${evidence(profile, profile.commits.r1 ? "verificationCommandsRepair" : "verificationCommands")}.

## Independent verification

${profile.verification.verdict.toUpperCase()}: ${profile.verification.reason}

${findingLines.length > 0 ? findingLines.join("\n") : "No findings."}

## Residual risks

${profile.verification.residualRisks.map((risk) => `- ${risk}`).join("\n") || "- None recorded."}

Evidence: ${evidence(profile, "verification")}.

## Run analytics

- Trace wall time: ${metric(profile.analytics.traceWallTimeMs)} ms
- Model time: ${profile.analytics.modelTimeMs} ms
- Command time: ${profile.analytics.commandTimeMs} ms
- Turns: ${profile.analytics.turns}; correction turns: ${profile.analytics.correctionTurns}
- Commands: ${profile.analytics.commands}; failures: ${profile.analytics.commandFailures}; timeouts: ${profile.analytics.commandTimeouts}
- Tool calls: ${metric(profile.analytics.toolCalls)}; failures: ${metric(profile.analytics.toolFailures)}
- Artifact volume: ${metric(profile.analytics.artifactBytes)} bytes
- Tokens: total ${metric(profile.analytics.tokens.totalTokens)}, input ${metric(profile.analytics.tokens.inputTokens)}, cached input ${metric(profile.analytics.tokens.cachedInputTokens)}, non-cached input ${metric(profile.analytics.tokens.nonCachedInputTokens)}, output ${metric(profile.analytics.tokens.outputTokens)}, reasoning ${metric(profile.analytics.tokens.reasoningTokens)}

| Role | Phase | Status | Time ms | Tools | Tool failures | Input | Cached | Non-cached | Output | Reasoning |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${roleLines.join("\n")}

Evidence: [trace.jsonl](trace.jsonl), [manifest.json](manifest.json).

## Evidence index

${evidenceLines.join("\n")}

## Rollback boundary

Discarding this branch returns tracked source code to B0. ChangeSafely does not roll back ignored files, local services, databases, queues, volumes, or external systems.

## Next action

${profile.nextAction}
`;
}

export async function implementationReport(repoPath: string, state: RunState): Promise<string> {
  return renderAssuranceReport(await loadAssuranceProfile(repoPath, state));
}
