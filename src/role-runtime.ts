import type { RunTurnOptions } from "./app-server/client.js";
import type { ContextEntry } from "./schemas.js";

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

export function parseRoleArtifact<Value>(
  message: string,
  validate: (value: unknown) => Value,
): Value {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error(`Role returned invalid JSON: ${message.slice(0, 300)}`);
  }
  return validate(value);
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
