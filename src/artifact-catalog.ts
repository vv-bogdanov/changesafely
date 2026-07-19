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
  harness: Schema.validateStoredHarnessArtifact,
  commands: Schema.validateCommandEvidenceList,
  implementation: Schema.validateStoredImplementationArtifact,
  verificationCommands: Schema.validateCommandEvidenceList,
  verificationAttempt1: Schema.validateVerificationArtifact,
  repair: Schema.validateStoredImplementationArtifact,
  verificationCommandsRepair: Schema.validateCommandEvidenceList,
  verification: Schema.validateVerificationArtifact,
};

type Validator<Value> = (value: unknown) => Value;
export type ArtifactPayload<Key extends ArtifactKey> = Key extends PlanArtifactKey
  ? Schema.DetailedPlan
  : Key extends StaticArtifactKey
    ? ReturnType<(typeof validators)[Key]>
    : never;

export interface ArtifactDefinition<Value> {
  path: string;
  validate: Validator<Value>;
}

export function artifactDefinition<Key extends ArtifactKey>(
  key: Key,
): ArtifactDefinition<ArtifactPayload<Key>> {
  if (isPlanArtifactKey(key)) {
    return { path: artifactPath(key), validate: Schema.validateDetailedPlan } as ArtifactDefinition<
      ArtifactPayload<Key>
    >;
  }
  const staticKey = key as StaticArtifactKey;
  return {
    path: artifactPath(key),
    validate: validators[staticKey] as Validator<ArtifactPayload<Key>>,
  };
}
