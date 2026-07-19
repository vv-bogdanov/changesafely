import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function run(command, args, cwd, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: {
      ...process.env,
      CHANGESAFELY_SENTRY_DSN: "",
      CHANGESAFELY_TELEMETRY: "0",
      NO_UPDATE_NOTIFIER: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function runStandardScopeChecks({ checks, root, oracleRoot, baselineRoot }) {
  await check(checks, "public-api", "scope", async () => {
    const expected = await readFile(join(oracleRoot, "expected-api.d.ts"), "utf8");
    const sourceName = expected.match(/^\/\/ source: (.+)$/mu)?.[1];
    assert(sourceName, "expected API must declare its source file");
    const actual = await readFile(join(root, "dist", "src", sourceName), "utf8");
    assert(normalizePublicApi(actual) === normalizePublicApi(expected), "public API changed");
  });

  await check(checks, "production-dependencies", "scope", async () => {
    const baseline = JSON.parse(await readFile(join(baselineRoot, "package.json"), "utf8"));
    const candidate = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert(
      stableJson(candidate.dependencies ?? {}) === stableJson(baseline.dependencies ?? {}),
      "production dependencies changed",
    );
  });

  await check(checks, "forbidden-files", "scope", async () => {
    const rootCommit = run("git", ["rev-list", "--max-parents=0", "HEAD"], root);
    assert(rootCommit.status === 0, commandFailure(rootCommit));
    const committed = run(
      "git",
      ["diff", "--name-only", "-z", rootCommit.stdout.trim(), "HEAD"],
      root,
    );
    assert(committed.status === 0, commandFailure(committed));
    const status = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
    assert(status.status === 0, commandFailure(status));
    const files = new Set([
      ...committed.stdout.split("\0").filter(Boolean),
      ...status.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(3)),
    ]);
    const forbidden = [...files].filter((file) => !/^(src|test)\//u.test(file));
    assert(forbidden.length === 0, `forbidden changed files: ${forbidden.join(", ")}`);
  });
}

export function evaluationDocument(scenario, checks) {
  const categoryPassed = (category) =>
    checks.filter((check) => check.category === category).every((check) => check.passed);
  const summary = {
    visible: categoryPassed("visible"),
    acceptance: categoryPassed("acceptance"),
    preservation: categoryPassed("preservation"),
    scope: categoryPassed("scope"),
  };
  return {
    schemaVersion: 1,
    scenario,
    checks,
    summary,
    passed: Object.values(summary).every(Boolean),
  };
}

export async function check(checks, id, category, operation) {
  try {
    await operation();
    checks.push({ id, category, passed: true, detail: "passed" });
  } catch (error) {
    checks.push({
      id,
      category,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function captureRejection(operation) {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

export function commandFailure(result) {
  const detail = result.error || result.stderr || result.stdout || `exit status ${result.status}`;
  return detail.trim().slice(0, 1000);
}

function normalizePublicApi(value) {
  return value
    .split("\n")
    .filter((line) => !/^\/\/ source:/u.test(line))
    .filter((line) => !/^\s*(?:private\b|#private;)/u.test(line))
    .join("\n")
    .trim()
    .replace(/\s+/gu, " ");
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}
