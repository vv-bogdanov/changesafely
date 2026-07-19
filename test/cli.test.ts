import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { main } from "../src/cli.js";

const execFileAsync = promisify(execFile);

test("runs the CLI through an npm-style symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "safechange-cli-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const link = join(directory, "safechange");
  await symlink(join(process.cwd(), "dist", "src", "cli.js"), link);

  const { stdout: version } = await execFileAsync(process.execPath, [link, "--version"]);
  const { stdout: help } = await execFileAsync(process.execPath, [link, "--help"]);
  assert.equal(version, "0.1.0\n");
  assert.match(help, /safechange run --task/);
});

test("implements help, version, and invalid CLI contracts", async (t) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });

  assert.equal(await main(["--version"]), 0);
  assert.equal(await main(["--help"]), 0);
  assert.equal(await main(["unknown"]), 1);
  assert.equal(await main(["plan", "--task", "bounded", "--plans", "0"]), 1);
  assert.equal(await main(["resume"]), 1);

  assert.match(stdout.join(""), /0\.1\.0/);
  assert.match(stdout.join(""), /safechange resume/);
  assert.match(stderr.join(""), /Unknown command: unknown/);
  assert.match(stderr.join(""), /--plans must be an integer from 1 to 5/);
  assert.match(stderr.join(""), /--run is required/);
});
