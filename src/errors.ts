export type ChangeSafelyExitCode = 1 | 2;

export interface ChangeSafelyErrorOptions {
  nextAction: string;
  cause?: unknown;
  exitCode?: ChangeSafelyExitCode;
}

export class ChangeSafelyError extends Error {
  readonly exitCode: ChangeSafelyExitCode;
  readonly nextAction: string;

  constructor(
    public readonly code: string,
    message: string,
    options: ChangeSafelyErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChangeSafelyError";
    this.exitCode = options.exitCode ?? 1;
    this.nextAction = options.nextAction;
  }
}

export function errorReasonCode(error: unknown): string {
  return error instanceof ChangeSafelyError ? error.code : "UNEXPECTED_ERROR";
}

export function errorNextAction(error: unknown): string {
  return error instanceof ChangeSafelyError
    ? error.nextAction
    : "Inspect the error and persisted run state, then retry after fixing the cause.";
}

export function errorExitCode(error: unknown): ChangeSafelyExitCode {
  return error instanceof ChangeSafelyError ? error.exitCode : 1;
}

export function abortReason(signal: AbortSignal | undefined, fallback: unknown): unknown {
  return signal?.aborted ? signal.reason : fallback;
}
