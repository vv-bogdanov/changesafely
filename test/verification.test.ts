import assert from "node:assert/strict";
import test from "node:test";
import type { HarnessReviewArtifact, VerificationArtifact } from "../src/schemas.js";
import { harnessReviewAccepted, verificationAccepted } from "../src/verification.js";
import { validHarness } from "./support/artifacts.js";

function attempt(verdict: "accept" | "reject"): VerificationArtifact {
  const accepted = verdict === "accept";
  return {
    verdict,
    contractFulfilled: accepted,
    invariantsPreserved: true,
    scopeConformant: true,
    evidenceSufficient: accepted,
    reason: accepted ? "Harness is sufficient." : "Harness needs correction.",
    findings: accepted
      ? [
          {
            code: "GREEN_WRONG_CAUGHT",
            severity: "warning",
            message: "CHK-INV1 rejects the unsafe implementation.",
            path: "test/value.characterization.test.ts",
          },
        ]
      : [{ code: "GAP", severity: "error", message: "Missing edge evidence.", path: "test/x" }],
    residualRisks: [],
  };
}

function review(overrides: Partial<HarnessReviewArtifact> = {}): HarnessReviewArtifact {
  return {
    accepted: true,
    finalHarnessCommit: "a".repeat(40),
    attempts: [attempt("accept")],
    corrections: [],
    ...overrides,
  };
}

test("accepts only a consistent bounded harness review sequence", () => {
  const harness = validHarness();
  const correctedHarness = validHarness({
    protectedPaths: [...harness.protectedPaths, "test/edge.test.ts"],
  });
  assert.equal(verificationAccepted(attempt("accept")), true);
  assert.equal(harnessReviewAccepted(review(), harness), true);
  assert.equal(
    harnessReviewAccepted(
      review({
        finalHarnessCommit: "b".repeat(40),
        attempts: [attempt("reject"), attempt("accept")],
        corrections: [{ commit: "b".repeat(40), changedPaths: ["test/edge.test.ts"] }],
      }),
      correctedHarness,
    ),
    true,
  );
  assert.equal(harnessReviewAccepted(review({ accepted: false }), harness), false);
  assert.equal(harnessReviewAccepted(review({ attempts: [attempt("reject")] }), harness), false);
  const unmapped = attempt("accept");
  const observation = unmapped.findings[0];
  if (observation) observation.message = "An unsafe implementation exists.";
  assert.equal(harnessReviewAccepted(review({ attempts: [unmapped] }), harness), false);
  assert.equal(
    harnessReviewAccepted(review({ attempts: [attempt("accept"), attempt("accept")] }), harness),
    false,
  );
  assert.equal(
    harnessReviewAccepted(
      review({
        attempts: [attempt("reject"), attempt("accept")],
        corrections: [{ commit: "b".repeat(40), changedPaths: ["test/edge.test.ts"] }],
      }),
      correctedHarness,
    ),
    false,
  );
});
