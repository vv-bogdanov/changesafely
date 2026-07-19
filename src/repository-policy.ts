import { posix } from "node:path";

export const REPOSITORY_CONTROL_FILE_NAMES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
]);

export function normalizeRepositoryPath(rawPath: string): string {
  if (
    rawPath === "" ||
    rawPath !== rawPath.trim() ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    posix.isAbsolute(rawPath) ||
    /^[A-Za-z]:/.test(rawPath) ||
    rawPath.split("/").includes("..")
  ) {
    throw new Error(`Invalid repository-relative path: ${rawPath}`);
  }
  const normalized = posix.normalize(rawPath.replace(/^(?:\.\/)+/, ""));
  return normalized === "." ? normalized : normalized.replace(/\/$/, "");
}

export function pathWithinPrefixes(path: string, prefixes: string[]): boolean {
  let candidate: string;
  try {
    candidate = normalizeRepositoryPath(path);
  } catch {
    return false;
  }
  return prefixes.some((rawPrefix) => {
    try {
      const prefix = normalizeRepositoryPath(rawPrefix);
      return prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`);
    } catch {
      return false;
    }
  });
}

export function isTestPath(path: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeRepositoryPath(path);
  } catch {
    return false;
  }
  return (
    normalized
      .split("/")
      .some((part) => ["test", "tests", "__tests__", "fixtures"].includes(part)) ||
    /(?:\.test\.|\.spec\.)/.test(normalized)
  );
}

export function isApprovalSensitivePath(path: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeRepositoryPath(path);
  } catch {
    return true;
  }
  return (
    REPOSITORY_CONTROL_FILE_NAMES.has(posix.basename(normalized)) ||
    /(?:^|\/)(?:migrations?|secrets?)(?:\/|$)/i.test(normalized)
  );
}
