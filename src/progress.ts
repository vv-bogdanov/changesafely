import type { RunPhase } from "./schemas.js";

export interface ProgressEvent {
  runId: string;
  phase: RunPhase;
  action: string;
  elapsedMs: number;
}

export type ProgressReporter = (event: ProgressEvent) => void;

export function reportProgress(
  reporter: ProgressReporter | undefined,
  runId: string,
  phase: RunPhase,
  action: string,
  startedAt: number,
): void {
  reporter?.({ runId, phase, action, elapsedMs: Date.now() - startedAt });
}

export function formatProgress(event: ProgressEvent): string {
  return `[changesafely] ${event.runId} ${event.phase}: ${event.action} (${(event.elapsedMs / 1000).toFixed(1)}s)\n`;
}
