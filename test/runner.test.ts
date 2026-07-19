import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import fc from "fast-check";
import {
  isSafetyTestCommand,
  runCommand,
  toCommandEvidence,
  validateCommandArgv,
} from "../src/runner.js";
import { loadTrace, TraceWriter } from "../src/trace.js";

const shellOperators = ["|", "||", "&&", ";", ">", ">>", "<"] as const;
const shellOperatorSet = new Set<string>(shellOperators);

test("runner rejects installers and shell operators", () => {
  assert.throws(() => validateCommandArgv(["npm", "install"]), /not approved/);
  assert.throws(
    () => validateCommandArgv(["npm", "test", "&&", "npm", "run", "build"]),
    /Shell operators are forbidden/,
  );
});

test("runner accepts bounded targeted test and verification scripts", () => {
  for (const argv of [
    ["npm", "test", "--", "payment"],
    ["npm", "run", "test:unit"],
    ["npm", "run", "test:unit", "--", "payment"],
    ["npm", "run", "lint:ci"],
    ["npm", "run", "check:types", "--", "--pretty", "false"],
  ]) {
    assert.doesNotThrow(() => validateCommandArgv(argv));
  }
  assert.equal(isSafetyTestCommand(["npm", "run", "test:unit", "--", "payment"]), true);
  assert.equal(isSafetyTestCommand(["npm", "run", "lint"]), false);
  assert.throws(() => validateCommandArgv(["npm", "run", "deploy"]), /not approved/);
  assert.throws(() => validateCommandArgv(["npm", "run", "test:unit", "payment"]), /not approved/);
});

test("runner fuzz gate rejects shell operators at every argv position", () => {
  const nonOperator = fc.string({ minLength: 1 }).filter((value) => !shellOperatorSet.has(value));

  fc.assert(
    fc.property(
      fc.array(nonOperator, { maxLength: 8 }),
      fc.constantFrom(...shellOperators),
      fc.nat(),
      (parts, operator, position) => {
        const argv = [...parts];
        argv.splice(position % (argv.length + 1), 0, operator);
        assert.throws(() => validateCommandArgv(argv), /Shell operators are forbidden/);
      },
    ),
    { numRuns: 1_000 },
  );
});

test("runner sanitizes environment and records a real successful exit", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "changesafely-runner-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "env.test.js");
  await writeFile(
    path,
    `import test from "node:test";
import assert from "node:assert/strict";
test("env", () => {
  assert.equal(process.env.CHANGESAFELY_SECRET, undefined);
  assert.equal(process.env.CODEX_HOME, undefined);
  assert.equal(process.env.HTTP_PROXY, undefined);
  assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});
});
`,
    "utf8",
  );
  const result = await runCommand(["node", "--test", path], cwd, {
    env: { ...process.env, CHANGESAFELY_SECRET: "must-not-leak" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.sandboxed, false);
});

test("runner keeps only a bounded output tail and emits private evidence", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "changesafely-output-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "output.js");
  await writeFile(
    path,
    'process.stdout.write("x".repeat(10000));\nprocess.stderr.write("y".repeat(10000));\n',
    "utf8",
  );
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ scripts: { test: "node output.js" }, type: "module" })}\n`,
    "utf8",
  );

  const result = await runCommand(["npm", "test"], cwd, { maxOutputBytes: 64 });
  assert.equal(Buffer.byteLength(result.stdout), 64);
  assert.equal(Buffer.byteLength(result.stderr), 64);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  const [evidence] = toCommandEvidence([result], cwd);
  assert.equal(evidence?.command, "npm test");
  assert.equal("stdout" in (evidence ?? {}), false);
  assert.equal("stderr" in (evidence ?? {}), false);
  assert.equal(evidence?.cwd, ".");
  assert.deepEqual(evidence?.argv, ["npm", "test"]);
  assert.ok((evidence?.stdoutBytes ?? 0) >= 10_000);
  assert.equal(evidence?.stderrBytes, 10_000);
  assert.match(evidence?.stdoutSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(evidence?.stderrSha256 ?? "", /^[a-f0-9]{64}$/);
});

test("runner persists raw tails only with local diagnostics opt-in", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "changesafely-diagnostic-output-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "diagnostic.test.js");
  await writeFile(
    path,
    'import test from "node:test";\ntest("diagnostic", () => process.stderr.write("private-output-marker\\n"));\n',
    "utf8",
  );
  const trace = new TraceWriter(cwd, "diagnostic-run", true);
  const result = await runCommand(["node", "--test", path], cwd, {
    trace,
    phase: "deterministic-verification",
  });
  assert.equal(result.exitCode, 0);
  const document = await loadTrace(cwd, "diagnostic-run");
  const completed = document.events.find(
    (event) => event.component === "command" && event.status === "completed",
  );
  assert.equal(completed?.stdoutBytes, result.stdoutBytes);
  assert.equal(completed?.stderrBytes, result.stderrBytes);
  assert.equal(completed?.stdoutTruncated, result.stdoutTruncated);
  assert.equal(completed?.stderrTruncated, result.stderrTruncated);
  assert.equal(completed?.argv?.[0], "node");
  assert.ok(completed?.diagnosticsPaths?.length);
  assert.doesNotMatch(await readFile(document.tracePath, "utf8"), /private-output-marker/);
  const diagnostics = await Promise.all(
    (completed?.diagnosticsPaths ?? []).map((file) => readFile(join(trace.runPath, file), "utf8")),
  );
  assert.match(diagnostics.join("\n"), /private-output-marker/);
});

test("runner terminates a timed-out command and records the timeout", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "changesafely-timeout-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "slow.test.js");
  await writeFile(
    path,
    'import test from "node:test";\ntest("slow", async () => new Promise((resolve) => setTimeout(resolve, 5000)));\n',
    "utf8",
  );
  const result = await runCommand(["node", "--test", path], cwd, { timeoutMs: 20 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("runner terminates descendants when a command times out", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "changesafely-tree-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const marker = join(cwd, "descendant-survived.txt");
  const path = join(cwd, "tree.test.js");
  await writeFile(
    path,
    `import { spawn } from "node:child_process";
import test from "node:test";
test("tree", async () => {
  spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 250)`)}], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 5000));
});
`,
    "utf8",
  );

  const result = await runCommand(["node", "--test", path], cwd, { timeoutMs: 30 });
  assert.equal(result.timedOut, true);
  await delay(400);
  await assert.rejects(access(marker));
});

test("runner stops when its abort signal fires", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "changesafely-abort-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "abort.test.js");
  await writeFile(
    path,
    'import test from "node:test";\ntest("abort", async () => new Promise((resolve) => setTimeout(resolve, 5000)));\n',
    "utf8",
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  const result = await runCommand(["node", "--test", path], cwd, {
    signal: controller.signal,
  });
  assert.equal(result.timedOut, false);
  assert.notEqual(result.exitCode, 0);
});
