import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeEnvironment } from "./environment.js";

export interface CommandResult {
  argv: string[];
  cwd: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  sandboxed: boolean;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  sandboxed?: boolean;
}

const forbiddenTokens = new Set(["|", "||", "&&", ";", ">", ">>", "<"]);

export function isTestCommand(argv: string[]): boolean {
  const [program, ...args] = argv;
  return (
    (program === "npm" &&
      ((args.length === 1 && args[0] === "test") ||
        (args.length === 2 && args[0] === "run" && args[1] === "test"))) ||
    (program === "node" && args[0] === "--test")
  );
}

export function isSafetyTestCommand(argv: string[]): boolean {
  const [program, ...args] = argv;
  return (
    program === "npm" &&
    ((args.length === 1 && args[0] === "test") ||
      (args.length === 2 && args[0] === "run" && args[1] === "test"))
  );
}

export function validateCommandArgv(argv: string[]): void {
  const [program, ...args] = argv;
  if (!program) throw new Error("Command argv must not be empty");
  if (argv.some((part) => forbiddenTokens.has(part))) {
    throw new Error(`Shell operators are forbidden in command argv: ${argv.join(" ")}`);
  }
  if (program === "npm") {
    const allowed =
      isTestCommand(argv) ||
      (args.length === 2 && args[0] === "run" && ["test", "typecheck", "build"].includes(args[1] ?? ""));
    if (!allowed) throw new Error(`npm command is not approved: ${argv.join(" ")}`);
    return;
  }
  if (program === "node" && args[0] === "--test") return;
  throw new Error(`Executable is not approved for MVP verification: ${program}`);
}

export async function runCommand(
  argv: string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  validateCommandArgv(argv);
  const directProgram = argv[0];
  if (!directProgram) throw new Error("Command argv must not be empty");
  const startedAt = new Date();
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  let timedOut = false;
  const env = safeEnvironment(options.env);
  const sandboxed = options.sandboxed ?? false;
  const program = sandboxed ? "codex" : directProgram;
  const args = sandboxed
    ? [
        "sandbox",
        "-P",
        ":workspace",
        "--sandbox-state-disable-network",
        "-C",
        cwd,
        "--",
        ...argv,
      ]
    : argv.slice(1);

  const outputDir = await mkdtemp(join(tmpdir(), "safechange-command-"));
  const stdoutPath = join(outputDir, "stdout.log");
  const stderrPath = join(outputDir, "stderr.log");
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  let filesClosed = false;

  try {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
    });
    const timeoutMs = options.timeoutMs ?? 120_000;
    let result: { exitCode: number | null; signal: NodeJS.Signals | null };
    try {
      result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          let forceTimer: NodeJS.Timeout | undefined;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
          }, timeoutMs);
          child.on("error", (error) => {
            clearTimeout(timer);
            if (forceTimer) clearTimeout(forceTimer);
            reject(error);
          });
          child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            if (forceTimer) clearTimeout(forceTimer);
            resolve({ exitCode, signal });
          });
        },
      );
    } catch (error) {
      if (sandboxed) {
        throw new Error(
          `Sandbox execution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
    filesClosed = true;
    const stdout = (await readFile(stdoutPath, "utf8")).slice(-maxOutputBytes);
    const stderr = (await readFile(stderrPath, "utf8")).slice(-maxOutputBytes);
    const completedAt = new Date();
    return {
      argv,
      cwd,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      stdout,
      stderr,
      sandboxed,
    };
  } finally {
    if (!filesClosed) {
      await Promise.allSettled([stdoutFile.close(), stderrFile.close()]);
    }
    await rm(outputDir, { recursive: true, force: true });
  }
}
