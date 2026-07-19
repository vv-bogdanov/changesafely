import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import fc from "fast-check";
import { runCommand, toCommandEvidence, validateCommandArgv } from "../src/runner.js";

const shellOperators = ["|", "||", "&&", ";", ">", ">>", "<"] as const;
const shellOperatorSet = new Set<string>(shellOperators);

test("runner rejects installers and shell operators", () => {
  assert.throws(() => validateCommandArgv(["npm", "install"]), /not approved/);
  assert.throws(
    () => validateCommandArgv(["npm", "test", "&&", "npm", "run", "build"]),
    /Shell operators are forbidden/,
  );
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
  const cwd = await mkdtemp(join(tmpdir(), "safechange-runner-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "env.test.js");
  await writeFile(
    path,
    `import test from "node:test";
import assert from "node:assert/strict";
test("env", () => {
  assert.equal(process.env.SAFECHANGE_SECRET, undefined);
  assert.equal(process.env.CODEX_HOME, undefined);
  assert.equal(process.env.HTTP_PROXY, undefined);
  assert.notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});
});
`,
    "utf8",
  );
  const result = await runCommand(["node", "--test", path], cwd, {
    env: { ...process.env, SAFECHANGE_SECRET: "must-not-leak" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.sandboxed, false);
});

test("runner keeps only a bounded output tail and emits private evidence", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "safechange-output-"));
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
  const [evidence] = toCommandEvidence([result]);
  assert.equal(evidence?.command, "npm test");
  assert.equal("stdout" in (evidence ?? {}), false);
  assert.equal("stderr" in (evidence ?? {}), false);
  assert.equal("cwd" in (evidence ?? {}), false);
  assert.equal("argv" in (evidence ?? {}), false);
});

test("runner terminates a timed-out command and records the timeout", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "safechange-timeout-"));
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
  const cwd = await mkdtemp(join(tmpdir(), "safechange-tree-"));
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
  const cwd = await mkdtemp(join(tmpdir(), "safechange-abort-"));
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
