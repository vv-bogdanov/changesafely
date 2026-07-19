import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { OutputCapture } from "../../src/output-capture.js";

export interface ProcessInvocation {
  program: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ProcessResult {
  started: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export async function runProcess(invocation: ProcessInvocation): Promise<ProcessResult> {
  const startedAt = new Date();
  const stdout = new OutputCapture(2 * 1024 * 1024);
  const stderr = new OutputCapture(256 * 1024);
  let started = false;
  let timedOut = false;
  let error: string | undefined;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;

  const child = spawn(invocation.program, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  await new Promise<void>((resolve) => {
    let forceTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child, "SIGTERM");
      forceTimer = setTimeout(() => terminate(child, "SIGKILL"), 2_000);
    }, invocation.timeoutMs);
    child.once("spawn", () => {
      started = true;
      if (invocation.stdin !== undefined) child.stdin?.end(invocation.stdin);
      else child.stdin?.end();
    });
    child.once("error", (processError) => {
      error = processError.message;
    });
    child.once("close", (code, processSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      exitCode = code;
      signal = processSignal;
      resolve();
    });
  });

  const completedAt = new Date();
  const stdoutResult = stdout.snapshot();
  const stderrResult = stderr.snapshot();
  return {
    started,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    exitCode,
    signal,
    timedOut,
    stdout: stdoutResult.tail,
    stderr: stderrResult.tail,
    stdoutBytes: stdoutResult.bytes,
    stderrBytes: stderrResult.bytes,
    stdoutSha256: stdoutResult.sha256,
    stderrSha256: stderrResult.sha256,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    ...(error ? { error } : {}),
  };
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
