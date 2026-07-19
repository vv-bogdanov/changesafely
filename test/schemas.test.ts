import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactValidationError,
  validateCommandEvidenceList,
  validatePlanEligibilityList,
  validateSmokeArtifact,
} from "../src/schemas.js";

test("accepts a valid structured artifact", () => {
  assert.deepEqual(validateSmokeArtifact({ kind: "smoke", message: "ready" }), {
    kind: "smoke",
    message: "ready",
  });
});

test("rejects malformed structured artifacts", () => {
  assert.throws(
    () => validateSmokeArtifact({ kind: "smoke", message: "" }),
    ArtifactValidationError,
  );
});

test("validates persisted deterministic evidence", () => {
  assert.equal(
    validatePlanEligibilityList([
      {
        planId: "plan-1",
        eligible: true,
        failures: [],
        humanDecisionReasons: [],
      },
    ])[0]?.planId,
    "plan-1",
  );
  assert.throws(
    () =>
      validateCommandEvidenceList([
        {
          command: "npm test",
          exitCode: 0,
          signal: null,
          timedOut: false,
          sandboxed: true,
          durationMs: -1,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ]),
    ArtifactValidationError,
  );
});
