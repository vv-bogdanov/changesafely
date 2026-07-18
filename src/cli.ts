#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PreflightError } from "./git.js";
import { runPlanning } from "./workflow.js";

const VERSION = "0.0.1";

const HELP = `SafeChange ${VERSION}

Usage:
  safechange plan --task <text> [--plans 1..5] [--repo <path>]
  safechange run --task <text> [--plans 1..5] [--repo <path>]
  safechange resume --run <run-id> [--repo <path>]

Commands:
  plan      Compare plans without changing tracked repository state
  run       Execute the complete test-first change workflow
  resume    Continue a persisted run from a validated phase boundary

Options:
  -h, --help       Show this help
  -v, --version    Show the SafeChange version
`;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      task: { type: "string" },
      plans: { type: "string", default: "3" },
      repo: { type: "string", default: process.cwd() },
      run: { type: "string" },
    },
  });

  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = parsed.positionals[0];
  if (command !== "plan" && command !== "run" && command !== "resume") {
    process.stderr.write(`Unknown command: ${command ?? ""}\n\n${HELP}`);
    return 1;
  }
  if (command !== "plan") {
    process.stderr.write(`The ${command} workflow is not implemented yet.\n`);
    return 1;
  }

  try {
    const task = requiredString(parsed.values.task, "--task");
    const plannerCount = Number(parsed.values.plans);
    if (!Number.isInteger(plannerCount) || plannerCount < 1 || plannerCount > 5) {
      throw new Error("--plans must be an integer from 1 to 5");
    }
    const repoPath = resolve(requiredString(parsed.values.repo, "--repo"));
    const result = await runPlanning({ repoPath, task, plannerCount });
    process.stdout.write(
      `Run: ${result.runId}\nStatus: ${result.status}\nReport: ${result.reportPath}\n`,
    );
    return result.status === "PLANNED" ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`SafeChange failed: ${message}\n`);
    return error instanceof PreflightError ? 2 : 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
