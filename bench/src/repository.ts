import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, lstat, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import Type from "typebox";
import { Compile } from "typebox/compile";
import { isCapabilityTestPath } from "../../src/repository-capabilities.js";
import { normalizeRepositoryPath } from "../../src/repository-policy.js";
import { validateCommandArgv } from "../../src/runner.js";
import { contentSha256 } from "./evidence.js";

const execFileAsync = promisify(execFile);

interface BenchmarkCommand {
  argv: string[];
  cwd: string;
}

interface BenchmarkPreparation extends BenchmarkCommand {
  network: "disabled";
}

export interface BenchmarkToolchain {
  id: string;
  version: BenchmarkCommand;
}

export interface ScenarioDefinition {
  id: string;
  version: number;
  root: string;
  baseline: string;
  task: string;
  evaluator: string;
  validator: string;
  manifestPath: string;
  manifestSha256: string;
  visibleChecks: BenchmarkCommand[];
  preparation: BenchmarkPreparation[];
  testPathPrefixes: string[];
  testFilePatterns: string[];
  toolchains: BenchmarkToolchain[];
}

export interface MaterializedAttempt {
  workspace: string;
  baselineCommit: string;
}

export interface AttemptSnapshot {
  baselineCommit: string;
  snapshotCommit: string;
  diff: string;
  changedFiles: string[];
}

const commandSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      minItems: 1,
      maxItems: 64,
    }),
    cwd: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const scenarioManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,99}$" }),
    version: Type.Integer({ minimum: 1 }),
    visibleChecks: Type.Array(commandSchema, { minItems: 1, maxItems: 16 }),
    preparation: Type.Array(
      Type.Object(
        {
          argv: commandSchema.properties.argv,
          cwd: commandSchema.properties.cwd,
          network: Type.Literal("disabled"),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
    testPaths: Type.Object(
      {
        prefixes: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          minItems: 1,
          maxItems: 64,
        }),
        patterns: Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
          maxItems: 64,
        }),
      },
      { additionalProperties: false },
    ),
    toolchains: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^[a-z0-9][a-z0-9.-]{0,99}$" }),
          version: commandSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 16 },
    ),
  },
  { additionalProperties: false },
);
const validateScenarioManifest = Compile(scenarioManifestSchema);
type ScenarioManifest = Type.Static<typeof scenarioManifestSchema>;

export function listScenarioDefinitions(benchRoot: string): ScenarioDefinition[] {
  const scenariosRoot = resolve(benchRoot, "scenarios");
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => loadScenarioDefinition(benchRoot, entry.name));
}

export function scenarioDefinition(
  benchRoot: string,
  scenario: string,
  expectedVersion?: number,
): ScenarioDefinition {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/u.test(scenario)) {
    throw new Error(`Unknown benchmark scenario: ${scenario}`);
  }
  let definition: ScenarioDefinition;
  try {
    definition = loadScenarioDefinition(benchRoot, scenario);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Unknown benchmark scenario: ${scenario}`);
    }
    throw error;
  }
  if (expectedVersion !== undefined && expectedVersion !== definition.version) {
    throw new Error(
      `Benchmark scenario ${scenario} v${expectedVersion} is unavailable; current assets are v${definition.version}`,
    );
  }
  return definition;
}

export async function materializeAttempt(
  scenario: ScenarioDefinition,
  destination: string,
): Promise<MaterializedAttempt> {
  await assertMissing(destination);
  await mkdir(destination, { mode: 0o700 });
  await cp(scenario.baseline, destination, {
    recursive: true,
    filter: (source) => !["dist", "node_modules"].includes(basename(source)),
  });
  await repositoryCommand("git", ["init", "--quiet", "-b", "benchmark"], destination);
  await repositoryCommand("git", ["config", "user.name", "ChangeSafely Benchmark"], destination);
  await repositoryCommand(
    "git",
    ["config", "user.email", "benchmark@changesafely.local"],
    destination,
  );
  await repositoryCommand("git", ["add", "."], destination);
  await repositoryCommand("git", ["commit", "--quiet", "-m", "benchmark baseline"], destination);
  for (const preparation of scenario.preparation) {
    await repositoryCommand(
      preparation.argv[0] ?? "",
      preparation.argv.slice(1),
      resolveCommandCwd(destination, preparation.cwd),
      120_000,
    );
  }
  const preparationChanges = await repositoryCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    destination,
  );
  if (preparationChanges) {
    throw new Error(`Benchmark preparation changed source-controlled state: ${preparationChanges}`);
  }
  const baselineCommit = await repositoryCommand("git", ["rev-parse", "HEAD"], destination);
  const remotes = await repositoryCommand("git", ["remote"], destination);
  if (remotes) throw new Error("Disposable benchmark repository unexpectedly has a remote");
  return { workspace: destination, baselineCommit };
}

export function isScenarioTestPath(scenario: ScenarioDefinition, path: string): boolean {
  return isCapabilityTestPath(
    {
      checks: [],
      testPathPrefixes: scenario.testPathPrefixes,
      testFilePatterns: scenario.testFilePatterns,
      controlFiles: [],
      sources: [],
    },
    path,
  );
}

export function resolveCommandCwd(workspace: string, cwd: string): string {
  const normalized = normalizeRepositoryPath(cwd);
  const result = resolve(workspace, normalized);
  if (!statSync(result).isDirectory()) {
    throw new Error(`Benchmark command cwd is not a directory: ${cwd}`);
  }
  return result;
}

export async function snapshotAttempt(
  workspace: string,
  baselineCommit: string,
): Promise<AttemptSnapshot> {
  const root = resolve(await repositoryCommand("git", ["rev-parse", "--show-toplevel"], workspace));
  if (root !== resolve(workspace)) throw new Error("Benchmark workspace Git root changed");
  await repositoryCommand("git", ["cat-file", "-e", `${baselineCommit}^{commit}`], workspace);
  await repositoryCommand(
    "git",
    ["merge-base", "--is-ancestor", baselineCommit, "HEAD"],
    workspace,
  );
  await repositoryCommand("git", ["add", "-A"], workspace);
  await repositoryCommand(
    "git",
    ["commit", "--quiet", "--allow-empty", "-m", "benchmark attempt snapshot"],
    workspace,
  );
  const snapshotCommit = await repositoryCommand("git", ["rev-parse", "HEAD"], workspace);
  const diff = await repositoryCommand(
    "git",
    ["diff", "--binary", "--no-ext-diff", baselineCommit, snapshotCommit],
    workspace,
    30_000,
    false,
  );
  const changed = await repositoryCommand(
    "git",
    ["diff", "--name-only", "-z", baselineCommit, snapshotCommit],
    workspace,
    30_000,
    false,
  );
  return {
    baselineCommit,
    snapshotCommit,
    diff,
    changedFiles: changed.split("\0").filter(Boolean),
  };
}

export async function repositoryCommand(
  program: string,
  args: string[],
  cwd: string,
  timeout = 30_000,
  trim = true,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(program, args, {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: benchmarkEnvironment(),
    });
    return trim ? stdout.trim() : stdout;
  } catch (error) {
    throw new Error(
      `${program} ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadScenarioDefinition(benchRoot: string, scenario: string): ScenarioDefinition {
  const root = resolve(benchRoot, "scenarios", scenario);
  const manifestPath = join(root, "scenario.json");
  const manifestContent = readFileSync(manifestPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(manifestContent);
  } catch {
    throw new Error(`Invalid benchmark scenario manifest JSON: ${manifestPath}`);
  }
  if (!validateScenarioManifest.Check(value)) {
    const details = [...validateScenarioManifest.Errors(value)]
      .slice(0, 6)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid benchmark scenario manifest ${scenario}: ${details}`);
  }
  const manifest = value as ScenarioManifest;
  if (manifest.id !== scenario) {
    throw new Error(`Benchmark scenario directory and manifest id differ: ${scenario}`);
  }
  const required = {
    baseline: join(root, "baseline"),
    task: join(root, "task.txt"),
    evaluator: resolve(benchRoot, "oracles", scenario, "evaluate.mjs"),
    validator: join(root, "validate.mjs"),
    reference: resolve(benchRoot, "oracles", scenario, "reference.patch"),
    mutants: resolve(benchRoot, "oracles", scenario, "mutants", "manifest.json"),
  };
  for (const [label, path] of Object.entries(required)) assertScenarioAsset(path, label);

  const visibleChecks = manifest.visibleChecks.map((command) =>
    normalizeBenchmarkCommand(command, required.baseline, "visible check"),
  );
  const preparation = manifest.preparation.map((command) => ({
    ...normalizeBenchmarkCommand(command, required.baseline, "preparation", true),
    network: command.network,
  }));
  for (const command of preparation) validatePreparation(command);
  const toolchains = manifest.toolchains.map((toolchain) => ({
    id: toolchain.id,
    version: normalizeBenchmarkCommand(toolchain.version, required.baseline, "toolchain version"),
  }));
  if (new Set(toolchains.map((toolchain) => toolchain.id)).size !== toolchains.length) {
    throw new Error(`Benchmark scenario ${scenario} has duplicate toolchain ids`);
  }
  const testPathPrefixes = uniqueSorted(manifest.testPaths.prefixes.map(normalizeRepositoryPath));
  for (const pattern of manifest.testPaths.patterns) {
    if (pattern.includes("/") || pattern.includes("\\") || pattern === "." || pattern === "..") {
      throw new Error(`Benchmark test pattern must be a filename pattern: ${pattern}`);
    }
  }
  return {
    id: scenario,
    version: manifest.version,
    root,
    baseline: required.baseline,
    task: required.task,
    evaluator: required.evaluator,
    validator: required.validator,
    manifestPath,
    manifestSha256: contentSha256(manifestContent),
    visibleChecks,
    preparation,
    testPathPrefixes,
    testFilePatterns: uniqueSorted([...manifest.testPaths.patterns]),
    toolchains,
  };
}

function normalizeBenchmarkCommand(
  command: BenchmarkCommand,
  baseline: string,
  label: string,
  preparation = false,
): BenchmarkCommand {
  const argv = [...command.argv];
  try {
    if (preparation || label === "toolchain version") {
      validateControllerArgv(argv, label === "toolchain version");
    } else {
      validateCommandArgv(argv);
    }
  } catch (error) {
    throw new Error(
      `Unsafe benchmark ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (argv.some((part) => /^(?:[a-z]+:)?\/\//iu.test(part))) {
    throw new Error(`Network URL is forbidden in benchmark ${label}: ${argv.join(" ")}`);
  }
  const cwd = normalizeRepositoryPath(command.cwd);
  if (!statSync(resolve(baseline, cwd)).isDirectory()) {
    throw new Error(`Benchmark ${label} cwd is not a baseline directory: ${cwd}`);
  }
  return { argv, cwd };
}

function validateControllerArgv(argv: string[], versionCommand: boolean): void {
  const [program, ...args] = argv;
  if (
    !program ||
    program.includes("/") ||
    program.includes("\\") ||
    [
      "bash",
      "cmd",
      "curl",
      "env",
      "fish",
      "git",
      "powershell",
      "pwsh",
      "rm",
      "sh",
      "ssh",
      "wget",
      "zsh",
    ].includes(program.toLowerCase()) ||
    argv.some(
      (part) => ["|", "||", "&&", ";", ">", ">>", "<"].includes(part) || /[\r\n\0]/u.test(part),
    ) ||
    args.some((arg) => ["-c", "-e", "--eval"].includes(arg))
  ) {
    throw new Error(`unsafe controller command: ${argv.join(" ")}`);
  }
  if (versionCommand && !args.some((arg) => ["--version", "-V", "-v"].includes(arg))) {
    throw new Error(`toolchain command must report a version: ${argv.join(" ")}`);
  }
}

function validatePreparation(command: BenchmarkPreparation): void {
  const [program, action] = command.argv;
  if (program === "npm" && (action !== "ci" || !command.argv.includes("--offline"))) {
    throw new Error("Benchmark npm preparation must use npm ci --offline");
  }
  if (["deploy", "destroy", "publish", "remove", "uninstall", "update"].includes(action ?? "")) {
    throw new Error(`Unsafe benchmark preparation action: ${command.argv.join(" ")}`);
  }
}

function assertScenarioAsset(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink())
    throw new Error(`Benchmark ${label} must not be a symlink: ${path}`);
  if (label === "baseline" ? !metadata.isDirectory() : !metadata.isFile()) {
    throw new Error(`Benchmark ${label} has the wrong type: ${path}`);
  }
}

function benchmarkEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ALL_PROXY: "http://127.0.0.1:9",
    CHANGESAFELY_SENTRY_DSN: "",
    CHANGESAFELY_TELEMETRY: "0",
    CI: "1",
    COMPOSER_DISABLE_NETWORK: "1",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    NO_UPDATE_NOTIFIER: "1",
    PIP_NO_INDEX: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`Benchmark workspace already exists: ${path}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
