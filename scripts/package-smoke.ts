import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const timeout = 120_000;

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    timeout,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
  return stdout.trim();
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

  const demoRoot = join(temporaryRoot, "demo");
  await run(setupDemo, ["--target", demoRoot], temporaryRoot);
  await run("npm", ["test"], demoRoot);
  const status = await run("git", ["status", "--porcelain=v1"], demoRoot);
  if (status !== "") throw new Error(`Packaged demo is dirty after its baseline test: ${status}`);

  process.stdout.write(`Package smoke passed for safechange ${version}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
