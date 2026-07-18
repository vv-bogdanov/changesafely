#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const parsed = parseArgs({
  options: { target: { type: "string", default: "/tmp/safechange-payment-demo" } },
});
const target = resolve(parsed.values.target ?? "/tmp/safechange-payment-demo");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const template = join(packageRoot, "demo", "payment-retry-template");

await mkdir(dirname(target), { recursive: true });
await cp(template, target, { recursive: true, errorOnExist: true, force: false });
await writeFile(
  join(target, ".gitignore"),
  "node_modules/\ndist/\n.safechange/\n",
  "utf8",
);
await execFileAsync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: target,
  timeout: 120_000,
});
await execFileAsync("git", ["init", "-b", "main"], { cwd: target, timeout: 10_000 });
await execFileAsync("git", ["config", "user.name", "SafeChange Demo"], {
  cwd: target,
  timeout: 10_000,
});
await execFileAsync("git", ["config", "user.email", "demo@safechange.local"], {
  cwd: target,
  timeout: 10_000,
});
await execFileAsync("git", ["add", "."], { cwd: target, timeout: 10_000 });
await execFileAsync("git", ["commit", "-m", "demo baseline"], {
  cwd: target,
  timeout: 10_000,
});

const task = "Retry a payment once after a transient timeout without allowing a duplicate charge";
process.stdout.write(
  `Demo: ${target}\nRun: safechange run --repo ${JSON.stringify(target)} --plans 3 --task ${JSON.stringify(task)}\n`,
);
