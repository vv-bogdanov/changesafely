import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  phase: string;
  status: RunStatus;
  reason: string;
  nextAction: string;
  artifacts: Record<string, string>;
  contexts: ContextEntry[];
  branch: string;
  testCommit: string;
  implementationCommit: string;
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

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class ArtifactStore {
  readonly runPath: string;

  constructor(
    repoPath: string,
    public readonly runId: string,
    private readonly baselineCommit: string,
  ) {
    this.runPath = join(repoPath, ".safechange", "runs", runId);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.runPath, "plans"), { recursive: true });
    await mkdir(join(this.runPath, "logs"), { recursive: true });
  }

  async writeState(state: RunState): Promise<void> {
    await this.writeJson("state.json", state);
    await this.writeJson("context.json", state.contexts);
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
    const content = `${JSON.stringify(envelope, null, 2)}\n`;
    const path = join(this.runPath, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return { path, hash: hash(content), envelope };
  }

  async writeText(relativePath: string, content: string): Promise<string> {
    const path = join(this.runPath, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return path;
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }
}

export async function loadRunState(repoPath: string, runId: string): Promise<RunState> {
  return JSON.parse(
    await readFile(join(repoPath, ".safechange", "runs", runId, "state.json"), "utf8"),
  ) as RunState;
}

export async function loadArtifact<T>(
  repoPath: string,
  runId: string,
  relativePath: string,
): Promise<ArtifactEnvelope<T>> {
  return JSON.parse(
    await readFile(join(repoPath, ".safechange", "runs", runId, relativePath), "utf8"),
  ) as ArtifactEnvelope<T>;
}
