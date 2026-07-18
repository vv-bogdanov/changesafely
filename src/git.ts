import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BaselineSnapshot {
  repoPath: string;
  branch: string;
  commit: string;
  trackedStatus: string;
  files: Record<string, string>;
  protectedConfiguration: Record<string, string>;
  fingerprint: string;
}

export class PreflightError extends Error {
  constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
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

export async function inspectProtectedConfiguration(
  repoPath: string,
): Promise<Record<string, string>> {
  const protectedConfiguration: Record<string, string> = {};
  for (const path of [".env", ".env.local", ".npmrc"]) {
    const absolutePath = join(repoPath, path);
    if (await pathExists(absolutePath)) {
      const metadata = await stat(absolutePath);
      protectedConfiguration[path] = sha256(
        `${metadata.size}:${metadata.mtimeMs}:${metadata.mode}`,
      );
    }
  }
  return protectedConfiguration;
}

export async function assertProtectedConfigurationUnchanged(
  repoPath: string,
  expected: Record<string, string>,
): Promise<void> {
  const actual = await inspectProtectedConfiguration(repoPath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PreflightError(
      "PROTECTED_CONFIGURATION_CHANGED",
      "Protected configuration metadata changed during the SafeChange run",
    );
  }
}

export async function inspectBaseline(repoPath: string): Promise<BaselineSnapshot> {
  const root = await git(repoPath, ["rev-parse", "--show-toplevel"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["branch", "--show-current"]);
  if (!branch) {
    throw new PreflightError("DETACHED_HEAD", "SafeChange requires a named current branch");
  }

  const trackedStatus = await git(root, ["status", "--porcelain=v1", "--untracked-files=no"]);
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

  const trackedFiles = (await git(root, ["ls-files"])).split("\n").filter(Boolean);
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

  const protectedConfiguration = await inspectProtectedConfiguration(root);

  const fingerprint = sha256(
    JSON.stringify({
      commit,
      branch,
      trackedStatus,
      files: Object.entries(files),
      protectedConfiguration: Object.entries(protectedConfiguration),
    }),
  );
  return {
    repoPath: root,
    branch,
    commit,
    trackedStatus,
    files,
    protectedConfiguration,
    fingerprint,
  };
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

export async function createSafeChangeBranch(
  baseline: BaselineSnapshot,
  runId: string,
): Promise<string> {
  await assertBaselineUnchanged(baseline);
  const branch = `safechange/${runId}`;
  await git(baseline.repoPath, ["switch", "-c", branch, baseline.commit]);
  return branch;
}

export async function changedPaths(repoPath: string, from = "HEAD"): Promise<string[]> {
  const tracked = await git(repoPath, ["diff", "--name-only", from, "--"]);
  const untracked = await git(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  return [
    ...new Set(
      `${tracked}\n${untracked}`
        .split("\n")
        .filter((path) => path && !path.startsWith(".safechange/")),
    ),
  ].sort();
}

export async function diffFrom(repoPath: string, from: string): Promise<string> {
  return git(repoPath, ["diff", "--no-ext-diff", from, "--"]);
}

export async function commitPaths(
  repoPath: string,
  paths: string[],
  message: string,
): Promise<string> {
  if (paths.length === 0) {
    throw new PreflightError("NO_CHANGES", "No paths are available to commit");
  }
  await git(repoPath, ["add", "--", ...paths]);
  await git(repoPath, ["commit", "-m", message, "--", ...paths]);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

export async function hashFiles(
  repoPath: string,
  paths: string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    result[path] = sha256(await readFile(join(repoPath, path)));
  }
  return result;
}

export async function currentCommit(repoPath: string): Promise<string> {
  return git(repoPath, ["rev-parse", "HEAD"]);
}

export async function currentBranch(repoPath: string): Promise<string> {
  return git(repoPath, ["branch", "--show-current"]);
}

export async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoPath,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
