import assert from "node:assert/strict";
import test from "node:test";
import { verifierPrompt } from "../src/prompts.js";
import { validContract, validPlan } from "./support/artifacts.js";

test("Verifier receives separate harness and implementation boundaries", () => {
  const prompt = verifierPrompt({
    contract: validContract(),
    plan: validPlan(),
    decision: {
      winnerPlanId: "plan-1",
      reason: "Minimal eligible plan.",
      rejectedPlans: [],
      tradeoffs: [],
      residualRisks: [],
      humanDecisionRequired: false,
      humanDecisionReason: "",
    },
    baselineCommit: "b0",
    testCommit: "t1",
    implementationCommit: "i1",
    harnessDiff: "HARNESS_ONLY",
    implementationDiff: "IMPLEMENTATION_ONLY",
    commandResults: { harnessBaseline: [], final: [] },
  });

  assert.match(prompt, /T1 test additions are an intentional required workflow phase/u);
  assert.match(prompt, /Assess implementation scope only from the T1-to-I1 diff/u);
  assert.match(prompt, /"harnessDiff": "HARNESS_ONLY"/u);
  assert.match(prompt, /"implementationDiff": "IMPLEMENTATION_ONLY"/u);
});
