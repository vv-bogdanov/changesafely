import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import Type from "typebox";
import { Compile } from "typebox/compile";
import { ChangeSafelyError } from "./errors.js";
import { normalizeRepositoryPath, pathWithinPrefixes } from "./repository-policy.js";
import { validateCommandArgv } from "./runner.js";

const execFileAsync = promisify(execFile);

export type CheckKind = "test" | "coverage" | "typecheck" | "lint" | "build";

export interface RepositoryCheck {
  id: string;
  kind: CheckKind;
  argv: string[];
  cwd: string;
}

export interface RepositoryCapabilities {
  checks: RepositoryCheck[];
  testPathPrefixes: string[];
  testFilePatterns: string[];
  controlFiles: string[];
  sources: string[];
}

export const REPOSITORY_CONFIG_PATH = "changesafely.config.json";

const configStringSchema = Type.String({ minLength: 1, maxLength: 4096 });
const repositoryConfigSchema = Type.Object(
  {
    version: Type.Literal(1),
    checks: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$" }),
          kind: Type.Unsafe<CheckKind>(
            Type.String({
              enum: ["test", "coverage", "typecheck", "lint", "build"],
            }),
          ),
          argv: Type.Array(configStringSchema, { minItems: 1, maxItems: 64 }),
          cwd: configStringSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
    testPathPrefixes: Type.Array(configStringSchema, { minItems: 1, maxItems: 64 }),
    testFilePatterns: Type.Array(configStringSchema, { maxItems: 32 }),
    controlFiles: Type.Array(configStringSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);
const repositoryConfigValidator = Compile(repositoryConfigSchema);

const npmControlNames = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
]);
const pythonControlNames = new Set([
  "pyproject.toml",
  "pytest.ini",
  "setup.cfg",
  "requirements.txt",
  "requirements-dev.txt",
  "requirements-test.txt",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
]);

export async function discoverRepositoryCapabilities(
  repoPath: string,
): Promise<RepositoryCapabilities> {
  const trackedFiles = await gitFiles(repoPath);
  const manifests = trackedFiles.filter((path) => posix.basename(path) === "package.json");
  const checks: RepositoryCheck[] = [];
  const testPathPrefixes = new Set<string>();
  const controlFiles = new Set(
    trackedFiles.filter((path) => npmControlNames.has(posix.basename(path))),
  );
  const sources: string[] = [];

  for (const manifest of manifests.sort()) {
    const cwd = dirname(manifest) === "." ? "." : normalizeRepositoryPath(dirname(manifest));
    const scripts = packageScripts(await readFile(`${repoPath}/${manifest}`, "utf8"), manifest);
    sources.push(`npm:${manifest}`);
    for (const [name] of Object.entries(scripts).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const kind = npmCheckKind(name);
      if (!kind) continue;
      checks.push({
        id: `npm:${cwd}:${name}`,
        kind,
        argv: name === "test" ? ["npm", "test"] : ["npm", "run", name],
        cwd,
      });
    }
    for (const directory of ["test", "tests", "spec", "__tests__"]) {
      testPathPrefixes.add(cwd === "." ? directory : `${cwd}/${directory}`);
    }
  }
  if (manifests.length > 0) {
    const npm = await resolveExecutable("npm");
    sources.push(`executable:npm:${npm}`, `executable-target:npm:${await realpath(npm)}`);
  }

  const pythonRoots = new Set(
    trackedFiles
      .filter((path) => ["pyproject.toml", "pytest.ini"].includes(posix.basename(path)))
      .map((path) => (posix.dirname(path) === "." ? "." : posix.dirname(path))),
  );
  const preparedPythonRoots = [...pythonRoots].filter((root) =>
    trackedFiles.some((path) =>
      root === "."
        ? isPythonTestPath(path)
        : path.startsWith(`${root}/`) && isPythonTestPath(path.slice(root.length + 1)),
    ),
  );
  if (preparedPythonRoots.length > 0) {
    const python = await resolveExecutable("python");
    const pytestVersion = await pythonModuleVersion(python, "pytest");
    sources.push(
      `executable:python:${python}`,
      `executable-target:python:${await realpath(python)}`,
      `runtime:pytest:${pytestVersion}`,
    );
    for (const root of preparedPythonRoots.sort()) {
      checks.push({
        id: `python:${root}:pytest`,
        kind: "test",
        argv: ["python", "-m", "pytest"],
        cwd: root,
      });
      testPathPrefixes.add(root === "." ? "tests" : `${root}/tests`);
      for (const path of trackedFiles) {
        if (root !== "." && !path.startsWith(`${root}/`)) continue;
        const relative = root === "." ? path : path.slice(root.length + 1);
        if (
          pythonControlNames.has(posix.basename(path)) ||
          /^requirements(?:-[A-Za-z0-9_.-]+)?\.txt$/u.test(posix.basename(path))
        ) {
          controlFiles.add(path);
        }
        if (relative === "conftest.py") controlFiles.add(path);
      }
      sources.push(`python:${root}`);
    }
  }

  const detected = normalizeCapabilities({
    checks,
    testPathPrefixes: [...testPathPrefixes],
    testFilePatterns: ["*.test.*", "*.spec.*", "test_*.py", "*_test.py"],
    controlFiles: [...controlFiles],
    sources,
  });
  const configured = await configuredCapabilities(repoPath, trackedFiles);
  return mergeCapabilities(configured ? [configured, detected] : [detected]);
}

export function capabilitiesSha256(capabilities: RepositoryCapabilities): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeCapabilities(capabilities)))
    .digest("hex");
}

export function authorizeRepositoryCheck(
  capabilities: RepositoryCapabilities,
  argv: string[],
  cwd = ".",
  kind?: CheckKind,
): RepositoryCheck | undefined {
  const normalizedCwd = normalizeRepositoryPath(cwd);
  return capabilities.checks.find(
    (check) =>
      (!kind || check.kind === kind) &&
      check.cwd === normalizedCwd &&
      sameStrings(check.argv, argv),
  );
}

export function requireRepositoryCheck(
  capabilities: RepositoryCapabilities,
  argv: string[],
  cwd = ".",
  kind?: CheckKind,
): RepositoryCheck {
  const check = authorizeRepositoryCheck(capabilities, argv, cwd, kind);
  if (!check) {
    throw new ChangeSafelyError(
      "COMMAND_NOT_IN_CAPABILITY_CATALOG",
      `Command is not in the baseline repository capability catalog: ${cwd}: ${argv.join(" ")}`,
      {
        exitCode: 2,
        nextAction: "Select an exact check listed by ChangeSafely during repository preflight.",
      },
    );
  }
  return check;
}

export function isCapabilityTestPath(capabilities: RepositoryCapabilities, path: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeRepositoryPath(path);
  } catch {
    return false;
  }
  if (pathWithinPrefixes(normalized, capabilities.testPathPrefixes)) return true;
  const name = posix.basename(normalized);
  return capabilities.testFilePatterns.some((pattern) => matchesSimplePattern(name, pattern));
}

export function assertUsableCapabilities(capabilities: RepositoryCapabilities): void {
  if (!capabilities.checks.some((check) => check.kind === "test")) {
    throw new ChangeSafelyError(
      "UNSUPPORTED_REPOSITORY",
      "No deterministic repository test check was detected",
      {
        exitCode: 2,
        nextAction: `Add an npm test script or declare repository checks in ${REPOSITORY_CONFIG_PATH}.`,
      },
    );
  }
}

async function configuredCapabilities(
  repoPath: string,
  trackedFiles: string[],
): Promise<RepositoryCapabilities | undefined> {
  if (!trackedFiles.includes(REPOSITORY_CONFIG_PATH)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(repoPath, REPOSITORY_CONFIG_PATH), "utf8"));
  } catch {
    throw invalidConfig("The file is not valid JSON");
  }
  if (!repositoryConfigValidator.Check(value)) {
    const details = [...repositoryConfigValidator.Errors(value)]
      .slice(0, 6)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw invalidConfig(details);
  }

  const config = value as Type.Static<typeof repositoryConfigSchema>;
  const tracked = new Set(trackedFiles);
  const checks: RepositoryCheck[] = [];
  const ids = new Set<string>();
  const commands = new Set<string>();
  const programs = new Set<string>();
  for (const check of config.checks) {
    if (ids.has(check.id)) throw invalidConfig(`Duplicate check id: ${check.id}`);
    ids.add(check.id);
    let cwd: string;
    try {
      cwd = normalizeRepositoryPath(check.cwd);
      validateCommandArgv([...check.argv]);
    } catch (error) {
      throw invalidConfig(
        `Unsafe check ${check.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(check.argv[0] ?? "")) {
      throw invalidConfig(`Environment overrides are not allowed in check ${check.id}`);
    }
    const cwdMetadata = await stat(join(repoPath, cwd)).catch(() => undefined);
    if (!cwdMetadata?.isDirectory()) {
      throw invalidConfig(`Check ${check.id} cwd is not an existing directory: ${cwd}`);
    }
    const commandKey = JSON.stringify([cwd, check.argv]);
    if (commands.has(commandKey)) throw invalidConfig(`Duplicate check command: ${check.id}`);
    commands.add(commandKey);
    programs.add(check.argv[0] ?? "");
    checks.push({ id: check.id, kind: check.kind, argv: [...check.argv], cwd });
  }

  const normalizeConfigPath = (path: string, label: string): string => {
    try {
      return normalizeRepositoryPath(path);
    } catch (error) {
      throw invalidConfig(
        `Invalid ${label} path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const testPathPrefixes = config.testPathPrefixes.map((path) =>
    normalizeConfigPath(path, "test prefix"),
  );
  const controlFiles = config.controlFiles.map((path) => normalizeConfigPath(path, "control file"));
  for (const path of controlFiles) {
    if (!tracked.has(path)) throw invalidConfig(`Control file is not tracked: ${path}`);
  }
  for (const pattern of config.testFilePatterns) {
    if (pattern.includes("/") || pattern.includes("\\") || pattern === "." || pattern === "..") {
      throw invalidConfig(`Test file pattern must be a filename pattern: ${pattern}`);
    }
  }

  const sources = [`config:${REPOSITORY_CONFIG_PATH}`];
  for (const program of [...programs].sort()) {
    const executable = await resolveExecutable(program);
    sources.push(
      `executable:${program}:${executable}`,
      `executable-target:${program}:${await realpath(executable)}`,
    );
  }
  return normalizeCapabilities({
    checks,
    testPathPrefixes,
    testFilePatterns: [...config.testFilePatterns],
    controlFiles: [REPOSITORY_CONFIG_PATH, ...controlFiles],
    sources,
  });
}

function mergeCapabilities(catalogs: RepositoryCapabilities[]): RepositoryCapabilities {
  const merged: RepositoryCapabilities = {
    checks: [],
    testPathPrefixes: [],
    testFilePatterns: [],
    controlFiles: [],
    sources: [],
  };
  const ids = new Map<string, RepositoryCheck>();
  const commands = new Map<string, RepositoryCheck>();
  for (const catalog of catalogs) {
    for (const check of catalog.checks) {
      const existingId = ids.get(check.id);
      if (existingId) {
        throw ambiguousCatalog(`Check id ${check.id} is declared more than once`);
      }
      const commandKey = JSON.stringify([check.cwd, check.argv]);
      const existingCommand = commands.get(commandKey);
      if (existingCommand) {
        throw ambiguousCatalog(
          `Checks ${existingCommand.id} and ${check.id} declare the same command and cwd`,
        );
      }
      ids.set(check.id, check);
      commands.set(commandKey, check);
      merged.checks.push(check);
    }
    merged.testPathPrefixes.push(...catalog.testPathPrefixes);
    merged.testFilePatterns.push(...catalog.testFilePatterns);
    merged.controlFiles.push(...catalog.controlFiles);
    merged.sources.push(...catalog.sources);
  }
  return normalizeCapabilities(merged);
}

function invalidConfig(detail: string): ChangeSafelyError {
  return new ChangeSafelyError(
    "INVALID_REPOSITORY_CONFIG",
    `Invalid ${REPOSITORY_CONFIG_PATH}: ${detail}`,
    {
      exitCode: 2,
      nextAction: `Fix the tracked ${REPOSITORY_CONFIG_PATH} file and retry.`,
    },
  );
}

function ambiguousCatalog(detail: string): ChangeSafelyError {
  return new ChangeSafelyError("AMBIGUOUS_CAPABILITY_CATALOG", detail, {
    exitCode: 2,
    nextAction: `Remove duplicate checks from ${REPOSITORY_CONFIG_PATH} and retry.`,
  });
}

function normalizeCapabilities(capabilities: RepositoryCapabilities): RepositoryCapabilities {
  return {
    checks: [...capabilities.checks]
      .map((check) => ({
        ...check,
        argv: [...check.argv],
        cwd: normalizeRepositoryPath(check.cwd),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    testPathPrefixes: uniqueSorted(capabilities.testPathPrefixes.map(normalizeRepositoryPath)),
    testFilePatterns: uniqueSorted(capabilities.testFilePatterns),
    controlFiles: uniqueSorted(capabilities.controlFiles.map(normalizeRepositoryPath)),
    sources: uniqueSorted(capabilities.sources),
  };
}

function packageScripts(content: string, path: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in tracked npm manifest: ${path}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const scripts = (value as Record<string, unknown>).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function npmCheckKind(name: string): CheckKind | undefined {
  if (name === "coverage" || name.startsWith("coverage:") || name === "test:coverage") {
    return "coverage";
  }
  const base = name.split(":", 1)[0];
  if (base === "test") return "test";
  if (base === "typecheck") return "typecheck";
  if (base === "lint") return "lint";
  if (base === "build" || base === "check") return "build";
  return undefined;
}

function matchesSimplePattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(name);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function gitFiles(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repoPath,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean).map(normalizeRepositoryPath).sort();
}

async function resolveExecutable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new ChangeSafelyError("RUNTIME_NOT_FOUND", `Cannot resolve required runtime: ${name}`, {
    exitCode: 2,
    nextAction: `Install ${name} or add it to PATH, then retry.`,
  });
}

function isPythonTestPath(path: string): boolean {
  return (
    path.startsWith("tests/") ||
    posix.basename(path) === "conftest.py" ||
    /^test_.+\.py$/u.test(posix.basename(path)) ||
    /_test\.py$/u.test(posix.basename(path))
  );
}

async function pythonModuleVersion(python: string, module: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(python, ["-m", module, "--version"], {
      cwd: tmpdir(),
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpdir(),
        PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
      },
    });
    const version = stdout.trim();
    if (version) return version.slice(0, 200);
  } catch {
    // The actionable preflight error is emitted below.
  }
  throw new ChangeSafelyError("PYTEST_NOT_FOUND", `Prepared Python repository requires ${module}`, {
    exitCode: 2,
    nextAction: `Install the repository's locked ${module} dependency, then retry.`,
  });
}
