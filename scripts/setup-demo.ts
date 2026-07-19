#!/usr/bin/env node

import { cp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import spawn from "cross-spawn";

function run(command: string, args: string[], cwd: string, timeout: number): void {
  const result = spawn.sync(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `${command} exited with ${String(result.status)}`));
  }
}

const defaultTarget = join(tmpdir(), "safechange-payment-demo");
const parsed = parseArgs({
  options: { target: { type: "string", default: defaultTarget } },
});
const target = resolve(parsed.values.target ?? defaultTarget);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const template = join(packageRoot, "demo", "payment-retry-template");

await mkdir(dirname(target), { recursive: true });
await cp(template, target, { recursive: true, errorOnExist: true, force: false });
await writeFile(join(target, ".gitignore"), "node_modules/\ndist/\n.safechange/\n", "utf8");
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], target, 120_000);
run("git", ["init", "-b", "main"], target, 10_000);
run("git", ["config", "user.name", "SafeChange Demo"], target, 10_000);
run("git", ["config", "user.email", "demo@safechange.local"], target, 10_000);
run("git", ["add", "."], target, 10_000);
run("git", ["commit", "-m", "demo baseline"], target, 10_000);

const task = "Retry a payment once after a transient timeout without allowing a duplicate charge";
process.stdout.write(
  `Demo: ${target}\nRun: safechange run --repo ${JSON.stringify(target)} --plans 3 --task ${JSON.stringify(task)}\n`,
);
