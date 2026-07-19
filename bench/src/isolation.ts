import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { contentSha256 } from "./evidence.js";

const execFileAsync = promisify(execFile);

export interface IsolationProof {
  provider: "codex-permission-profile";
  providerVersion: string;
  permissionProfile: string;
  canarySha256: string;
  controllerPathHidden: boolean;
  authUnreadable: boolean;
  canaryPathHidden: boolean;
  agentToolNetworkDisabled: boolean;
}

export async function prepareCodexHome(
  sourceCodexHome: string,
  destination: string,
  permissionProfile: string,
  nodeRuntime = dirname(dirname(process.execPath)),
  additionalRuntimeRoots: readonly string[] = [],
): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(permissionProfile)) {
    throw new Error(`Invalid benchmark permission profile: ${permissionProfile}`);
  }
  const runtimeRoots = [
    ...new Set([nodeRuntime, ...additionalRuntimeRoots].map((root) => resolve(root))),
  ];
  if (runtimeRoots.some((root) => dirname(root) === root)) {
    throw new Error("Benchmark runtime root must not grant filesystem-wide access");
  }
  const runtimePaths = [...new Set([...runtimeRoots.map((root) => join(root, "bin")), "/usr/bin"])];
  await mkdir(destination, { mode: 0o700 });
  const authPath = join(destination, "auth.json");
  await copyFile(join(sourceCodexHome, "auth.json"), authPath);
  await chmod(authPath, 0o600);
  const config = `default_permissions = ${JSON.stringify(permissionProfile)}
approval_policy = "never"
cli_auth_credentials_store = "file"

[permissions.${permissionProfile}.filesystem]
":minimal" = "read"
${runtimeRoots.map((root) => `${JSON.stringify(root)} = "read"`).join("\n")}

[permissions.${permissionProfile}.filesystem.":workspace_roots"]
"." = "write"
"**/*.env" = "deny"

[permissions.${permissionProfile}.network]
enabled = false

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false
include_only = ["PATH", "HOME", "TMPDIR", "CI", "NO_COLOR"]
set = { PATH = ${JSON.stringify(runtimePaths.join(delimiter))}, HOME = "/tmp", TMPDIR = "/tmp", CI = "1", NO_COLOR = "1" }
`;
  await writeFile(join(destination, "config.toml"), config, { mode: 0o600, flag: "wx" });
}

export async function proveIsolation(
  codexCommand: string,
  codexHome: string,
  workspace: string,
  controllerFile: string,
  permissionProfile: string,
): Promise<IsolationProof> {
  if (process.platform !== "linux") {
    throw new Error("Live benchmark isolation is currently supported only on Linux");
  }
  const providerVersion = await commandVersion(codexCommand);
  const canaryRoot = await mkdtemp(join(tmpdir(), "changesafely-controller-canary-"));
  const canaryContent = randomBytes(32).toString("hex");
  const canaryPath = join(canaryRoot, `hidden-${randomBytes(8).toString("hex")}.txt`);
  await writeFile(canaryPath, canaryContent, { mode: 0o600, flag: "wx" });

  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Cannot create the worker network canary");
  }

  const script = `const fs = require("node:fs");
const net = require("node:net");
if (process.env.CODEX_HOME) process.exit(25);
for (let index = 1; index <= 3; index += 1) {
  try { fs.accessSync(process.argv[index], fs.constants.R_OK); process.exit(19 + index); } catch {}
}
const socket = net.connect(Number(process.argv[4]), "127.0.0.1");
socket.once("connect", () => process.exit(23));
socket.once("error", () => process.exit(0));
setTimeout(() => process.exit(24), 2000);
`;
  try {
    const sandboxArgs = ["sandbox", "-P", permissionProfile, "-C", resolve(workspace), "--"];
    const commandOptions = {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CHANGESAFELY_TELEMETRY: "0",
      },
    };
    await execFileAsync(
      codexCommand,
      [
        ...sandboxArgs,
        process.execPath,
        "-e",
        script,
        join(codexHome, "auth.json"),
        resolve(controllerFile),
        canaryPath,
        String(address.port),
      ],
      commandOptions,
    );
    await execFileAsync(codexCommand, [...sandboxArgs, "npm", "--version"], commandOptions);
    return {
      provider: "codex-permission-profile",
      providerVersion,
      permissionProfile,
      canarySha256: contentSha256(canaryContent),
      controllerPathHidden: true,
      authUnreadable: true,
      canaryPathHidden: true,
      agentToolNetworkDisabled: true,
    };
  } catch (error) {
    throw new Error(
      `Benchmark isolation canary failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    server.close();
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

async function commandVersion(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const value = stdout.trim();
    if (!value) throw new Error("empty version output");
    return value.slice(0, 500);
  } catch (error) {
    throw new Error(
      `Codex is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
