import Type from "typebox";
import { Compile } from "typebox/compile";

export const EVIDENCE_VERSION = 1;

type BenchmarkMode = "changesafely" | "direct";
export type BenchmarkOutcome =
  | "safe_success"
  | "unsafe_green"
  | "visible_failure"
  | "scope_failure"
  | "technical_failure";

interface WorkerResult {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export interface RunDocument {
  evidenceVersion: typeof EVIDENCE_VERSION;
  runId: string;
  scenario: string;
  mode: BenchmarkMode;
  taskText: string;
  taskSha256: string;
  baselineCommit: string;
  snapshotCommit: string;
  model: string;
  effort: string;
  environment: {
    nodeVersion: string;
    gitVersion: string;
    codexVersion: string;
    changesafelyVersion: string;
    platform: string;
    architecture: string;
  };
  isolation: {
    provider: "bubblewrap";
    canarySha256: string;
    agentToolNetwork: "disabled";
  };
  worker: WorkerResult;
  usage: {
    turns: number | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
  };
  outcome: BenchmarkOutcome;
}

interface EvidenceFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EvidenceManifest {
  evidenceVersion: typeof EVIDENCE_VERSION;
  runId: string;
  files: EvidenceFile[];
}

const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const commit = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const nullableCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

const workerResultSchema = Type.Object(
  {
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: Type.Integer({ minimum: 0 }),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    timedOut: Type.Boolean(),
  },
  { additionalProperties: false },
);

const runDocumentSchema = Type.Object(
  {
    evidenceVersion: Type.Literal(EVIDENCE_VERSION),
    runId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    scenario: Type.String({ minLength: 1, maxLength: 100 }),
    mode: Type.Union([Type.Literal("changesafely"), Type.Literal("direct")]),
    taskText: Type.String({ minLength: 1, maxLength: 20_000 }),
    taskSha256: sha256,
    baselineCommit: commit,
    snapshotCommit: commit,
    model: Type.String({ minLength: 1, maxLength: 255 }),
    effort: Type.String({ minLength: 1, maxLength: 100 }),
    environment: Type.Object(
      {
        nodeVersion: Type.String({ minLength: 1, maxLength: 100 }),
        gitVersion: Type.String({ minLength: 1, maxLength: 500 }),
        codexVersion: Type.String({ minLength: 1, maxLength: 500 }),
        changesafelyVersion: Type.String({ minLength: 1, maxLength: 100 }),
        platform: Type.String({ minLength: 1, maxLength: 100 }),
        architecture: Type.String({ minLength: 1, maxLength: 100 }),
      },
      { additionalProperties: false },
    ),
    isolation: Type.Object(
      {
        provider: Type.Literal("bubblewrap"),
        canarySha256: sha256,
        agentToolNetwork: Type.Literal("disabled"),
      },
      { additionalProperties: false },
    ),
    worker: workerResultSchema,
    usage: Type.Object(
      {
        turns: nullableCount,
        inputTokens: nullableCount,
        cachedInputTokens: nullableCount,
        outputTokens: nullableCount,
        reasoningTokens: nullableCount,
      },
      { additionalProperties: false },
    ),
    outcome: Type.Union([
      Type.Literal("safe_success"),
      Type.Literal("unsafe_green"),
      Type.Literal("visible_failure"),
      Type.Literal("scope_failure"),
      Type.Literal("technical_failure"),
    ]),
  },
  { additionalProperties: false },
);

const evidenceManifestSchema = Type.Object(
  {
    evidenceVersion: Type.Literal(EVIDENCE_VERSION),
    runId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 500 }),
          bytes: Type.Integer({ minimum: 0 }),
          sha256,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

const validateRunDocumentSchema = Compile(runDocumentSchema);
const validateEvidenceManifestSchema = Compile(evidenceManifestSchema);

export function validateRunDocument(value: unknown): RunDocument {
  if (!validateRunDocumentSchema.Check(value)) throw new Error("Invalid benchmark run document");
  return value as RunDocument;
}

export function validateEvidenceManifest(value: unknown): EvidenceManifest {
  if (!validateEvidenceManifestSchema.Check(value)) {
    throw new Error("Invalid benchmark evidence manifest");
  }
  return value as EvidenceManifest;
}
