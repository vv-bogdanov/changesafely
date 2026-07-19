import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorReport, runDoctor } from "../src/doctor.js";

test("reports a ready local SafeChange environment", async () => {
  let appServerClosed = false;
  const report = await runDoctor({
    repoPath: "/workspace",
    env: {},
    execute: async (command, args) => {
      if (command === "git" && args[0] === "--version") return "git version 2.50.0";
      if (command === "git" && args.includes("rev-parse")) return "/workspace";
      if (command === "git" && args.includes("status")) return "";
      if (command === "codex" && args[0] === "--version") return "codex-cli 99.0.0";
      if (command === "codex" && args[0] === "sandbox") return process.versions.node;
      throw new Error("unexpected doctor command");
    },
    appServerFactory: () => ({
      start: async () => ({}),
      close: async () => {
        appServerClosed = true;
      },
    }),
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 7);
  assert.equal(appServerClosed, true);
  assert.match(formatDoctorReport(report), /Ready: yes/);
  assert.match(formatDoctorReport(report), /generated baseline/);
  assert.match(formatDoctorReport(report), /Telemetry is disabled/);
});

test("reports stable actions without exposing command output", async () => {
  let appServerStarted = false;
  const report = await runDoctor({
    repoPath: "/private/workspace",
    env: {
      SAFECHANGE_TELEMETRY: "1",
      SAFECHANGE_SENTRY_DSN: "https://public_key@o1.ingest.sentry.io/42",
    },
    execute: async (command, args) => {
      if (command === "git" && args[0] === "--version") return "git version 2.50.0";
      if (command === "git" && args.includes("rev-parse")) return "/private/workspace";
      if (command === "git" && args.includes("status")) return " M secret-name.ts";
      if (command === "codex" && args[0] === "--version") return "codex-cli 0.0.0";
      throw new Error("not available");
    },
    appServerFactory: () => ({
      start: async () => {
        appServerStarted = true;
      },
      close: async () => undefined,
    }),
  });

  const output = formatDoctorReport(report);
  assert.equal(report.ok, false);
  assert.equal(appServerStarted, true);
  assert.match(output, /Ready: no/);
  assert.match(output, /Sentry error telemetry is enabled/);
  assert.doesNotMatch(output, /private|secret-name/);
});
