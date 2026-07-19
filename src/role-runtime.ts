import type { RunTurnOptions } from "./app-server/client.js";
import { ChangeSafelyError } from "./errors.js";
import type { ContextEntry } from "./schemas.js";
import { contentEvidence, type TraceWriter } from "./trace.js";

export const readOnlyPolicy: RunTurnOptions["sandboxPolicy"] = {
  type: "readOnly",
  networkAccess: false,
};

export function workspaceWritePolicy(repoPath: string): RunTurnOptions["sandboxPolicy"] {
  return {
    type: "workspaceWrite",
    writableRoots: [repoPath],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export async function parseRoleArtifact<Value>(
  message: string,
  validate: (value: unknown) => Value,
  options: { role: string; trace?: TraceWriter },
): Promise<Value> {
  const evidence = contentEvidence(message);
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch (cause) {
    const error = new ChangeSafelyError(
      "ROLE_OUTPUT_INVALID_JSON",
      `Role ${options.role} returned invalid JSON (${evidence.payloadBytes} bytes, SHA-256 ${evidence.payloadSha256})`,
      {
        cause,
        nextAction: "Inspect the role trace metadata and retry after fixing the producer.",
      },
    );
    await options.trace?.recordFailure("role", "output.validated", error, {
      role: options.role,
      ...evidence,
    });
    throw error;
  }
  try {
    const result = validate(value);
    await options.trace?.append({
      component: "role",
      event: "output.validated",
      status: "completed",
      role: options.role,
      ...evidence,
    });
    return result;
  } catch (error) {
    await options.trace?.recordFailure("role", "output.validated", error, {
      role: options.role,
      ...evidence,
    });
    throw error;
  }
}

export function startContext(
  role: string,
  threadId: string,
  parentThreadId: string | null,
  checkpointTurnId: string | null,
): ContextEntry {
  return {
    role,
    threadId,
    parentThreadId,
    checkpointTurnId,
    turnId: null,
    status: "started",
  };
}

export function completeContext(context: ContextEntry, turnId: string): void {
  context.turnId = turnId;
  context.status = "completed";
}
