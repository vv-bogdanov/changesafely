import assert from "node:assert/strict";
import test from "node:test";
import {
  captureFailure,
  createSentryEnvelopeRequest,
  telemetryConfigurationStatus,
  telemetryEnabled,
} from "../src/telemetry.js";

test("builds a minimal allowlisted Sentry envelope", () => {
  const request = createSentryEnvelopeRequest(
    "https://public_key@o1.ingest.sentry.io/42",
    "../../private task text",
    "private-command",
    new Date("2026-07-19T00:00:00.000Z"),
    "a".repeat(32),
  );
  const lines = request.body.trim().split("\n");
  const event = JSON.parse(lines[2] ?? "{}") as {
    message?: string;
    tags?: Record<string, string>;
  };

  assert.equal(request.endpoint, "https://o1.ingest.sentry.io/api/42/envelope/");
  assert.match(request.authorization, /sentry_key=public_key/);
  assert.equal(event.message, "ChangeSafely UNEXPECTED_ERROR");
  assert.equal(event.tags?.command, "unknown");
  assert.doesNotMatch(request.body, /private task|private-command|ingest\.sentry/);
});

test("keeps telemetry disabled unless both opt-ins are present", async () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ CHANGESAFELY_TELEMETRY: "1" }), false);
  assert.equal(
    telemetryConfigurationStatus({
      CHANGESAFELY_TELEMETRY: "1",
      CHANGESAFELY_SENTRY_DSN: "configured",
    }),
    "invalid",
  );

  let requests = 0;
  const sent = await captureFailure("APP_SERVER_INCOMPATIBLE", "plan", {
    env: {
      CHANGESAFELY_TELEMETRY: "1",
      CHANGESAFELY_SENTRY_DSN: "https://public_key@o1.ingest.sentry.io/42",
    },
    fetch: async () => {
      requests += 1;
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(sent, true);
  assert.equal(requests, 1);
});

test("telemetry transport failures never change CLI behavior", async () => {
  const sent = await captureFailure("UNEXPECTED_ERROR", "run", {
    env: {
      CHANGESAFELY_TELEMETRY: "1",
      CHANGESAFELY_SENTRY_DSN: "http://public_key@localhost/42",
    },
    fetch: async () => {
      throw new Error("must not execute");
    },
  });
  assert.equal(sent, false);
});
