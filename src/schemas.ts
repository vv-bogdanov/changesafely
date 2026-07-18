import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export interface EvidenceReference {
  path: string;
  detail: string;
}

export interface EvidenceFact {
  id: string;
  claim: string;
  references: EvidenceReference[];
}

export interface CommandSpec {
  name: string;
  argv: string[];
  purpose: string;
}

export interface EvidenceArtifact {
  summary: string;
  facts: EvidenceFact[];
  commands: CommandSpec[];
  testGaps: string[];
  constraints: string[];
  assumptions: string[];
  unknowns: string[];
}

export interface ContractItem {
  id: string;
  statement: string;
}

export interface ChangeContract {
  goal: string;
  acceptanceCriteria: ContractItem[];
  protectedInvariants: ContractItem[];
  nonGoals: string[];
  allowedPathPrefixes: string[];
  approvalRequiredChanges: string[];
  evidenceGaps: string[];
  risks: string[];
  unknowns: string[];
}

export interface CoverageItem {
  id: string;
  strategy: string;
}

export interface PlannedFile {
  path: string;
  purpose: string;
}

export interface PlanStep {
  id: string;
  description: string;
  paths: string[];
}

export interface SafetyTest {
  name: string;
  proves: string;
  argv: string[];
}

export interface PlanUnknown {
  description: string;
  critical: boolean;
  resolution: string;
}

export interface DetailedPlan {
  planId: string;
  lens: string;
  title: string;
  approach: string;
  rationale: string;
  acceptanceCoverage: CoverageItem[];
  invariantProtection: CoverageItem[];
  files: PlannedFile[];
  steps: PlanStep[];
  safetyTests: SafetyTest[];
  verificationCommands: CommandSpec[];
  dependencies: string[];
  migrations: string[];
  approvalRequiredChanges: string[];
  risks: string[];
  assumptions: string[];
  unknowns: PlanUnknown[];
  recovery: string[];
  rejectionReasons: string[];
}

export interface RejectedPlan {
  planId: string;
  reason: string;
}

export interface DecisionArtifact {
  winnerPlanId: string;
  reason: string;
  rejectedPlans: RejectedPlan[];
  tradeoffs: string[];
  residualRisks: string[];
  humanDecisionRequired: boolean;
  humanDecisionReason: string;
}

export interface HarnessArtifact {
  summary: string;
  testPaths: string[];
  fixturePaths: string[];
  targetedCommand: CommandSpec;
  expectedBaselineOutcome: "fail" | "pass";
  expectedFailure: string;
  protectedPaths: string[];
}

export interface SmokeArtifact {
  kind: "smoke";
  message: string;
}

const stringSchema = { type: "string", minLength: 1 } as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;
const referenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "detail"],
  properties: { path: stringSchema, detail: { type: "string" } },
} as const;
const commandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "argv", "purpose"],
  properties: {
    name: stringSchema,
    argv: { type: "array", minItems: 1, items: stringSchema },
    purpose: stringSchema,
  },
} as const;
const contractItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "statement"],
  properties: { id: stringSchema, statement: stringSchema },
} as const;
const coverageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "strategy"],
  properties: { id: stringSchema, strategy: stringSchema },
} as const;

export const smokeArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "message"],
  properties: {
    kind: { type: "string", const: "smoke" },
    message: stringSchema,
  },
} as const;

export const evidenceArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "facts",
    "commands",
    "testGaps",
    "constraints",
    "assumptions",
    "unknowns",
  ],
  properties: {
    summary: stringSchema,
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "claim", "references"],
        properties: {
          id: stringSchema,
          claim: stringSchema,
          references: { type: "array", items: referenceSchema },
        },
      },
    },
    commands: { type: "array", items: commandSchema },
    testGaps: stringArraySchema,
    constraints: stringArraySchema,
    assumptions: stringArraySchema,
    unknowns: stringArraySchema,
  },
} as const;

export const changeContractSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "goal",
    "acceptanceCriteria",
    "protectedInvariants",
    "nonGoals",
    "allowedPathPrefixes",
    "approvalRequiredChanges",
    "evidenceGaps",
    "risks",
    "unknowns",
  ],
  properties: {
    goal: stringSchema,
    acceptanceCriteria: {
      type: "array",
      minItems: 1,
      items: contractItemSchema,
    },
    protectedInvariants: {
      type: "array",
      minItems: 1,
      items: contractItemSchema,
    },
    nonGoals: stringArraySchema,
    allowedPathPrefixes: {
      type: "array",
      minItems: 1,
      items: stringSchema,
    },
    approvalRequiredChanges: stringArraySchema,
    evidenceGaps: stringArraySchema,
    risks: stringArraySchema,
    unknowns: stringArraySchema,
  },
} as const;

export const detailedPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "planId",
    "lens",
    "title",
    "approach",
    "rationale",
    "acceptanceCoverage",
    "invariantProtection",
    "files",
    "steps",
    "safetyTests",
    "verificationCommands",
    "dependencies",
    "migrations",
    "approvalRequiredChanges",
    "risks",
    "assumptions",
    "unknowns",
    "recovery",
    "rejectionReasons",
  ],
  properties: {
    planId: stringSchema,
    lens: stringSchema,
    title: stringSchema,
    approach: stringSchema,
    rationale: stringSchema,
    acceptanceCoverage: { type: "array", items: coverageSchema },
    invariantProtection: { type: "array", items: coverageSchema },
    files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "purpose"],
        properties: { path: stringSchema, purpose: stringSchema },
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "paths"],
        properties: {
          id: stringSchema,
          description: stringSchema,
          paths: stringArraySchema,
        },
      },
    },
    safetyTests: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "proves", "argv"],
        properties: {
          name: stringSchema,
          proves: stringSchema,
          argv: { type: "array", minItems: 1, items: stringSchema },
        },
      },
    },
    verificationCommands: {
      type: "array",
      minItems: 1,
      items: commandSchema,
    },
    dependencies: stringArraySchema,
    migrations: stringArraySchema,
    approvalRequiredChanges: stringArraySchema,
    risks: stringArraySchema,
    assumptions: stringArraySchema,
    unknowns: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "critical", "resolution"],
        properties: {
          description: stringSchema,
          critical: { type: "boolean" },
          resolution: { type: "string" },
        },
      },
    },
    recovery: { type: "array", minItems: 1, items: stringSchema },
    rejectionReasons: stringArraySchema,
  },
} as const;

export const decisionArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "winnerPlanId",
    "reason",
    "rejectedPlans",
    "tradeoffs",
    "residualRisks",
    "humanDecisionRequired",
    "humanDecisionReason",
  ],
  properties: {
    winnerPlanId: stringSchema,
    reason: stringSchema,
    rejectedPlans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["planId", "reason"],
        properties: { planId: stringSchema, reason: stringSchema },
      },
    },
    tradeoffs: stringArraySchema,
    residualRisks: stringArraySchema,
    humanDecisionRequired: { type: "boolean" },
    humanDecisionReason: { type: "string" },
  },
} as const;

export const harnessArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "testPaths",
    "fixturePaths",
    "targetedCommand",
    "expectedBaselineOutcome",
    "expectedFailure",
    "protectedPaths",
  ],
  properties: {
    summary: stringSchema,
    testPaths: { type: "array", minItems: 1, items: stringSchema },
    fixturePaths: stringArraySchema,
    targetedCommand: commandSchema,
    expectedBaselineOutcome: { type: "string", enum: ["fail", "pass"] },
    expectedFailure: { type: "string" },
    protectedPaths: { type: "array", minItems: 1, items: stringSchema },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });

export class ArtifactValidationError extends Error {
  constructor(
    public readonly artifactName: string,
    public readonly validationErrors: ErrorObject[],
  ) {
    super(
      `Invalid ${artifactName}: ${validationErrors
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
    this.name = "ArtifactValidationError";
  }
}

export function compileArtifactValidator<T>(
  artifactName: string,
  schema: object,
): (value: unknown) => T {
  const validate = ajv.compile(schema) as ValidateFunction<T>;
  return (value: unknown): T => {
    if (!validate(value)) {
      throw new ArtifactValidationError(artifactName, validate.errors ?? []);
    }
    return value;
  };
}

export const validateSmokeArtifact = compileArtifactValidator<SmokeArtifact>(
  "smoke artifact",
  smokeArtifactSchema,
);
export const validateEvidenceArtifact = compileArtifactValidator<EvidenceArtifact>(
  "evidence artifact",
  evidenceArtifactSchema,
);
export const validateChangeContract = compileArtifactValidator<ChangeContract>(
  "change contract",
  changeContractSchema,
);
export const validateDetailedPlan = compileArtifactValidator<DetailedPlan>(
  "detailed plan",
  detailedPlanSchema,
);
export const validateDecisionArtifact = compileArtifactValidator<DecisionArtifact>(
  "decision artifact",
  decisionArtifactSchema,
);
export const validateHarnessArtifact = compileArtifactValidator<HarnessArtifact>(
  "harness artifact",
  harnessArtifactSchema,
);
