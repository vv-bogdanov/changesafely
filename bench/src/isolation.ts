import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { contentSha256 } from "./evidence.js";

const execFileAsync = promisify(execFile);

export interface IsolationProof {
  provider: "bubblewrap";
  providerVersion: string;
  canarySha256: string;
  controllerPathHidden: boolean;
  canaryPathHidden: boolean;
  canaryDiscoveryBlocked: boolean;
}

export interface CanaryCommand {
  program: "bwrap";
  args: string[];
}

export function buildCanaryCommand(
  workspace: string,
  canaryPath: string,
  controllerFile: string,
): CanaryCommand {
  const script = [
    'test ! -e "$1"',
    'test ! -r "$1"',
    'test ! -e "$2"',
    'test -z "$(find / -path /proc -prune -o -name "$3" -print -quit 2>/dev/null)"',
  ].join("\n");
  return {
    program: "bwrap",
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--unshare-cgroup-try",
      "--unshare-net",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/home",
      "--bind",
      resolve(workspace),
      "/workspace",
      "--chdir",
      "/workspace",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "PATH",
      "/usr/bin",
      "--",
      "/usr/bin/sh",
      "-eu",
      "-c",
      script,
      "isolation-canary",
      resolve(canaryPath),
      resolve(controllerFile),
      basename(canaryPath),
    ],
  };
}

export async function proveIsolation(
  controllerRoot: string,
  workspace: string,
): Promise<IsolationProof> {
  if (process.platform !== "linux") {
    throw new Error("Live benchmark isolation requires Linux and Bubblewrap");
  }
  const providerVersion = await bubblewrapVersion();
  const canaryRoot = await mkdtemp(join(tmpdir(), "changesafely-controller-canary-"));
  const canaryContent = randomBytes(32).toString("hex");
  const canaryPath = join(canaryRoot, `hidden-${randomBytes(8).toString("hex")}.txt`);
  const controllerFile = resolve(controllerRoot, "bench", "BENCHMARK_SPEC.md");
  await writeFile(canaryPath, canaryContent, { mode: 0o600, flag: "wx" });

  try {
    const command = buildCanaryCommand(workspace, canaryPath, controllerFile);
    await execFileAsync(command.program, command.args, {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH },
    });
    return {
      provider: "bubblewrap",
      providerVersion,
      canarySha256: contentSha256(canaryContent),
      controllerPathHidden: true,
      canaryPathHidden: true,
      canaryDiscoveryBlocked: true,
    };
  } catch (error) {
    throw new Error(
      `Benchmark isolation canary failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

async function bubblewrapVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("bwrap", ["--version"], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const version = stdout.trim();
    if (!version) throw new Error("empty version output");
    return version;
  } catch (error) {
    throw new Error(
      `Bubblewrap is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
