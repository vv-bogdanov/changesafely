import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePlan } from "../src/eligibility.js";
import { validContract, validPlan } from "./support/artifacts.js";

const contract = validContract();
const plan = validPlan();

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
    safetyTests: [{ name: "not a test", proves: "AC1", argv: ["npm", "run", "typecheck"] }],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["INVALID_SAFETY_COMMAND"],
  );
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
