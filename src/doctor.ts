import spawn from "cross-spawn";
import { AppServerClient } from "./app-server/client.js";
import protocolVersion from "./app-server/generated/protocol-version.json" with { type: "json" };
import { safeEnvironment } from "./environment.js";
import { telemetryConfigurationStatus } from "./telemetry.js";

interface DoctorCheck {
  name: string;
  status: "pass" | "fail";
  detail: string;
  action: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

interface AppServerProbe {
  start(): Promise<unknown>;
  close(): Promise<void>;
}

type DoctorExecute = (command: string, args: string[], cwd?: string) => Promise<string>;

export interface DoctorOptions {
  repoPath: string;
  env?: NodeJS.ProcessEnv;
  execute?: DoctorExecute;
  appServerFactory?: () => AppServerProbe;
}

async function defaultExecute(command: string, args: string[], cwd?: string): Promise<string> {
  const result = spawn.sync(command, args, {
    ...(cwd ? { cwd } : {}),
    env: safeEnvironment(),
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `${command} exited with ${String(result.status)}`));
  }
  return String(result.stdout).trim();
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const execute = options.execute ?? defaultExecute;
  const add = (name: string, status: "pass" | "fail", detail: string, action = "") => {
    checks.push({ name, status, detail, action });
  };
  const attempt = async (
    name: string,
    action: () => Promise<string>,
    failureDetail: string,
    nextAction: string,
  ): Promise<boolean> => {
    try {
      add(name, "pass", await action());
      return true;
    } catch {
      add(name, "fail", failureDetail, nextAction);
      return false;
    }
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (Number.isInteger(nodeMajor) && nodeMajor >= 22) {
    add("node", "pass", `Node.js ${process.versions.node}`);
  } else {
    add("node", "fail", "Node.js 22 or newer is required", "Install an active Node.js LTS.");
  }

  await attempt(
    "git",
    async () => {
      const version = await execute("git", ["--version"]);
      if (!version.startsWith("git version ")) throw new Error("invalid git version output");
      return version.slice(0, 80);
    },
    "Git is unavailable",
    "Install Git and make it available on PATH.",
  );

  const repositoryReady = await attempt(
    "repository",
    async () => {
      await execute("git", ["-C", options.repoPath, "rev-parse", "--show-toplevel"]);
      const status = await execute("git", [
        "-C",
        options.repoPath,
        "status",
        "--porcelain=v1",
        "--untracked-files=no",
      ]);
      if (status) throw new Error("dirty tracked state");
      return "Git repository has a clean tracked state";
    },
    "Repository is unavailable or has tracked changes",
    "Use a Git repository and commit tracked or staged changes before ChangeSafely.",
  );

  const codexReady = await attempt(
    "codex",
    async () => {
      const version = await execute("codex", ["--version"]);
      if (!version) throw new Error("empty Codex version output");
      return version === protocolVersion.codexVersion
        ? `${version} (generated protocol baseline)`
        : `${version} (generated baseline: ${protocolVersion.codexVersion})`;
    },
    "Codex is unavailable",
    "Install Codex and make the authenticated executable available on PATH.",
  );

  if (codexReady) {
    await attempt(
      "app-server",
      async () => {
        const client =
          options.appServerFactory?.() ??
          new AppServerClient({ cwd: options.repoPath, requestTimeoutMs: 10_000 });
        try {
          await client.start();
        } finally {
          await client.close();
        }
        return "App Server stdio handshake completed";
      },
      "App Server stdio handshake failed",
      "Check Codex authentication and local App Server availability.",
    );
  } else {
    add("app-server", "fail", "App Server check requires Codex", "Resolve the Codex check first.");
  }

  if (codexReady && repositoryReady) {
    await attempt(
      "sandbox",
      async () => {
        await execute(
          "codex",
          [
            "sandbox",
            "-P",
            ":workspace",
            "--sandbox-state-disable-network",
            "-C",
            options.repoPath,
            "--",
            process.execPath,
            "--version",
          ],
          options.repoPath,
        );
        return "Network-disabled sandbox smoke completed";
      },
      "Network-disabled sandbox smoke failed",
      "Check host sandbox support before running repository commands.",
    );
  } else {
    add(
      "sandbox",
      "fail",
      "Sandbox check requires Codex and repository checks",
      "Resolve the Codex and repository checks first.",
    );
  }

  const telemetry = telemetryConfigurationStatus(options.env);
  if (telemetry === "invalid") {
    add(
      "telemetry",
      "fail",
      "Sentry telemetry configuration is invalid",
      "Use an HTTPS Sentry DSN or disable telemetry.",
    );
  } else {
    add(
      "telemetry",
      "pass",
      telemetry === "enabled" ? "Sentry error telemetry is enabled" : "Telemetry is disabled",
    );
  }
  return { ok: checks.every((check) => check.status === "pass"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["ChangeSafely doctor", ""];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
    if (check.action) lines.push(`  Action: ${check.action}`);
  }
  lines.push("", `Ready: ${report.ok ? "yes" : "no"}`, "");
  return lines.join("\n");
}
