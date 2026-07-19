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
          commandId: "command-1",
          command: "npm test",
          argv: ["npm", "test"],
          cwd: ".",
          startedAt: "2026-07-19T00:00:00.000Z",
          completedAt: "2026-07-19T00:00:00.001Z",
          exitCode: 0,
          signal: null,
          timedOut: false,
          sandboxed: true,
          durationMs: -1,
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutSha256: "a".repeat(64),
          stderrSha256: "b".repeat(64),
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ]),
    ArtifactValidationError,
  );
});
