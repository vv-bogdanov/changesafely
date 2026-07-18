import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePlan } from "../src/eligibility.js";
import type { ChangeContract, DetailedPlan } from "../src/schemas.js";

const contract: ChangeContract = {
  goal: "Change behavior",
  acceptanceCriteria: [{ id: "AC1", statement: "Behavior changes" }],
  protectedInvariants: [{ id: "INV1", statement: "API is stable" }],
  nonGoals: [],
  allowedPathPrefixes: ["src", "test"],
  approvalRequiredChanges: [],
  evidenceGaps: [],
  risks: [],
  unknowns: [],
};

const plan: DetailedPlan = {
  planId: "plan-1",
  lens: "minimal-change",
  title: "Small plan",
  approach: "Change one module",
  rationale: "Direct",
  acceptanceCoverage: [{ id: "AC1", strategy: "Acceptance test" }],
  invariantProtection: [{ id: "INV1", strategy: "Signature test" }],
  files: [{ path: "src/value.ts", purpose: "Implementation" }],
  steps: [{ id: "S1", description: "Implement", paths: ["src/value.ts"] }],
  safetyTests: [{ name: "test", proves: "AC1", argv: ["npm", "test"] }],
  verificationCommands: [{ name: "test", argv: ["npm", "test"], purpose: "Verify" }],
  dependencies: [],
  migrations: [],
  approvalRequiredChanges: [],
  risks: [],
  assumptions: [],
  unknowns: [],
  recovery: ["Revert implementation"],
  rejectionReasons: [],
};

test("accepts a complete in-scope plan", () => {
  assert.deepEqual(evaluatePlan(contract, plan), {
    planId: "plan-1",
    eligible: true,
    failures: [],
    humanDecisionReasons: [],
  });
});

test("rejects missing coverage and paths outside scope", () => {
  const result = evaluatePlan(contract, {
    ...plan,
    acceptanceCoverage: [],
    files: [{ path: "infra/prod.tf", purpose: "Unexpected" }],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["MISSING_ACCEPTANCE_COVERAGE", "OUTSIDE_ALLOWED_SCOPE"],
  );
});

test("requires human approval for a dependency", () => {
  const result = evaluatePlan(contract, { ...plan, dependencies: ["new-package"] });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.humanDecisionReasons, ["Dependency: new-package"]);
});

test("rejects a safety check that does not execute tests", () => {
  const result = evaluatePlan(contract, {
    ...plan,
    safetyTests: [
      { name: "not a test", proves: "AC1", argv: ["npm", "run", "typecheck"] },
    ],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.failures.map((failure) => failure.code), [
    "INVALID_SAFETY_COMMAND",
  ]);
});

test("rejects a direct source test command outside the npm MVP contract", () => {
  const result = evaluatePlan(contract, {
    ...plan,
    safetyTests: [
      { name: "direct source test", proves: "AC1", argv: ["node", "--test", "test/value.test.ts"] },
    ],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.failures[0]?.code, "INVALID_SAFETY_COMMAND");
});
