import { isDeepStrictEqual } from "node:util";
import type {
  HarnessReviewArtifact,
  StoredHarnessArtifact,
  VerificationArtifact,
} from "./schemas.js";

export const hashRecordsEqual: (
  expected: Record<string, string>,
  actual: Record<string, string>,
) => boolean = isDeepStrictEqual;

export function verificationAccepted(verification: VerificationArtifact): boolean {
  return (
    verification.verdict === "accept" &&
    verification.contractFulfilled &&
    verification.invariantsPreserved &&
    verification.scopeConformant &&
    verification.evidenceSufficient &&
    !verification.findings.some((finding) => finding.severity === "error")
  );
}

export function finalVerificationAccepted(verification: VerificationArtifact): boolean {
  return (
    verificationAccepted(verification) &&
    verification.findings.length === 0 &&
    verification.residualRisks.length === 0
  );
}

export function harnessReviewAccepted(
  review: HarnessReviewArtifact,
  harness: Pick<StoredHarnessArtifact, "checks" | "protectedPaths">,
): boolean {
  const lastAttempt = review.attempts.at(-1);
  const observations =
    lastAttempt?.findings.filter((finding) => finding.severity === "warning") ?? [];
  const knownChecks = harness.checks.map((check) => check.id);
  const correctionCommits = review.corrections.map((correction) => correction.commit);
  const correctionPaths = review.corrections.flatMap((correction) => correction.changedPaths);
  return (
    review.accepted &&
    review.attempts.length === review.corrections.length + 1 &&
    review.corrections.length <= 2 &&
    new Set(correctionCommits).size === correctionCommits.length &&
    (review.corrections.length === 0 || correctionCommits.at(-1) === review.finalHarnessCommit) &&
    new Set(correctionPaths).size === correctionPaths.length &&
    correctionPaths.every((path) => harness.protectedPaths.includes(path)) &&
    review.attempts.slice(0, -1).every((attempt) => !verificationAccepted(attempt)) &&
    Boolean(lastAttempt && verificationAccepted(lastAttempt)) &&
    observations.length > 0 &&
    observations.every(
      (finding) =>
        harness.protectedPaths.includes(finding.path) &&
        knownChecks.some((checkId) => finding.message.includes(checkId)),
    )
  );
}
