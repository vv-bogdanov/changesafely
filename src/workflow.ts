import { resolve } from "node:path";
import { AppServerClient } from "./app-server/client.js";
import { type ArtifactKey, type PlanArtifactKey, planArtifactKey } from "./artifact-key.js";
import { ArtifactStore, createRunId, type RunState, type RunStatus } from "./artifacts.js";
import { evaluatePlan, evaluatePlans, type PlanEligibility } from "./eligibility.js";
import { assertBaselineUnchanged, inspectBaseline } from "./git.js";
import {
  contractPrompt,
  discoveryPrompt,
  judgeCorrectionPrompt,
  judgePrompt,
  plannerCorrectionPrompt,
  plannerPrompt,
} from "./prompts.js";
import { planningReport } from "./report.js";
import {
  completeContext,
  parseRoleArtifact,
  readOnlyPolicy,
  startContext,
} from "./role-runtime.js";
import {
  changeContractSchema,
  type DecisionArtifact,
  type DetailedPlan,
  decisionArtifactSchema,
  detailedPlanSchema,
  evidenceArtifactSchema,
  validateChangeContract,
  validateDecisionArtifact,
  validateDetailedPlan,
  validateEvidenceArtifact,
} from "./schemas.js";

const plannerLenses = [
  "minimal-change",
  "reversible-change",
  "risk-first",
  "testability-first",
  "operations-first",
] as const;

export interface PlanningOptions {
  repoPath: string;
  task: string;
  plannerCount: number;
  clientFactory?: () => AppServerClient;
  parallelPlanners?: boolean;
  model?: string;
  signal?: AbortSignal;
}

export interface PlanningResult {
  runId: string;
  runPath: string;
  reportPath: string;
  status: RunStatus;
  decision?: DecisionArtifact;
}

export async function runPlanning(options: PlanningOptions): Promise<PlanningResult> {
  const repoPath = resolve(options.repoPath);
  const roleEffort = options.model ? "medium" : "low";
  const baseline = await inspectBaseline(repoPath);
  const runId = createRunId();
  const store = new ArtifactStore(baseline.repoPath, runId, baseline.commit);
  await store.initialize();

  const state: RunState = {
    runId,
    task: options.task,
    repoPath: baseline.repoPath,
    baselineCommit: baseline.commit,
    baselineFingerprint: baseline.fingerprint,
    baselineProtectedConfiguration: baseline.protectedConfiguration,
    phase: "preflight",
    status: "RUNNING",
    reason: "",
    nextAction: "Wait for planning to complete.",
    artifacts: {},
    contexts: [],
    branch: "",
    testCommit: "",
    implementationCommit: "",
    repairCount: 0,
    model: options.model ?? "",
  };
  await store.writeState(state);

  const client =
    options.clientFactory?.() ??
    new AppServerClient({
      cwd: baseline.repoPath,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  const plans: DetailedPlan[] = [];
  let eligibility: PlanEligibility[] = [];
  let decision: DecisionArtifact | undefined;

  const persist = async (phase: string): Promise<void> => {
    state.phase = phase;
    await store.writeState(state);
  };
  const addArtifact = (name: ArtifactKey, artifactHash: string): void => {
    state.artifacts[name] = artifactHash;
  };

  try {
    await client.start();

    await persist("discovery");
    const discoveryThread = await client.startThread({
      cwd: baseline.repoPath,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const discoveryContext = startContext("discovery", discoveryThread.thread.id, null, null);
    state.contexts.push(discoveryContext);
    await store.writeState(state);
    const discoveryTurn = await client.runTurn(
      discoveryThread.thread.id,
      discoveryPrompt(options.task),
      {
        cwd: baseline.repoPath,
        sandboxPolicy: readOnlyPolicy,
        effort: roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: evidenceArtifactSchema,
      },
    );
    completeContext(discoveryContext, discoveryTurn.turnId);
    const evidence = parseRoleArtifact(discoveryTurn.message, validateEvidenceArtifact);
    const evidenceStored = await store.writeArtifact("evidence", "discovery", evidence);
    addArtifact("evidence", evidenceStored.hash);
    await store.writeState(state);

    await persist("contract");
    const contractThread = await client.startThread({
      cwd: baseline.repoPath,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const contractContext = startContext("contract", contractThread.thread.id, null, null);
    state.contexts.push(contractContext);
    await store.writeState(state);
    const contractTurn = await client.runTurn(
      contractThread.thread.id,
      contractPrompt(options.task, evidence),
      {
        cwd: baseline.repoPath,
        sandboxPolicy: readOnlyPolicy,
        effort: roleEffort,
        ...(options.model ? { model: options.model } : {}),
        outputSchema: changeContractSchema,
      },
    );
    completeContext(contractContext, contractTurn.turnId);
    const contractArtifact = parseRoleArtifact(contractTurn.message, validateChangeContract);
    const contractStored = await store.writeArtifact("contract", "contract", contractArtifact, [
      evidenceStored.hash,
    ]);
    addArtifact("contract", contractStored.hash);
    await store.writeState(state);

    await persist("planners");
    const plannerRuns: Array<() => Promise<{ planId: PlanArtifactKey; plan: DetailedPlan }>> = [];
    for (let index = 0; index < options.plannerCount; index += 1) {
      const planId = planArtifactKey(index + 1);
      const lens = plannerLenses[index];
      if (!lens) throw new Error(`No planner lens for index ${index}`);
      const fork = await client.forkThread({
        threadId: contractThread.thread.id,
        lastTurnId: contractTurn.turnId,
        cwd: baseline.repoPath,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const plannerContext = startContext(
        `planner:${planId}`,
        fork.thread.id,
        contractThread.thread.id,
        contractTurn.turnId,
      );
      state.contexts.push(plannerContext);
      plannerRuns.push(async () => {
        const plannerTurn = await client.runTurn(
          fork.thread.id,
          plannerPrompt(planId, lens, contractArtifact),
          {
            cwd: baseline.repoPath,
            sandboxPolicy: readOnlyPolicy,
            effort: roleEffort,
            ...(options.model ? { model: options.model } : {}),
            outputSchema: detailedPlanSchema,
          },
        );
        completeContext(plannerContext, plannerTurn.turnId);
        let plan = parseRoleArtifact(plannerTurn.message, validateDetailedPlan);
        if (plan.planId !== planId || plan.lens !== lens) {
          throw new Error(
            `Planner identity mismatch: expected ${planId}/${lens}, got ${plan.planId}/${plan.lens}`,
          );
        }
        const firstGate = evaluatePlan(contractArtifact, plan);
        if (!firstGate.eligible) {
          const correctionContext = startContext(
            `planner-correction:${planId}`,
            fork.thread.id,
            contractThread.thread.id,
            plannerTurn.turnId,
          );
          state.contexts.push(correctionContext);
          const correctionTurn = await client.runTurn(
            fork.thread.id,
            plannerCorrectionPrompt(planId, lens, contractArtifact, plan, firstGate),
            {
              cwd: baseline.repoPath,
              sandboxPolicy: readOnlyPolicy,
              effort: roleEffort,
              ...(options.model ? { model: options.model } : {}),
              outputSchema: detailedPlanSchema,
            },
          );
          completeContext(correctionContext, correctionTurn.turnId);
          plan = parseRoleArtifact(correctionTurn.message, validateDetailedPlan);
          if (plan.planId !== planId || plan.lens !== lens) {
            throw new Error(
              `Corrected planner identity mismatch: expected ${planId}/${lens}, got ${plan.planId}/${plan.lens}`,
            );
          }
        }
        return { planId, plan };
      });
    }
    await store.writeState(state);
    const plannerResults = options.parallelPlanners
      ? await Promise.all(plannerRuns.map((run) => run()))
      : await plannerRuns.reduce<Promise<Array<{ planId: PlanArtifactKey; plan: DetailedPlan }>>>(
          async (previous, run) => [...(await previous), await run()],
          Promise.resolve([]),
        );
    for (const { planId, plan } of plannerResults) {
      plans.push(plan);
      const stored = await store.writeArtifact(planId, `planner:${planId}`, plan, [
        contractStored.hash,
      ]);
      addArtifact(planId, stored.hash);
    }
    await store.writeState(state);

    await persist("eligibility");
    eligibility = evaluatePlans(contractArtifact, plans);
    const eligibilityStored = await store.writeArtifact(
      "eligibility",
      "deterministic-eligibility",
      eligibility,
      plans.map((plan) => state.artifacts[plan.planId] ?? ""),
    );
    addArtifact("eligibility", eligibilityStored.hash);
    const eligiblePlanIds = new Set(
      eligibility.filter((item) => item.eligible).map((item) => item.planId),
    );
    const eligiblePlans = plans.filter((plan) => eligiblePlanIds.has(plan.planId));

    if (eligiblePlans.length === 0) {
      const humanReasons = eligibility.flatMap((item) => item.humanDecisionReasons);
      state.status = humanReasons.length > 0 ? "HUMAN_DECISION_REQUIRED" : "BLOCKED";
      state.reason =
        humanReasons.length > 0
          ? humanReasons.join("; ")
          : "No plan passed deterministic eligibility gates.";
      state.nextAction =
        humanReasons.length > 0
          ? "Approve or reject the declared sensitive changes, then start a new plan run."
          : "Resolve the reported evidence, scope, or verification gaps and start a new run.";
    } else {
      await persist("judge");
      const judgeFork = await client.forkThread({
        threadId: contractThread.thread.id,
        lastTurnId: contractTurn.turnId,
        cwd: baseline.repoPath,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const judgeContext = startContext(
        "judge",
        judgeFork.thread.id,
        contractThread.thread.id,
        contractTurn.turnId,
      );
      state.contexts.push(judgeContext);
      await store.writeState(state);
      const judgeTurn = await client.runTurn(
        judgeFork.thread.id,
        judgePrompt(contractArtifact, eligiblePlans, eligibility),
        {
          cwd: baseline.repoPath,
          sandboxPolicy: readOnlyPolicy,
          effort: roleEffort,
          ...(options.model ? { model: options.model } : {}),
          outputSchema: decisionArtifactSchema,
        },
      );
      completeContext(judgeContext, judgeTurn.turnId);
      decision = parseRoleArtifact(judgeTurn.message, validateDecisionArtifact);
      if (decision.humanDecisionRequired) {
        const correctionContext = startContext(
          "judge-correction",
          judgeFork.thread.id,
          contractThread.thread.id,
          judgeTurn.turnId,
        );
        state.contexts.push(correctionContext);
        const correctionTurn = await client.runTurn(
          judgeFork.thread.id,
          judgeCorrectionPrompt(contractArtifact, eligiblePlans, eligibility, decision),
          {
            cwd: baseline.repoPath,
            sandboxPolicy: readOnlyPolicy,
            effort: roleEffort,
            ...(options.model ? { model: options.model } : {}),
            outputSchema: decisionArtifactSchema,
          },
        );
        completeContext(correctionContext, correctionTurn.turnId);
        decision = parseRoleArtifact(correctionTurn.message, validateDecisionArtifact);
      }
      if (!eligiblePlanIds.has(decision.winnerPlanId)) {
        throw new Error(`Judge selected ineligible or unknown plan ${decision.winnerPlanId}`);
      }
      const decisionStored = await store.writeArtifact("decision", "judge", decision, [
        contractStored.hash,
        eligibilityStored.hash,
      ]);
      addArtifact("decision", decisionStored.hash);
      if (decision.humanDecisionRequired) {
        state.status = "HUMAN_DECISION_REQUIRED";
        state.reason = decision.humanDecisionReason;
        state.nextAction = "Resolve the Judge's explicit human decision before implementation.";
      } else {
        state.status = "PLANNED";
        state.reason = `Selected ${decision.winnerPlanId}: ${decision.reason}`;
        state.nextAction =
          "Run SafeChange with the approved selected plan to create the safety harness.";
      }
    }

    await assertBaselineUnchanged(baseline);
    state.phase = "planning-complete";
    await store.writeState(state);
    const reportPath = await store.writeText(
      "report.md",
      planningReport(state, plans, eligibility, decision),
    );
    return {
      runId,
      runPath: store.runPath,
      reportPath,
      status: state.status,
      ...(decision ? { decision } : {}),
    };
  } catch (error) {
    state.status = "FAILED";
    state.phase = "failed";
    state.reason = error instanceof Error ? error.message : String(error);
    state.nextAction =
      "Inspect state.json and the last role artifact, then fix the cause and retry.";
    await store.writeState(state);
    await store.writeText("report.md", planningReport(state, plans, eligibility, decision));
    throw error;
  } finally {
    await client.close();
  }
}
