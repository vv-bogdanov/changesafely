import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isTestPath, normalizeRepositoryPath } from "../../src/repository-policy.js";
import { type CommandResult, runCommand } from "../../src/runner.js";
import { validateArtifactEnvelope, validateStoredHarnessArtifact } from "../../src/schemas.js";
import {
  ANALYSIS_VERSION,
  type AnalysisDocument,
  type AnalysisManifest,
  validateAnalysisDocument,
  validateAnalysisManifest,
} from "./contracts.js";
import { contentSha256, readVerifiedEvidenceFile, type VerifiedEvidence } from "./evidence.js";
import { materializeAttempt, repositoryCommand, scenarioDefinition } from "./repository.js";

const ANALYSIS_FILE = "analysis.json";
const MANIFEST_FILE = "analysis-manifest.json";

interface MutantDefinition {
  id: string;
  patch: string;
}

export interface VerifiedAnalysis {
  path: string;
  document: AnalysisDocument;
  manifest: AnalysisManifest;
}

export async function evaluateMutationEvidence(
  benchRoot: string,
  evidence: VerifiedEvidence,
): Promise<AnalysisDocument> {
  const scenario = scenarioDefinition(
    benchRoot,
    evidence.run.scenario,
    evidence.run.scenarioVersion ?? 1,
  );
  const oracleRoot = resolve(benchRoot, "oracles", scenario.id);
  const mutants = await loadMutants(join(oracleRoot, "mutants", "manifest.json"));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-mutation-"));
  try {
    const workspace = join(temporaryRoot, "workspace");
    const attempt = await materializeAttempt(scenario, workspace);
    if (attempt.baselineCommit !== evidence.run.baselineCommit) {
      throw new Error("Mutation workspace baseline does not match benchmark evidence");
    }

    const candidateDiff = await readVerifiedEvidenceFile(evidence, "diff.patch");
    const candidatePatch = join(temporaryRoot, "candidate.patch");
    await writeFile(candidatePatch, candidateDiff, { mode: 0o600 });
    await applyPatch(workspace, candidatePatch, candidateDiff.byteLength > 0);

    const changedPaths = (
      await repositoryCommand(
        "git",
        ["diff", "--name-only", "-z", "HEAD"],
        workspace,
        30_000,
        false,
      )
    )
      .split("\0")
      .filter(Boolean);
    const testPaths = changedPaths.filter(isTestPath).sort();
    const testPatch = testPaths.length
      ? await repositoryCommand(
          "git",
          ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...testPaths],
          workspace,
          30_000,
          false,
        )
      : "";
    const testPatchPath = join(temporaryRoot, "candidate-tests.patch");
    await writeFile(testPatchPath, testPatch, { mode: 0o600 });
    const testStats = testPaths.length
      ? parseNumstat(
          await repositoryCommand(
            "git",
            ["diff", "--numstat", "HEAD", "--", ...testPaths],
            workspace,
          ),
        )
      : { additions: 0, deletions: 0 };
    const protectedTests = await protectedTestStatus(evidence, workspace);

    const referenceProcess = await runVariant(
      workspace,
      join(oracleRoot, "reference.patch"),
      testPatchPath,
      testPatch.length > 0,
    );
    const referencePassed = testPaths.length > 0 && commandPassed(referenceProcess);
    const mutantResults = [];
    for (const mutant of mutants) {
      const process = await runVariant(
        workspace,
        join(oracleRoot, "mutants", mutant.patch),
        testPatchPath,
        testPatch.length > 0,
      );
      mutantResults.push({
        id: mutant.id,
        killed: referencePassed && !commandPassed(process),
        process: analysisProcess(process),
      });
    }
    const killed = mutantResults.filter((mutant) => mutant.killed).length;
    return validateAnalysisDocument({
      analysisVersion: ANALYSIS_VERSION,
      runId: evidence.run.runId,
      evidenceManifestSha256: evidence.manifestSha256,
      scenario: scenario.id,
      candidateTests: {
        paths: testPaths,
        patchSha256: contentSha256(testPatch),
        additions: testStats.additions,
        deletions: testStats.deletions,
      },
      reference: {
        passed: referencePassed,
        process: analysisProcess(referenceProcess),
      },
      mutants: mutantResults,
      mutation: {
        killed,
        total: mutantResults.length,
        killRate: referencePassed ? killed / mutantResults.length : null,
      },
      protectedTests,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function createOrVerifyAnalysisPackage(
  resultsRoot: string,
  evidence: VerifiedEvidence,
  input: AnalysisDocument,
): Promise<VerifiedAnalysis> {
  const document = validateAnalysisDocument(input);
  assertAnalysisLineage(document, evidence);
  const packagePath = analysisPath(resultsRoot, document.runId);
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const manifest = validateAnalysisManifest({
    analysisVersion: ANALYSIS_VERSION,
    runId: document.runId,
    evidenceManifestSha256: evidence.manifestSha256,
    analysisSha256: contentSha256(content),
  });
  await mkdir(dirname(packagePath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(packagePath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = await loadAnalysisPackage(resultsRoot, document.runId, evidence);
    if (JSON.stringify(existing.document) !== JSON.stringify(document)) {
      throw new Error(`Benchmark analysis changed for retained run: ${document.runId}`);
    }
    return existing;
  }
  await Promise.all([
    writeFile(join(packagePath, ANALYSIS_FILE), content, { flag: "wx", mode: 0o600 }),
    writeFile(join(packagePath, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  return { path: packagePath, document, manifest };
}

export async function loadAnalysisPackage(
  resultsRoot: string,
  runId: string,
  evidence: VerifiedEvidence,
): Promise<VerifiedAnalysis> {
  validateRunId(runId);
  const packagePath = analysisPath(resultsRoot, runId);
  const entries = await readdir(packagePath, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    JSON.stringify(entries.map((entry) => entry.name).sort()) !==
      JSON.stringify([ANALYSIS_FILE, MANIFEST_FILE].sort())
  ) {
    throw new Error("Benchmark analysis package file set is invalid");
  }
  const [analysisContent, manifestContent] = await Promise.all([
    readFile(join(packagePath, ANALYSIS_FILE), "utf8"),
    readFile(join(packagePath, MANIFEST_FILE), "utf8"),
  ]);
  const document = validateAnalysisDocument(parseJson(analysisContent, ANALYSIS_FILE));
  const manifest = validateAnalysisManifest(parseJson(manifestContent, MANIFEST_FILE));
  if (
    manifest.runId !== runId ||
    document.runId !== runId ||
    manifest.evidenceManifestSha256 !== evidence.manifestSha256 ||
    manifest.analysisSha256 !== contentSha256(analysisContent)
  ) {
    throw new Error("Benchmark analysis hash or lineage mismatch");
  }
  assertAnalysisLineage(document, evidence);
  return { path: packagePath, document, manifest };
}

export async function loadAnalysisPackageIfPresent(
  resultsRoot: string,
  runId: string,
  evidence: VerifiedEvidence,
): Promise<VerifiedAnalysis | undefined> {
  try {
    await lstat(analysisPath(resultsRoot, runId));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  return await loadAnalysisPackage(resultsRoot, runId, evidence);
}

async function runVariant(
  workspace: string,
  solutionPatch: string,
  testPatch: string,
  hasCandidateTests: boolean,
): Promise<CommandResult> {
  await repositoryCommand("git", ["reset", "--hard", "--quiet", "HEAD"], workspace);
  await repositoryCommand("git", ["clean", "-fd", "--quiet"], workspace);
  await applyPatch(workspace, solutionPatch, true);
  await applyPatch(workspace, testPatch, hasCandidateTests);
  return await runCommand(["npm", "test"], workspace, {
    sandboxed: true,
    timeoutMs: 120_000,
    env: {
      ...process.env,
      CHANGESAFELY_TELEMETRY: "0",
      CHANGESAFELY_SENTRY_DSN: "",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
    },
  });
}

async function applyPatch(workspace: string, patch: string, apply: boolean): Promise<void> {
  if (apply) await repositoryCommand("git", ["apply", "--index", patch], workspace);
}

function commandPassed(result: CommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut;
}

function analysisProcess(result: CommandResult): AnalysisDocument["reference"]["process"] {
  return {
    started: true,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  };
}

async function protectedTestStatus(
  evidence: VerifiedEvidence,
  workspace: string,
): Promise<AnalysisDocument["protectedTests"]> {
  if (evidence.run.mode !== "changesafely") {
    return {
      applicable: false,
      intact: null,
      paths: [],
      detail: "Direct mode has no ChangeSafely protected harness.",
    };
  }
  const artifactPath = "changesafely/run/harness.json";
  if (!evidence.manifest.files.some((file) => file.path === artifactPath)) {
    return {
      applicable: false,
      intact: null,
      paths: [],
      detail: "ChangeSafely did not produce a protected harness.",
    };
  }
  const envelope = validateArtifactEnvelope(
    parseJson(
      (await readVerifiedEvidenceFile(evidence, artifactPath)).toString("utf8"),
      artifactPath,
    ),
  );
  const harness = validateStoredHarnessArtifact(envelope.payload);
  const paths = Object.keys(harness.protectedHashes).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...harness.protectedPaths].sort())) {
    throw new Error("Protected harness path and hash sets do not match");
  }
  if (!paths.every(isTestPath)) throw new Error("Protected harness contains a non-test path");
  const matches = await Promise.all(
    paths.map(async (path) => {
      const normalized = normalizeRepositoryPath(path);
      try {
        return (
          contentSha256(await readFile(resolveWithin(workspace, normalized))) ===
          harness.protectedHashes[path]
        );
      } catch {
        return false;
      }
    }),
  );
  const intact = matches.every(Boolean);
  return {
    applicable: true,
    intact,
    paths,
    detail: intact
      ? "All protected test hashes match the final snapshot."
      : "A protected test was removed, replaced, or changed after the harness commit.",
  };
}

async function loadMutants(path: string): Promise<MutantDefinition[]> {
  const value = parseJson(await readFile(path, "utf8"), path);
  const mutants =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as { mutants?: unknown }).mutants
      : undefined;
  if (!Array.isArray(mutants) || mutants.length === 0) {
    throw new Error("Mutation manifest must contain mutants");
  }
  const result = mutants.map((entry): MutantDefinition => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as { id?: unknown }).id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/u.test((entry as { id: string }).id) ||
      typeof (entry as { patch?: unknown }).patch !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,199}\.patch$/u.test((entry as { patch: string }).patch)
    ) {
      throw new Error("Mutation manifest entry is invalid");
    }
    return { id: (entry as { id: string }).id, patch: (entry as { patch: string }).patch };
  });
  if (new Set(result.map((mutant) => mutant.id)).size !== result.length) {
    throw new Error("Mutation ids must be unique");
  }
  return result;
}

function parseNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n").filter(Boolean)) {
    const [added, deleted] = line.split("\t", 2);
    if (!added || !deleted || !/^\d+$/u.test(added) || !/^\d+$/u.test(deleted)) {
      throw new Error("Candidate test diff contains unsupported binary data");
    }
    additions += Number(added);
    deletions += Number(deleted);
  }
  return { additions, deletions };
}

function assertAnalysisLineage(document: AnalysisDocument, evidence: VerifiedEvidence): void {
  if (
    document.runId !== evidence.run.runId ||
    document.scenario !== evidence.run.scenario ||
    document.evidenceManifestSha256 !== evidence.manifestSha256
  ) {
    throw new Error("Benchmark analysis lineage mismatch");
  }
}

function analysisPath(resultsRoot: string, runId: string): string {
  return resolveWithin(resolve(resultsRoot, "analyses"), runId);
}

function resolveWithin(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes benchmark analysis root: ${relativePath}`);
  }
  return path;
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new Error(`Invalid benchmark run id: ${runId}`);
  }
}

function parseJson(content: string, description: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${description}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
