import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BaselineSnapshot {
  repoPath: string;
  branch: string;
  commit: string;
  trackedStatus: string;
  files: Record<string, string>;
  fingerprint: string;
}

export class PreflightError extends Error {
  constructor(public readonly reasonCode: string, message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PreflightError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed: ${detail}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function inspectBaseline(repoPath: string): Promise<BaselineSnapshot> {
  const root = await git(repoPath, ["rev-parse", "--show-toplevel"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["branch", "--show-current"]);
  if (!branch) {
    throw new PreflightError("DETACHED_HEAD", "SafeChange requires a named current branch");
  }

  const trackedStatus = await git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  if (trackedStatus) {
    throw new PreflightError(
      "DIRTY_TRACKED_STATE",
      "Tracked or staged changes must be committed before SafeChange planning",
    );
  }

  const operationMarkers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
  ];
  for (const marker of operationMarkers) {
    const markerPath = await git(root, ["rev-parse", "--git-path", marker]);
    if (await pathExists(markerPath)) {
      throw new PreflightError(
        "GIT_OPERATION_IN_PROGRESS",
        `Git operation marker is present: ${marker}`,
      );
    }
  }

  const trackedFiles = (await git(root, ["ls-files"]))
    .split("\n")
    .filter(Boolean);
  const manifestNames = new Set([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
  ]);
  const relevant = trackedFiles.filter(
    (path) => basename(path) === "AGENTS.md" || manifestNames.has(basename(path)),
  );
  const files: Record<string, string> = {};
  for (const path of relevant.sort()) {
    files[path] = sha256(await readFile(join(root, path)));
  }

  const fingerprint = sha256(
    JSON.stringify({ commit, trackedStatus, files: Object.entries(files) }),
  );
  return { repoPath: root, branch, commit, trackedStatus, files, fingerprint };
}

export async function assertBaselineUnchanged(
  expected: BaselineSnapshot,
): Promise<BaselineSnapshot> {
  const actual = await inspectBaseline(expected.repoPath);
  if (actual.fingerprint !== expected.fingerprint) {
    throw new PreflightError(
      "BASELINE_CHANGED",
      `Baseline changed from ${expected.fingerprint} to ${actual.fingerprint}`,
    );
  }
  return actual;
}
