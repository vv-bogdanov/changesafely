import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { validateArtifactEnvelope, validateRunState } from "./schemas.js";

export type RunStatus =
  | "RUNNING"
  | "PLANNED"
  | "BLOCKED"
  | "HUMAN_DECISION_REQUIRED"
  | "BASELINE_CHANGED"
  | "REPLAN_REQUIRED"
  | "FAILED"
  | "VERIFIED";

export interface ContextEntry {
  role: string;
  threadId: string;
  parentThreadId: string | null;
  checkpointTurnId: string | null;
  turnId: string | null;
  status: "started" | "completed" | "failed";
}

export interface RunState {
  runId: string;
  task: string;
  repoPath: string;
  baselineCommit: string;
  baselineFingerprint: string;
  baselineProtectedConfiguration: Record<string, string>;
  phase: string;
  status: RunStatus;
  reason: string;
  nextAction: string;
  artifacts: Record<string, string>;
  contexts: ContextEntry[];
  branch: string;
  testCommit: string;
  implementationCommit: string;
  repairCount: number;
  model: string;
}

export interface ArtifactEnvelope<T> {
  meta: {
    runId: string;
    baselineCommit: string;
    role: string;
    createdAt: string;
    inputHashes: string[];
  };
  payload: T;
}

export interface StoredArtifact<T> {
  path: string;
  hash: string;
  envelope: ArtifactEnvelope<T>;
}

export function createRunId(): string {
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  return `${time}-${randomUUID().slice(0, 8)}`;
}

export function validateRunId(runId: string): string {
  if (runId === "." || runId === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`Invalid SafeChange run id: ${runId}`);
  }
  return runId;
}

function resolveWithin(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes the SafeChange run directory: ${relativePath}`);
  }
  return path;
}

function runPath(repoPath: string, runId: string): string {
  return resolve(repoPath, ".safechange", "runs", validateRunId(runId));
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseJson(content: string, description: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${description}`);
  }
}

export class ArtifactStore {
  readonly runPath: string;
  public readonly runId: string;

  constructor(
    repoPath: string,
    runId: string,
    private readonly baselineCommit: string,
  ) {
    this.runId = validateRunId(runId);
    this.runPath = runPath(repoPath, this.runId);
  }

  async initialize(): Promise<void> {
    await mkdir(resolveWithin(this.runPath, "plans"), { recursive: true });
    await mkdir(resolveWithin(this.runPath, "logs"), { recursive: true });
  }

  async writeState(state: RunState): Promise<void> {
    const validated = validateRunState(state);
    if (validated.runId !== this.runId || validated.baselineCommit !== this.baselineCommit) {
      throw new Error("Run state lineage does not match its artifact store");
    }
    await this.writeJson("state.json", validated);
    await this.writeJson("context.json", validated.contexts);
  }

  async writeArtifact<T>(
    relativePath: string,
    role: string,
    payload: T,
    inputHashes: string[] = [],
  ): Promise<StoredArtifact<T>> {
    const envelope: ArtifactEnvelope<T> = {
      meta: {
        runId: this.runId,
        baselineCommit: this.baselineCommit,
        role,
        createdAt: new Date().toISOString(),
        inputHashes,
      },
      payload,
    };
    validateArtifactEnvelope(envelope);
    const content = `${JSON.stringify(envelope, null, 2)}\n`;
    const path = resolveWithin(this.runPath, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await this.writeText(relativePath, content);
    return { path, hash: hashContent(content), envelope };
  }

  async writeText(relativePath: string, content: string): Promise<string> {
    const path = resolveWithin(this.runPath, relativePath);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
    return path;
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }
}

export async function loadRunState(repoPath: string, runId: string): Promise<RunState> {
  const validated = validateRunState(
    parseJson(
      await readFile(resolveWithin(runPath(repoPath, runId), "state.json"), "utf8"),
      "SafeChange run state",
    ),
  );
  if (validated.runId !== runId) {
    throw new Error("Run state identity does not match its directory");
  }
  return validated;
}

export async function loadArtifact<T>(
  repoPath: string,
  runId: string,
  relativePath: string,
): Promise<ArtifactEnvelope<T>> {
  const validated = validateArtifactEnvelope(
    parseJson(
      await readFile(resolveWithin(runPath(repoPath, runId), relativePath), "utf8"),
      "SafeChange artifact",
    ),
  );
  if (validated.meta.runId !== runId) {
    throw new Error(`Artifact run identity mismatch: ${relativePath}`);
  }
  return validated as ArtifactEnvelope<T>;
}

export async function loadVerifiedArtifact<T>(
  repoPath: string,
  state: RunState,
  artifactName: string,
  relativePath: string,
): Promise<ArtifactEnvelope<T>> {
  const content = await readFile(
    resolveWithin(runPath(repoPath, state.runId), relativePath),
    "utf8",
  );
  const expectedHash = state.artifacts[artifactName];
  if (!expectedHash || hashContent(content) !== expectedHash) {
    throw new Error(`Artifact hash mismatch: ${relativePath}`);
  }
  const envelope = validateArtifactEnvelope(
    parseJson(content, `SafeChange artifact ${relativePath}`),
  ) as ArtifactEnvelope<T>;
  if (
    envelope.meta.runId !== state.runId ||
    envelope.meta.baselineCommit !== state.baselineCommit
  ) {
    throw new Error(`Artifact lineage mismatch: ${relativePath}`);
  }
  const knownHashes = new Set(Object.values(state.artifacts));
  if (envelope.meta.inputHashes.some((inputHash) => !knownHashes.has(inputHash))) {
    throw new Error(`Artifact input lineage mismatch: ${relativePath}`);
  }
  return envelope;
}
