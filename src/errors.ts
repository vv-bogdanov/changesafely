export type SafeChangeExitCode = 1 | 2;

export interface SafeChangeErrorOptions {
  nextAction: string;
  cause?: unknown;
  exitCode?: SafeChangeExitCode;
}

export class SafeChangeError extends Error {
  readonly exitCode: SafeChangeExitCode;
  readonly nextAction: string;

  constructor(
    public readonly code: string,
    message: string,
    options: SafeChangeErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SafeChangeError";
    this.exitCode = options.exitCode ?? 1;
    this.nextAction = options.nextAction;
  }
}

export function errorReasonCode(error: unknown): string {
  return error instanceof SafeChangeError ? error.code : "UNEXPECTED_ERROR";
}

export function errorNextAction(error: unknown): string {
  return error instanceof SafeChangeError
    ? error.nextAction
    : "Inspect the error and persisted run state, then retry after fixing the cause.";
}

export function errorExitCode(error: unknown): SafeChangeExitCode {
  return error instanceof SafeChangeError ? error.exitCode : 1;
}

export function abortReason(signal: AbortSignal | undefined, fallback: unknown): unknown {
  return signal?.aborted ? signal.reason : fallback;
}
