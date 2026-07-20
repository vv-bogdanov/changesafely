import {
  type ArtifactKey,
  artifactPath,
  isPlanArtifactKey,
  type PlanArtifactKey,
  type StaticArtifactKey,
} from "./artifact-key.js";
import * as Schema from "./schemas.js";

const validators = {
  evidence: Schema.validateEvidenceArtifact,
  contract: Schema.validateChangeContract,
  eligibility: Schema.validatePlanEligibilityList,
  decision: Schema.validateDecisionArtifact,
  characterization: Schema.validateStoredCharacterizationArtifact,
  characterizationCommands: Schema.validateCommandEvidenceList,
  coverageBaseline: Schema.validateCoverageEvidence,
  harness: Schema.validateStoredHarnessArtifact,
  commands: Schema.validateCommandEvidenceList,
  harnessReview: Schema.validateHarnessReviewArtifact,
  implementation: Schema.validateStoredImplementationArtifact,
  coverageFinal: Schema.validateCoverageEvidence,
  verificationCommands: Schema.validateCommandEvidenceList,
  verificationAttempt1: Schema.validateVerificationArtifact,
  repair: Schema.validateStoredImplementationArtifact,
  coverageFinalRepair: Schema.validateCoverageEvidence,
  verificationCommandsRepair: Schema.validateCommandEvidenceList,
  verification: Schema.validateVerificationArtifact,
};

type Validator<Value> = (value: unknown) => Value;
export type ArtifactInputHashes = Partial<Record<ArtifactKey, string>>;
export type ArtifactPayload<Key extends ArtifactKey> = Key extends PlanArtifactKey
  ? Schema.DetailedPlan
  : Key extends StaticArtifactKey
    ? ReturnType<(typeof validators)[Key]>
    : never;

export interface ArtifactDefinition<Value> {
  path: string;
  validate: Validator<Value>;
}

function sorted(keys: readonly ArtifactKey[]): ArtifactKey[] {
  return [...keys].sort();
}

function sameKeys(actual: readonly ArtifactKey[], expected: readonly ArtifactKey[]): boolean {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function hasOnePlan(keys: readonly ArtifactKey[], required: readonly StaticArtifactKey[]): boolean {
  return (
    keys.length === required.length + 1 &&
    required.every((key) => keys.includes(key)) &&
    keys.filter(isPlanArtifactKey).length === 1
  );
}

export function validateArtifactInputKeys(key: ArtifactKey, inputs: ArtifactKey[]): void {
  let valid: boolean;
  if (isPlanArtifactKey(key)) {
    valid = sameKeys(inputs, ["contract"]);
  } else {
    switch (key) {
      case "evidence":
        valid = inputs.length === 0;
        break;
      case "contract":
        valid = sameKeys(inputs, ["evidence"]);
        break;
      case "eligibility":
        valid =
          inputs.includes("contract") &&
          inputs.length >= 2 &&
          inputs.length <= 6 &&
          inputs.filter(isPlanArtifactKey).length === inputs.length - 1;
        break;
      case "decision":
        valid = sameKeys(inputs, ["contract", "eligibility"]);
        break;
      case "characterization":
        valid = hasOnePlan(inputs, ["contract", "decision"]);
        break;
      case "characterizationCommands":
        valid = sameKeys(inputs, ["characterization"]);
        break;
      case "coverageBaseline":
        valid = sameKeys(inputs, ["characterization"]);
        break;
      case "harness":
        valid =
          hasOnePlan(inputs, ["contract", "decision"]) ||
          hasOnePlan(inputs, ["characterization", "contract", "decision"]) ||
          hasOnePlan(inputs, ["characterization", "contract", "coverageBaseline", "decision"]);
        break;
      case "commands":
        valid = sameKeys(inputs, ["harness"]);
        break;
      case "harnessReview":
        valid = hasOnePlan(inputs, [
          "characterization",
          "characterizationCommands",
          "commands",
          "contract",
          "coverageBaseline",
          "decision",
          "harness",
        ]);
        break;
      case "implementation":
        valid =
          hasOnePlan(inputs, ["decision", "harness"]) ||
          hasOnePlan(inputs, ["decision", "harness", "harnessReview"]);
        break;
      case "coverageFinal":
        valid = sameKeys(inputs, ["coverageBaseline", "implementation"]);
        break;
      case "verificationCommands":
        valid = sameKeys(inputs, ["implementation"]);
        break;
      case "verificationAttempt1":
        valid =
          sameKeys(inputs, ["implementation", "verificationCommands"]) ||
          sameKeys(inputs, ["coverageFinal", "implementation", "verificationCommands"]);
        break;
      case "repair":
        valid = sameKeys(inputs, ["verificationAttempt1"]);
        break;
      case "coverageFinalRepair":
        valid = sameKeys(inputs, ["coverageBaseline", "repair"]);
        break;
      case "verificationCommandsRepair":
        valid = sameKeys(inputs, ["repair"]);
        break;
      case "verification":
        valid =
          sameKeys(inputs, ["implementation", "verificationCommands"]) ||
          sameKeys(inputs, ["repair", "verificationCommandsRepair"]) ||
          sameKeys(inputs, ["coverageFinal", "implementation", "verificationCommands"]) ||
          sameKeys(inputs, ["coverageFinalRepair", "repair", "verificationCommandsRepair"]);
        break;
    }
  }
  if (!valid) {
    throw new Error(`Artifact input contract mismatch for ${key}: ${sorted(inputs).join(", ")}`);
  }
}

export function artifactDefinition<Key extends ArtifactKey>(
  key: Key,
  artifactVersion = Schema.ARTIFACT_VERSION,
): ArtifactDefinition<ArtifactPayload<Key>> {
  const legacyContract = artifactVersion === Schema.LEGACY_ARTIFACT_VERSION;
  if (isPlanArtifactKey(key)) {
    return {
      path: artifactPath(key),
      validate: legacyContract
        ? (value) => Schema.validatePersistedDetailedPlan(value, Schema.LEGACY_ARTIFACT_VERSION)
        : Schema.validateDetailedPlan,
    } as ArtifactDefinition<ArtifactPayload<Key>>;
  }
  const staticKey = key as StaticArtifactKey;
  let validate = validators[staticKey] as Validator<ArtifactPayload<Key>>;
  if (legacyContract && staticKey === "contract") {
    validate = ((value: unknown) =>
      Schema.validatePersistedChangeContract(value, Schema.LEGACY_ARTIFACT_VERSION)) as Validator<
      ArtifactPayload<Key>
    >;
  } else if (staticKey === "harness") {
    validate = ((value: unknown) =>
      Schema.validatePersistedStoredHarnessArtifact(value, artifactVersion)) as Validator<
      ArtifactPayload<Key>
    >;
  } else if (staticKey === "characterization") {
    validate = ((value: unknown) =>
      Schema.validatePersistedStoredCharacterizationArtifact(value, artifactVersion)) as Validator<
      ArtifactPayload<Key>
    >;
  }
  return {
    path: artifactPath(key),
    validate,
  };
}
