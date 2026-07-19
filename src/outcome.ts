import { resolve } from "node:path";
import { artifactDefinition } from "./artifact-catalog.js";
import { type ArtifactKey, isArtifactKey } from "./artifact-key.js";
import { loadRunState, loadVerifiedArtifact, type RunState } from "./artifacts.js";
import type { RunPhase, RunStatus } from "./schemas.js";

export const RUN_OUTCOME_VERSION = 1;

export interface RunOutcome {
  outcomeVersion: typeof RUN_OUTCOME_VERSION;
  runId: string;
  status: RunStatus;
  phase: RunPhase;
  reasonCode: string;
  reason: string;
  nextAction: string;
  selectedPlan: string | null;
  model: string | null;
  branch: string | null;
  testCommit: string | null;
  implementationCommit: string | null;
  runPath: string;
  statePath: string;
  reportPath: string;
  artifactPaths: Partial<Record<ArtifactKey, string>>;
}

export interface CliErrorOutcome {
  outcomeVersion: typeof RUN_OUTCOME_VERSION;
  status: "ERROR";
  reasonCode: string;
  reason: string;
  nextAction: string;
}

function reasonCode(state: Pick<RunState, "phase" | "status">): string {
  if (state.status === "PLANNED" || state.status === "VERIFIED") return state.status;
  return `${state.phase}_${state.status}`.replaceAll(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

export async function createRunOutcome(
  repoPath: string,
  state: RunState,
  reportPath = resolve(repoPath, ".safechange", "runs", state.runId, "report.md"),
  reasonCodeOverride?: string,
): Promise<RunOutcome> {
  const runPath = resolve(repoPath, ".safechange", "runs", state.runId);
  const artifactPaths: Partial<Record<ArtifactKey, string>> = {};
  for (const key of Object.keys(state.artifacts)) {
    if (isArtifactKey(key)) artifactPaths[key] = resolve(runPath, artifactDefinition(key).path);
  }
  const selectedPlan = state.artifacts.decision
    ? (await loadVerifiedArtifact(repoPath, state, "decision")).payload.winnerPlanId
    : null;
  return {
    outcomeVersion: RUN_OUTCOME_VERSION,
    runId: state.runId,
    status: state.status,
    phase: state.phase,
    reasonCode: reasonCodeOverride ?? reasonCode(state),
    reason: state.reason,
    nextAction: state.nextAction,
    selectedPlan,
    model: state.model || null,
    branch: state.branch || null,
    testCommit: state.testCommit || null,
    implementationCommit: state.implementationCommit || null,
    runPath,
    statePath: resolve(runPath, "state.json"),
    reportPath,
    artifactPaths,
  };
}

export async function loadRunOutcome(repoPath: string, runId: string): Promise<RunOutcome> {
  return createRunOutcome(repoPath, await loadRunState(repoPath, runId));
}

export function formatRunOutcome(outcome: RunOutcome): string {
  return [
    `Run: ${outcome.runId}`,
    `Phase: ${outcome.phase}`,
    `Selected plan: ${outcome.selectedPlan ?? "none"}`,
    `Status: ${outcome.status}`,
    `Model: ${outcome.model ?? "default"}`,
    ...(outcome.branch ? [`Branch: ${outcome.branch}`] : []),
    ...(outcome.testCommit ? [`T1: ${outcome.testCommit}`] : []),
    ...(outcome.implementationCommit ? [`Implementation: ${outcome.implementationCommit}`] : []),
    `Report: ${outcome.reportPath}`,
    `Reason: ${outcome.reason || "none"}`,
    `Next action: ${outcome.nextAction || "none"}`,
    "",
  ].join("\n");
}

export function formatJsonOutcome(outcome: RunOutcome | CliErrorOutcome): string {
  return `${JSON.stringify(outcome, null, 2)}\n`;
}

export function exitCodeForOutcome(outcome: RunOutcome): 0 | 1 | 2 {
  if (outcome.status === "PLANNED" || outcome.status === "VERIFIED") return 0;
  return outcome.status === "FAILED" ? 1 : 2;
}
