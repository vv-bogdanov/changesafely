import { spawn } from "node:child_process";

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
}

export interface RunCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runCommand(
  argv: string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  if (argv.length === 0 || !argv[0]) throw new Error("Command argv must not be empty");
  const startedAt = new Date();
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const env = { ...process.env, ...options.env };
  delete env.NODE_TEST_CONTEXT;

  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-maxOutputBytes);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-maxOutputBytes);
  });

  const timeoutMs = options.timeoutMs ?? 120_000;
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal });
      });
    },
  );
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
  };
}
