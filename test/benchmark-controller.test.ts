import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { COMPARISON_VERSION, EVIDENCE_VERSION, type RunDocument } from "../bench/src/contracts.js";
import { classifyTechnicalFailure } from "../bench/src/controller.js";
import {
  contentSha256,
  createEvidencePackage,
  loadEvidencePackage,
  readVerifiedEvidenceFile,
} from "../bench/src/evidence.js";
import { prepareCodexHome } from "../bench/src/isolation.js";
import {
  materializeAttempt,
  scenarioDefinition,
  snapshotAttempt,
} from "../bench/src/repository.js";

const projectRoot = process.cwd();
const benchRoot = join(projectRoot, "bench");
const execFileAsync = promisify(execFile);

test("materializes an isolated Git baseline and snapshots only source evidence", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-repo-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const scenario = scenarioDefinition(benchRoot, "double-charge");
  const attempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace"), {
    installDependencies: false,
  });
  const secondAttempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace-2"), {
    installDependencies: false,
  });

  await writeFile(
    join(attempt.workspace, "src", "candidate.ts"),
    "export const candidate = true;\n",
  );
  await mkdir(join(attempt.workspace, "dist"));
  await writeFile(join(attempt.workspace, "dist", "ignored.js"), "ignored\n");
  const snapshot = await snapshotAttempt(attempt.workspace, attempt.baselineCommit);

  assert.match(attempt.baselineCommit, /^[a-f0-9]{40,64}$/u);
  assert.equal(secondAttempt.baselineCommit, attempt.baselineCommit);
  assert.match(snapshot.snapshotCommit, /^[a-f0-9]{40,64}$/u);
  assert.deepEqual(snapshot.changedFiles, ["src/candidate.ts"]);
  assert.match(snapshot.diff, /candidate = true/u);
  assert.doesNotMatch(snapshot.diff, /ignored\.js/u);
});

test("scope evaluation sees forbidden files after the controller snapshot commit", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-scope-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const scenario = scenarioDefinition(benchRoot, "double-charge");
  const attempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace"), {
    installDependencies: false,
  });
  await writeFile(join(attempt.workspace, "README.md"), "forbidden benchmark change\n");
  await snapshotAttempt(attempt.workspace, attempt.baselineCommit);

  const { stdout } = await execFileAsync(
    process.execPath,
    [scenario.evaluator, attempt.workspace],
    {
      timeout: 180_000,
    },
  );
  const evaluation = JSON.parse(stdout) as {
    checks: Array<{ id: string; passed: boolean; detail: string }>;
  };
  const forbidden = evaluation.checks.find((check) => check.id === "forbidden-files");
  assert.equal(forbidden?.passed, false);
  assert.match(forbidden?.detail ?? "", /README\.md/u);
});

test("creates immutable hash-verified evidence and fails closed on corruption", async (t) => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-evidence-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  const run = runDocument("evidence-run");
  const created = await createEvidencePackage(resultsRoot, run, {
    "comparison.json": comparisonContent(run),
    "diff.patch": "diff --git a/a b/a\n",
    "events.jsonl": '{"type":"synthetic"}\n',
  });

  const verified = await loadEvidencePackage(resultsRoot, run.runId);
  assert.equal(verified.run.taskSha256, contentSha256(run.taskText));
  assert.equal(
    (await readVerifiedEvidenceFile(verified, "events.jsonl")).toString(),
    '{"type":"synthetic"}\n',
  );
  const { stdout: replayOutput } = await execFileAsync(
    process.execPath,
    [
      join(projectRoot, "dist/bench/src/cli.js"),
      "replay",
      "--run",
      run.runId,
      "--results",
      resultsRoot,
    ],
    { timeout: 10_000 },
  );
  assert.equal(JSON.parse(replayOutput).verified, true);
  if (process.platform !== "win32") {
    assert.equal((await stat(created.path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(created.path, "run.json"))).mode & 0o777, 0o600);
  }
  await assert.rejects(
    createEvidencePackage(resultsRoot, run, {
      "comparison.json": comparisonContent(run),
      "diff.patch": "",
      "events.jsonl": "",
    }),
    /already exists/u,
  );

  await writeFile(join(created.path, "diff.patch"), "tampered\n");
  await assert.rejects(loadEvidencePackage(resultsRoot, run.runId), /hash mismatch/u);
});

test("rejects extra evidence and path traversal", async (t) => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "changesafely-benchmark-extra-"));
  t.after(async () => rm(resultsRoot, { recursive: true, force: true }));
  const run = runDocument("extra-run");
  const created = await createEvidencePackage(resultsRoot, run, {
    "comparison.json": comparisonContent(run),
    "diff.patch": "",
    "events.jsonl": "",
  });
  await writeFile(join(created.path, "unexpected.txt"), "extra\n");
  await assert.rejects(loadEvidencePackage(resultsRoot, run.runId), /file set/u);

  await assert.rejects(
    createEvidencePackage(resultsRoot, runDocument("traversal-run"), {
      "../escape": "bad",
      "comparison.json": comparisonContent(runDocument("traversal-run")),
      "diff.patch": "",
      "events.jsonl": "",
    }),
    /Invalid evidence path/u,
  );
});

test("builds a minimal Codex home with a deny-network permission profile", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-codex-home-"));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const source = join(temporaryRoot, "source");
  const destination = join(temporaryRoot, "destination");
  await mkdir(source);
  await writeFile(join(source, "auth.json"), '{"fake":"credential"}\n');
  await prepareCodexHome(source, destination, "changesafely-benchmark", "/runtime/node");
  const config = await readFile(join(destination, "config.toml"), "utf8");
  assert.match(config, /default_permissions = "changesafely-benchmark"/u);
  assert.match(config, /enabled = false/u);
  assert.match(config, /"\/runtime\/node" = "read"/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(destination, "auth.json"))).mode & 0o777, 0o600);
  }
});

test("classifies incomplete worker evidence as technical failure", () => {
  const complete = {
    started: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputPresent: true,
    eventsValid: true,
  };
  assert.equal(classifyTechnicalFailure(complete), undefined);
  assert.equal(
    classifyTechnicalFailure({ ...complete, started: false })?.reason,
    "process_not_started",
  );
  assert.equal(classifyTechnicalFailure({ ...complete, timedOut: true })?.reason, "timeout");
  assert.equal(
    classifyTechnicalFailure({ ...complete, signal: "SIGTERM" })?.reason,
    "process_signaled",
  );
  assert.equal(classifyTechnicalFailure({ ...complete, exitCode: 1 })?.reason, "process_failed");
  assert.equal(
    classifyTechnicalFailure({ ...complete, outputPresent: false })?.reason,
    "missing_output",
  );
  assert.equal(
    classifyTechnicalFailure({ ...complete, eventsValid: false })?.reason,
    "events_invalid",
  );
});

test("benchmark CLI refuses final-model runs before explicit authorization", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        join(projectRoot, "dist/bench/src/cli.js"),
        "run",
        "--scenario",
        "double-charge",
        "--mode",
        "direct",
        "--model",
        "gpt-5.6-codex",
      ],
      { timeout: 10_000 },
    ),
    (error: unknown) => {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      assert.match(stderr, /Final measurements require a separate explicit user command/u);
      return true;
    },
  );
});

function runDocument(runId: string): RunDocument {
  const taskText = "Synthetic benchmark task\n";
  const run: RunDocument = {
    evidenceVersion: EVIDENCE_VERSION,
    runId,
    comparisonId: "comparison-0123456789abcdef",
    comparisonSha256: "0".repeat(64),
    scenario: "double-charge",
    mode: "direct",
    taskText,
    taskSha256: contentSha256(taskText),
    baselineCommit: "a".repeat(40),
    snapshotCommit: "b".repeat(40),
    model: "test-model",
    effort: "medium",
    environment: {
      nodeVersion: process.version,
      gitVersion: "git version test",
      codexVersion: "codex-cli test",
      changesafelyVersion: "0.1.0",
      platform: process.platform,
      architecture: process.arch,
    },
    isolation: {
      provider: "codex-permission-profile",
      permissionProfile: "changesafely-benchmark",
      canarySha256: "c".repeat(64),
      agentToolNetwork: "disabled",
    },
    worker: {
      startedAt: "2026-07-19T00:00:00.000Z",
      completedAt: "2026-07-19T00:00:01.000Z",
      durationMs: 1000,
      exitCode: 0,
      signal: null,
      timedOut: false,
    },
    usage: {
      turns: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
    },
    outcome: "safe_success",
  };
  run.comparisonSha256 = contentSha256(comparisonContent(run));
  return run;
}

function comparisonContent(run: RunDocument): string {
  return `${JSON.stringify(
    {
      comparisonVersion: COMPARISON_VERSION,
      comparisonId: run.comparisonId,
      createdAt: "2026-07-19T00:00:00.000Z",
      scenario: run.scenario,
      taskText: run.taskText,
      taskSha256: run.taskSha256,
      baselineCommit: run.baselineCommit,
      model: run.model,
      effort: run.effort,
      timeoutMs: 3_600_000,
      permissionProfile: run.isolation.permissionProfile,
      agentToolNetwork: "disabled",
      visibleChecks: ["npm test"],
      evaluatorSha256: "e".repeat(64),
      executionOrder: ["direct", "changesafely"],
      maxAttemptsPerMode: 1,
      environment: run.environment,
    },
    null,
    2,
  )}\n`;
}
