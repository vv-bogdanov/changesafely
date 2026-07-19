import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export async function validateScenario(scenarioRoot) {
  const scenario = basename(scenarioRoot);
  const benchRoot = join(scenarioRoot, "../..");
  const baselineRoot = join(scenarioRoot, "baseline");
  const oracleRoot = join(benchRoot, "oracles", scenario);
  const evaluator = join(oracleRoot, "evaluate.mjs");
  const temporaryRoot = await mkdtemp(join(tmpdir(), `changesafely-${scenario}-`));
  const workspace = join(temporaryRoot, "workspace");

  try {
    await cp(baselineRoot, workspace, {
      recursive: true,
      filter: (source) => !["dist", "node_modules"].includes(basename(source)),
    });
    command("npm", ["ci", "--ignore-scripts", "--offline"], workspace, 120_000);
    command("git", ["init", "--quiet"], workspace);
    command("git", ["config", "user.name", "ChangeSafely Benchmark"], workspace);
    command("git", ["config", "user.email", "benchmark@changesafely.local"], workspace);
    command("git", ["add", "."], workspace);
    command("git", ["commit", "--quiet", "-m", "baseline"], workspace);

    const baseline = evaluate(evaluator, workspace);
    assert(baseline.summary.visible, "baseline visible checks must pass");
    assert(!baseline.summary.acceptance, "baseline must fail new-task acceptance");

    reset(workspace);
    apply(join(oracleRoot, "reference.patch"), workspace);
    const reference = evaluate(evaluator, workspace);
    assert(reference.passed, failedMessage("reference", reference));
    assert(
      JSON.stringify(reference) === JSON.stringify(evaluate(evaluator, workspace)),
      "reference evaluator result is not deterministic",
    );

    const manifest = JSON.parse(await readFile(join(oracleRoot, "mutants/manifest.json"), "utf8"));
    const mutants = [];
    for (const mutant of manifest.mutants) {
      reset(workspace);
      apply(join(oracleRoot, "mutants", mutant.patch), workspace);
      const result = evaluate(evaluator, workspace);
      const failedChecks = result.checks.filter((check) => !check.passed).map((check) => check.id);
      assert(result.summary.visible, `${mutant.id} must remain visible-green`);
      assert(!result.passed, `${mutant.id} unexpectedly passed the hidden evaluator`);
      for (const expectedFailure of mutant.expectedFailures) {
        assert(
          failedChecks.includes(expectedFailure),
          `${mutant.id} did not demonstrate ${expectedFailure}`,
        );
      }
      mutants.push({ id: mutant.id, outcome: "unsafe_green", failedChecks });
    }

    return {
      schemaVersion: 1,
      scenario,
      baseline: summarize(baseline),
      reference: summarize(reference),
      mutants,
      deterministicReplay: true,
      passed: true,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function evaluate(evaluator, workspace) {
  const result = spawnSync(process.execPath, [evaluator, workspace], {
    encoding: "utf8",
    timeout: 180_000,
    env: isolatedEnvironment(),
  });
  if (result.status !== 0) {
    throw new Error(`evaluator failed: ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
  return JSON.parse(result.stdout);
}

function apply(patch, workspace) {
  command("git", ["apply", patch], workspace);
}

function reset(workspace) {
  command("git", ["reset", "--hard", "--quiet", "HEAD"], workspace);
  command("git", ["clean", "-fd", "--quiet"], workspace);
}

function command(program, args, cwd, timeout = 30_000) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: isolatedEnvironment(),
  });
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout;
    throw new Error(`${program} ${args.join(" ")} failed: ${detail.trim().slice(0, 2000)}`);
  }
}

function isolatedEnvironment() {
  return {
    ...process.env,
    CHANGESAFELY_SENTRY_DSN: "",
    CHANGESAFELY_TELEMETRY: "0",
    NO_UPDATE_NOTIFIER: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
  };
}

function summarize(result) {
  return {
    passed: result.passed,
    summary: result.summary,
    failedChecks: result.checks.filter((check) => !check.passed).map((check) => check.id),
  };
}

function failedMessage(label, result) {
  const failures = result.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.id}: ${check.detail}`);
  return `${label} failed: ${failures.join("; ")}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
