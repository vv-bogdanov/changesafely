#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { loadEvidencePackage } from "./evidence.js";
import { proveIsolation } from "./isolation.js";
import { materializeAttempt, scenarioDefinition } from "./repository.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const benchRoot = join(projectRoot, "bench");

const help = `ChangeSafely Risk Suite

Usage:
  npm run benchmark -- validate --scenario double-charge
  npm run benchmark -- canary --scenario double-charge
  npm run benchmark -- replay --run <run-id> [--results <path>]

Live Direct and ChangeSafely adapters are added only after deterministic validation and
isolation pass. Final measured runs always require a separate explicit user command.
`;

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        results: { type: "string" },
        run: { type: "string" },
        scenario: { type: "string" },
      },
    });
    if (parsed.values.help || parsed.positionals.length === 0) {
      process.stdout.write(help);
      return 0;
    }

    const [command, ...extra] = parsed.positionals;
    if (extra.length > 0) throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
    if (command === "validate") {
      const scenario = required(parsed.values.scenario, "--scenario");
      const definition = scenarioDefinition(benchRoot, scenario);
      const validator = join(definition.root, "validate.mjs");
      const { stdout } = await execFileAsync(process.execPath, [validator], {
        cwd: projectRoot,
        timeout: 300_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      process.stdout.write(stdout);
      return 0;
    }

    if (command === "canary") {
      const scenario = scenarioDefinition(
        benchRoot,
        required(parsed.values.scenario, "--scenario"),
      );
      const temporaryRoot = await mkdtemp(join(tmpdir(), "changesafely-isolation-proof-"));
      try {
        const attempt = await materializeAttempt(scenario, join(temporaryRoot, "workspace"), {
          installDependencies: false,
        });
        const proof = await proveIsolation(projectRoot, attempt.workspace);
        process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      return 0;
    }

    if (command === "replay") {
      const runId = required(parsed.values.run, "--run");
      const resultsRoot = resolve(parsed.values.results ?? join(benchRoot, "results"));
      const evidence = await loadEvidencePackage(resultsRoot, runId);
      process.stdout.write(
        `${JSON.stringify({ verified: true, run: evidence.run, manifest: evidence.manifest }, null, 2)}\n`,
      );
      return 0;
    }

    if (["evaluate", "report", "run"].includes(command ?? "")) {
      throw new Error(`${command} is not available until its STEP.md implementation phase`);
    }
    throw new Error(`Unknown benchmark command: ${command}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function required(value: string | undefined, option: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${option} is required`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
