import { execFile } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const parsed = parseArgs({
  options: { target: { type: "string", default: "/tmp/safechange-payment-demo" } },
});
const target = resolve(parsed.values.target ?? "/tmp/safechange-payment-demo");
const template = join(process.cwd(), "demo", "payment-retry-template");

await mkdir(dirname(target), { recursive: true });
await cp(template, target, { recursive: true, errorOnExist: true, force: false });
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

process.stdout.write(`${target}\n`);
