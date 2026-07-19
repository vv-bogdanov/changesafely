#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { errorExitCode, errorNextAction, errorReasonCode, SafeChangeError } from "./errors.js";
import { resumeRun, runFullWorkflow } from "./orchestrator.js";
import {
  exitCodeForOutcome,
  formatJsonOutcome,
  formatRunOutcome,
  loadRunOutcome,
  RUN_OUTCOME_VERSION,
  type RunOutcome,
} from "./outcome.js";
import { captureFailure } from "./telemetry.js";
import { VERSION } from "./version.js";
import { runPlanning } from "./workflow.js";

const HELP = `SafeChange ${VERSION}

Usage:
  safechange plan --task <text> [--plans 1..5] [--repo <path>]
  safechange run --task <text> [--plans 1..5] [--repo <path>]
  safechange resume --run <run-id> [--repo <path>]
  safechange status --run <run-id> [--repo <path>] [--json]
  safechange doctor [--repo <path>] [--json]

Commands:
  plan      Compare plans without changing tracked repository state
  run       Execute the complete test-first change workflow
  resume    Continue a persisted run from a validated phase boundary
  status    Inspect a persisted run without changing it
  doctor    Check local Git, Codex, App Server, and sandbox readiness

Options:
  -h, --help       Show this help
  -v, --version    Show the SafeChange version
`;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SafeChangeError("INVALID_ARGUMENTS", `${name} is required`, {
      nextAction: "Run safechange --help and provide the required argument.",
    });
  }
  return value;
}

function printOutcome(outcome: RunOutcome, json: boolean): void {
  process.stdout.write(json ? formatJsonOutcome(outcome) : formatRunOutcome(outcome));
}

function usageError(message: string): SafeChangeError {
  return new SafeChangeError("INVALID_ARGUMENTS", message, {
    nextAction: "Run safechange --help and correct the command arguments.",
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const json = argv.includes("--json");
  let command = "unknown";
  const abortController = new AbortController();
  let interruptedExitCode: number | undefined;
  const onSigint = () => {
    interruptedExitCode = 130;
    abortController.abort(new Error("Interrupted by SIGINT"));
  };
  const onSigterm = () => {
    interruptedExitCode = 143;
    abortController.abort(new Error("Interrupted by SIGTERM"));
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
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
          json: { type: "boolean" },
        },
      });
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }

    if (parsed.values.version) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (parsed.values.help || parsed.positionals.length === 0) {
      process.stdout.write(HELP);
      return 0;
    }
    if (parsed.positionals.length !== 1) {
      throw usageError(`Unexpected positional arguments: ${parsed.positionals.slice(1).join(" ")}`);
    }
    command = parsed.positionals[0] ?? "unknown";
    if (!["plan", "run", "resume", "status", "doctor"].includes(command)) {
      throw usageError(`Unknown command: ${command}`);
    }

    const repoPath = resolve(requiredString(parsed.values.repo, "--repo"));
    if (command === "doctor") {
      const report = await runDoctor({ repoPath });
      process.stdout.write(
        parsed.values.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report),
      );
      return report.ok ? 0 : 2;
    }
    if (command === "resume") {
      const runId = requiredString(parsed.values.run, "--run");
      const result = await resumeRun(repoPath, runId, abortController.signal);
      printOutcome(result, json);
      return interruptedExitCode ?? exitCodeForOutcome(result);
    }
    if (command === "status") {
      const outcome = await loadRunOutcome(repoPath, requiredString(parsed.values.run, "--run"));
      printOutcome(outcome, json);
      return exitCodeForOutcome(outcome);
    }
    const task = requiredString(parsed.values.task, "--task");
    const testModel = process.env.SAFECHANGE_LIVE_TEST_MODEL?.trim() || undefined;
    const plannerCount = Number(parsed.values.plans);
    if (!Number.isInteger(plannerCount) || plannerCount < 1 || plannerCount > 5) {
      throw usageError("--plans must be an integer from 1 to 5");
    }
    const result =
      command === "plan"
        ? await runPlanning({
            repoPath,
            task,
            plannerCount,
            parallelPlanners: true,
            signal: abortController.signal,
            ...(testModel ? { model: testModel } : {}),
          })
        : await runFullWorkflow({
            repoPath,
            task,
            plannerCount,
            signal: abortController.signal,
            ...(testModel ? { model: testModel } : {}),
          });
    printOutcome(result, json);
    return interruptedExitCode ?? exitCodeForOutcome(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`SafeChange failed: ${message}\n`);
    if (json) {
      process.stdout.write(
        formatJsonOutcome({
          outcomeVersion: RUN_OUTCOME_VERSION,
          status: "ERROR",
          reasonCode: errorReasonCode(error),
          reason: message,
          nextAction: errorNextAction(error),
        }),
      );
    }
    await captureFailure(errorReasonCode(error), command);
    return interruptedExitCode ?? errorExitCode(error);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
