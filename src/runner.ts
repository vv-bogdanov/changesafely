import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryCommandEnvironment } from "./environment.js";

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
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sandboxed: boolean;
}

export type CommandEvidence = Pick<
  CommandResult,
  | "exitCode"
  | "signal"
  | "timedOut"
  | "sandboxed"
  | "durationMs"
  | "stdoutTruncated"
  | "stderrTruncated"
> & { command: string };

export interface RunCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  sandboxed?: boolean;
  signal?: AbortSignal;
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
      (args.length === 2 &&
        args[0] === "run" &&
        ["test", "typecheck", "build"].includes(args[1] ?? ""));
    if (!allowed) throw new Error(`npm command is not approved: ${argv.join(" ")}`);
    return;
  }
  if (program === "node" && args[0] === "--test") return;
  throw new Error(`Executable is not approved for MVP verification: ${program}`);
}

function commandName(argv: string[]): string {
  if (argv[0] === "node") return "node --test";
  return argv.slice(0, 3).join(" ");
}

export function toCommandEvidence(results: CommandResult[]): CommandEvidence[] {
  return results.map((result) => ({
    command: commandName(result.argv),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    sandboxed: result.sandboxed,
    durationMs: result.durationMs,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }));
}

function boundedTail(maxBytes: number): {
  append(chunk: Buffer): void;
  value(): string;
  truncated(): boolean;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let totalBytes = 0;
  return {
    append(chunk) {
      totalBytes += chunk.length;
      chunks.push(chunk);
      bytes += chunk.length;
      while (bytes > maxBytes && chunks.length > 0) {
        const excess = bytes - maxBytes;
        const first = chunks[0];
        if (!first) break;
        if (first.length <= excess) {
          chunks.shift();
          bytes -= first.length;
        } else {
          chunks[0] = first.subarray(excess);
          bytes -= excess;
        }
      }
    },
    value: () => Buffer.concat(chunks, bytes).toString("utf8"),
    truncated: () => totalBytes > maxBytes,
  };
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
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
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  let timedOut = false;
  const sandboxed = options.sandboxed ?? false;
  const program = sandboxed ? "codex" : directProgram;
  const args = sandboxed
    ? ["sandbox", "-P", ":workspace", "--sandbox-state-disable-network", "-C", cwd, "--", ...argv]
    : argv.slice(1);

  const commandHome = await mkdtemp(join(tmpdir(), "safechange-command-"));
  const stdout = boundedTail(maxOutputBytes);
  const stderr = boundedTail(maxOutputBytes);

  try {
    const child = spawn(program, args, {
      cwd,
      env: repositoryCommandEnvironment(commandHome, options.env),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    const timeoutMs = options.timeoutMs ?? 120_000;
    let result: { exitCode: number | null; signal: NodeJS.Signals | null };
    try {
      result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          let forceTimer: NodeJS.Timeout | undefined;
          let terminating = false;
          const abort = () => {
            if (terminating) return;
            terminating = true;
            killProcessTree(child, "SIGTERM");
            forceTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
          };
          const timer = setTimeout(() => {
            timedOut = true;
            abort();
          }, timeoutMs);
          const onAbort = () => abort();
          options.signal?.addEventListener("abort", onAbort, { once: true });
          child.on("error", (error) => {
            clearTimeout(timer);
            if (forceTimer) clearTimeout(forceTimer);
            options.signal?.removeEventListener("abort", onAbort);
            reject(error);
          });
          child.on("close", (exitCode, signal) => {
            clearTimeout(timer);
            if (forceTimer) clearTimeout(forceTimer);
            options.signal?.removeEventListener("abort", onAbort);
            resolve({ exitCode, signal });
          });
          if (options.signal?.aborted) onAbort();
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
      stdout: stdout.value(),
      stderr: stderr.value(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
      sandboxed,
    };
  } finally {
    await rm(commandHome, { recursive: true, force: true });
  }
}
