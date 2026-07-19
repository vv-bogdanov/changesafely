import { randomUUID } from "node:crypto";
import { VERSION } from "./version.js";

const TELEMETRY_FLAG = "CHANGESAFELY_TELEMETRY";
const SENTRY_DSN = "CHANGESAFELY_SENTRY_DSN";

export interface TelemetryOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}

export interface SentryEnvelopeRequest {
  endpoint: string;
  authorization: string;
  body: string;
}

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TELEMETRY_FLAG] === "1" && Boolean(env[SENTRY_DSN]?.trim());
}

function safeReasonCode(value: string): string {
  return /^[A-Z0-9_]{1,80}$/.test(value) ? value : "UNEXPECTED_ERROR";
}

function safeCommand(value: string): string {
  return ["plan", "run", "resume", "status", "doctor"].includes(value) ? value : "unknown";
}

export function createSentryEnvelopeRequest(
  dsnValue: string,
  reasonCode: string,
  command: string,
  now = new Date(),
  eventId = randomUUID().replaceAll("-", ""),
): SentryEnvelopeRequest {
  const dsn = new URL(dsnValue);
  const segments = dsn.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (
    dsn.protocol !== "https:" ||
    !dsn.username ||
    dsn.password ||
    !projectId ||
    !/^[A-Za-z0-9_-]+$/.test(dsn.username) ||
    !/^[A-Za-z0-9_-]+$/.test(projectId)
  ) {
    throw new Error("Invalid ChangeSafely Sentry DSN");
  }

  const basePath = segments.length > 0 ? `/${segments.join("/")}` : "";
  const endpoint = `${dsn.origin}${basePath}/api/${projectId}/envelope/`;
  const sentAt = now.toISOString();
  const envelopeHeader = {
    event_id: eventId,
    sent_at: sentAt,
    sdk: { name: "changesafely", version: VERSION },
  };
  const event = {
    event_id: eventId,
    timestamp: sentAt,
    platform: "node",
    level: "error",
    logger: "changesafely",
    release: `changesafely@${VERSION}`,
    message: `ChangeSafely ${safeReasonCode(reasonCode)}`,
    tags: {
      reason_code: safeReasonCode(reasonCode),
      command: safeCommand(command),
      changesafely_version: VERSION,
    },
  };
  return {
    endpoint,
    authorization: `Sentry sentry_version=7, sentry_client=changesafely/${VERSION}, sentry_key=${dsn.username}`,
    body: `${JSON.stringify(envelopeHeader)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`,
  };
}

export function telemetryConfigurationStatus(
  env: NodeJS.ProcessEnv = process.env,
): "disabled" | "enabled" | "invalid" {
  if (!telemetryEnabled(env)) return "disabled";
  try {
    createSentryEnvelopeRequest(
      env[SENTRY_DSN] ?? "",
      "DOCTOR_CHECK",
      "doctor",
      new Date(0),
      "0".repeat(32),
    );
    return "enabled";
  } catch {
    return "invalid";
  }
}

export async function captureFailure(
  reasonCode: string,
  command: string,
  options: TelemetryOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (telemetryConfigurationStatus(env) !== "enabled") return false;

  try {
    const request = createSentryEnvelopeRequest(env[SENTRY_DSN] ?? "", reasonCode, command);
    const response = await (options.fetch ?? globalThis.fetch)(request.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": request.authorization,
      },
      body: request.body,
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
