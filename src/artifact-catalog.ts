import {
  type ArtifactKey,
  artifactPath,
  isPlanArtifactKey,
  type PlanArtifactKey,
  type StaticArtifactKey,
} from "./artifact-key.js";
import {
  type ChangeContract,
  type CommandEvidence,
  type DecisionArtifact,
  type DetailedPlan,
  type EvidenceArtifact,
  type PlanEligibility,
  type StoredHarnessArtifact,
  type StoredImplementationArtifact,
  type VerificationArtifact,
  validateChangeContract,
  validateCommandEvidenceList,
  validateDecisionArtifact,
  validateDetailedPlan,
  validateEvidenceArtifact,
  validatePlanEligibilityList,
  validateStoredHarnessArtifact,
  validateStoredImplementationArtifact,
  validateVerificationArtifact,
} from "./schemas.js";

interface StaticArtifactPayloads {
  evidence: EvidenceArtifact;
  contract: ChangeContract;
  eligibility: PlanEligibility[];
  decision: DecisionArtifact;
  harness: StoredHarnessArtifact;
  commands: CommandEvidence[];
  implementation: StoredImplementationArtifact;
  verificationCommands: CommandEvidence[];
  verificationAttempt1: VerificationArtifact;
  repair: StoredImplementationArtifact;
  verificationCommandsRepair: CommandEvidence[];
  verification: VerificationArtifact;
}

type ArtifactPayloads = StaticArtifactPayloads & Record<PlanArtifactKey, DetailedPlan>;
export type ArtifactPayload<Key extends ArtifactKey> = ArtifactPayloads[Key];

type Validator<Value> = (value: unknown) => Value;

const validators: { [Key in StaticArtifactKey]: Validator<StaticArtifactPayloads[Key]> } = {
  evidence: validateEvidenceArtifact,
  contract: validateChangeContract,
  eligibility: validatePlanEligibilityList,
  decision: validateDecisionArtifact,
  harness: validateStoredHarnessArtifact,
  commands: validateCommandEvidenceList,
  implementation: validateStoredImplementationArtifact,
  verificationCommands: validateCommandEvidenceList,
  verificationAttempt1: validateVerificationArtifact,
  repair: validateStoredImplementationArtifact,
  verificationCommandsRepair: validateCommandEvidenceList,
  verification: validateVerificationArtifact,
};

export interface ArtifactDefinition<Value> {
  path: string;
  validate: Validator<Value>;
}

export function artifactDefinition<Key extends ArtifactKey>(
  key: Key,
): ArtifactDefinition<ArtifactPayload<Key>> {
  if (isPlanArtifactKey(key)) {
    return { path: artifactPath(key), validate: validateDetailedPlan } as ArtifactDefinition<
      ArtifactPayload<Key>
    >;
  }
  const staticKey = key as StaticArtifactKey;
  return {
    path: artifactPath(key),
    validate: validators[staticKey] as Validator<ArtifactPayload<Key>>,
  };
}
