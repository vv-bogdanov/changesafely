import type {
  ChangeContract,
  DetailedPlan,
  EvidenceArtifact,
} from "./schemas.js";
import type { PlanEligibility } from "./eligibility.js";

function data(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function discoveryPrompt(task: string): string {
  return `[SAFECHANGE_ROLE:discovery]
You are SafeChange Scratch Discovery D0. Work read-only. Do not edit files, use network, read .env/secret files, or expose credentials.

User task:
${task}

Inspect only the relevant repository surface. Return verified facts with repository-relative file references, safe non-interactive test/build/typecheck command argv, test gaps, constraints from instruction files, assumptions, and unknowns. Do not propose an implementation plan. Return only the schema-constrained JSON object.`;
}

export function contractPrompt(task: string, evidence: EvidenceArtifact): string {
  return `[SAFECHANGE_ROLE:contract]
You are SafeChange Canonical Contract C0 in a clean root thread. Work read-only and network-off. Do not inherit discovery speculation: use only the user intent and validated evidence below, and re-check a fact only when essential.

User task:
${task}

Validated evidence:
${data(evidence)}

Create a concise Change Contract. Give every acceptance criterion and protected invariant a stable unique id. allowedPathPrefixes must be repository-relative path prefixes sufficient for the task, never absolute paths. Mark changes needing human approval. Return only the schema-constrained JSON object.`;
}

export function plannerPrompt(
  planId: string,
  lens: string,
  contract: ChangeContract,
): string {
  return `[SAFECHANGE_ROLE:planner]
You are independent planner ${planId}, forked directly from C0. Your lens is: ${lens}.

Produce one self-contained detailed plan grounded in the repository. Set planId exactly to ${planId} and lens exactly to ${lens}. Cover contract ids exactly, declare every file path, dependency, migration, approval-sensitive change, risk, assumption, and unknown. Commands must be non-interactive argv arrays. The dependencies array contains only actual new package names, migrations contains only actual migrations, and approvalRequiredChanges contains only sensitive changes this plan really performs. Use an empty array when there are none; never put "none", policy reminders, or negative sentences in those three arrays. Acknowledge rejection reasons when this lens is unsuitable. Do not edit files. Return only the schema-constrained JSON object.

Canonical contract for explicit reference:
${data(contract)}`;
}

export function judgePrompt(
  contract: ChangeContract,
  plans: DetailedPlan[],
  eligibility: PlanEligibility[],
): string {
  return `[SAFECHANGE_ROLE:judge]
You are SafeChange Judge, forked directly from C0. Compare only the validated eligible plans and deterministic gate results below. Choose the simplest admissible plan that fully meets the contract. Do not use numerical scores. Explain the winner, concrete rejection reasons, tradeoffs, and residual risks. winnerPlanId must name one supplied eligible plan. Return only the schema-constrained JSON object.

Contract:
${data(contract)}

Plans:
${data(plans)}

Eligibility:
${data(eligibility)}`;
}
