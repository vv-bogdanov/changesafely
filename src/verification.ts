import { isDeepStrictEqual } from "node:util";
import type { VerificationArtifact } from "./schemas.js";

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
