import { execFile } from "node:child_process";
import { promisify } from "node:util";
import protocolVersion from "./app-server/generated/protocol-version.json" with { type: "json" };
import { safeEnvironment } from "./environment.js";
import { PreflightError } from "./git.js";

const execFileAsync = promisify(execFile);

async function currentCodexVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("codex", ["--version"], {
      timeout: 10_000,
      env: safeEnvironment(),
    });
    return stdout.trim();
  } catch (error) {
    throw new PreflightError(
      "CODEX_UNAVAILABLE",
      `Standard codex executable is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assertProtocolVersion(): Promise<void> {
  const actual = await currentCodexVersion();
  assertProtocolVersionValue(actual);
}

export function assertProtocolVersionValue(
  actual: string,
  expected = protocolVersion.codexVersion,
): void {
  if (actual !== expected) {
    throw new PreflightError(
      "PROTOCOL_MISMATCH",
      `Generated App Server protocol expects ${expected}, found ${actual}. Run npm run protocol:generate with the intended standard Codex version.`,
    );
  }
}
