import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import { runCommand, validateCommandArgv } from "../src/runner.js";

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
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("env", () => assert.equal(process.env.SAFECHANGE_SECRET, undefined));\n',
    "utf8",
  );
  const result = await runCommand(["node", "--test", path], cwd, {
    env: { ...process.env, SAFECHANGE_SECRET: "must-not-leak" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.sandboxed, false);
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
