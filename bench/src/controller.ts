import type { BenchmarkOutcome } from "./contracts.js";

export interface WorkerCompletion {
  started: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputPresent: boolean;
  eventsValid: boolean;
}

export interface TechnicalFailure {
  outcome: Extract<BenchmarkOutcome, "technical_failure">;
  reason:
    | "events_invalid"
    | "missing_output"
    | "process_failed"
    | "process_not_started"
    | "process_signaled"
    | "timeout";
}

export function classifyTechnicalFailure(
  completion: WorkerCompletion,
): TechnicalFailure | undefined {
  if (!completion.started) return failure("process_not_started");
  if (completion.timedOut) return failure("timeout");
  if (completion.signal) return failure("process_signaled");
  if (completion.exitCode !== 0) return failure("process_failed");
  if (!completion.outputPresent) return failure("missing_output");
  if (!completion.eventsValid) return failure("events_invalid");
  return undefined;
}

function failure(reason: TechnicalFailure["reason"]): TechnicalFailure {
  return { outcome: "technical_failure", reason };
}
