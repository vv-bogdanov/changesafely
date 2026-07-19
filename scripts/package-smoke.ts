import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const timeout = 120_000;

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    timeout,
    env: { ...env, CI: "1", NO_COLOR: "1" },
  });
  return stdout.trim();
}

async function createFixtureRepository(path: string): Promise<void> {
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, ".gitignore"), ".safechange/\n", "utf8");
  await writeFile(join(path, "AGENTS.md"), "# Package smoke fixture\n", "utf8");
  await writeFile(
    join(path, "package.json"),
    `${JSON.stringify(
      {
        name: "safechange-package-smoke-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(path, "src", "value.ts"), "export const value = 1;\n", "utf8");
  await run("git", ["init", "-b", "main"], path);
  await run("git", ["config", "user.name", "SafeChange Package Smoke"], path);
  await run("git", ["config", "user.email", "package-smoke@safechange.local"], path);
  await run("git", ["add", "."], path);
  await run("git", ["commit", "-m", "fixture baseline"], path);
}

async function createFakeCodex(path: string, codexVersion: string, fixture: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const shim = join(path, "codex");
  await writeFile(
    shim,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(`${codexVersion}\n`)});
  process.exit(0);
}
if (args[0] === "app-server") {
  const result = spawnSync(process.execPath, [${JSON.stringify(fixture)}, "expect-workflow-spark"], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
if (args[0] === "sandbox") {
  const separator = args.indexOf("--");
  const cwdIndex = args.indexOf("-C");
  const command = args[separator + 1];
  if (separator < 0 || !command) process.exit(2);
  const result = spawnSync(command, args.slice(separator + 2), {
    cwd: cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
process.exit(2);
`,
    "utf8",
  );
  await chmod(shim, 0o755);
}

function runIdFrom(output: string): string {
  const runId = output.match(/^Run: (.+)$/m)?.[1];
  if (!runId) throw new Error(`Installed CLI did not print a run id: ${output}`);
  return runId;
}

const root = process.cwd();
const temporaryRoot = await mkdtemp(join(tmpdir(), "safechange-package-smoke-"));

try {
  const packOutput = await run(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    root,
  );
  const packResult = JSON.parse(packOutput) as Array<{ filename: string }>;
  const filename = packResult[0]?.filename;
  if (!filename) throw new Error("npm pack did not return a tarball filename");

  const installRoot = join(temporaryRoot, "install");
  await run(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporaryRoot, filename),
    ],
    temporaryRoot,
  );

  const binRoot = join(installRoot, "node_modules", ".bin");
  const extension = process.platform === "win32" ? ".cmd" : "";
  const safechange = join(binRoot, `safechange${extension}`);
  const setupDemo = join(binRoot, `safechange-demo${extension}`);
  await Promise.all([access(safechange), access(setupDemo)]);

  const version = await run(safechange, ["--version"], temporaryRoot);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  if (version !== packageJson.version) {
    throw new Error(
      `Installed CLI version ${version} does not match package ${packageJson.version}`,
    );
  }

  const protocol = JSON.parse(
    await readFile(join(root, "src", "app-server", "generated", "protocol-version.json"), "utf8"),
  ) as { codexVersion: string };
  const fakeBin = join(temporaryRoot, "fake-bin");
  await createFakeCodex(
    fakeBin,
    protocol.codexVersion,
    join(root, "dist", "test", "fixtures", "fake-app-server.js"),
  );
  const functionalRepo = join(temporaryRoot, "functional-repo");
  await createFixtureRepository(functionalRepo);
  const functionalEnvironment = {
    ...process.env,
    PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    SAFECHANGE_LIVE_TEST_MODEL: "gpt-5.3-codex-spark",
  };

  const planOutput = await run(
    safechange,
    ["plan", "--task", "Change the fixture value.", "--plans", "1", "--repo", functionalRepo],
    temporaryRoot,
    functionalEnvironment,
  );
  if (
    !planOutput.includes("Status: PLANNED") ||
    !planOutput.includes("Model: gpt-5.3-codex-spark")
  ) {
    throw new Error(`Installed CLI plan did not complete as expected: ${planOutput}`);
  }

  const runOutput = await run(
    safechange,
    ["run", "--task", "Change the fixture value.", "--plans", "1", "--repo", functionalRepo],
    temporaryRoot,
    functionalEnvironment,
  );
  const runId = runIdFrom(runOutput);
  if (!runOutput.includes("Status: VERIFIED")) {
    throw new Error(`Installed CLI run did not verify: ${runOutput}`);
  }
  const resumeOutput = await run(
    safechange,
    ["resume", "--run", runId, "--repo", functionalRepo],
    temporaryRoot,
    functionalEnvironment,
  );
  if (!resumeOutput.includes("Status: VERIFIED")) {
    throw new Error(`Installed CLI resume did not preserve verification: ${resumeOutput}`);
  }
  const commits = await run("git", ["rev-list", "--count", "HEAD"], functionalRepo);
  if (commits !== "3") throw new Error(`Expected B0, T1, and I1 commits, found ${commits}`);

  const demoRoot = join(temporaryRoot, "demo");
  await run(setupDemo, ["--target", demoRoot], temporaryRoot);
  await run("npm", ["test"], demoRoot);
  const status = await run("git", ["status", "--porcelain=v1"], demoRoot);
  if (status !== "") throw new Error(`Packaged demo is dirty after its baseline test: ${status}`);

  process.stdout.write(`Package smoke passed for safechange ${version}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
