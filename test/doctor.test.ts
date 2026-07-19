import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorReport, runDoctor } from "../src/doctor.js";

const capabilities = {
  checks: [{ id: "config:test", kind: "test" as const, argv: ["make", "test"], cwd: "." }],
  testPathPrefixes: ["tests"],
  testFilePatterns: ["*_test.py"],
  controlFiles: ["changesafely.config.json"],
  sources: ["config:changesafely.config.json", "executable:make:/usr/bin/make"],
};

test("reports a ready local ChangeSafely environment", async () => {
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
    discoverCapabilities: async () => capabilities,
  });

  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 8);
  assert.equal(appServerClosed, true);
  assert.match(formatDoctorReport(report), /Ready: yes/);
  assert.match(formatDoctorReport(report), /generated baseline/);
  assert.match(formatDoctorReport(report), /Telemetry is disabled/);
  assert.match(formatDoctorReport(report), /config:test.*\["make","test"\]/u);
  assert.deepEqual(report.repositoryCapabilities, capabilities);
});

test("reports stable actions without exposing command output", async () => {
  let appServerStarted = false;
  const report = await runDoctor({
    repoPath: "/private/workspace",
    env: {
      CHANGESAFELY_TELEMETRY: "1",
      CHANGESAFELY_SENTRY_DSN: "https://public_key@o1.ingest.sentry.io/42",
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
    discoverCapabilities: async () => capabilities,
  });

  const output = formatDoctorReport(report);
  assert.equal(report.ok, false);
  assert.equal(appServerStarted, true);
  assert.match(output, /Ready: no/);
  assert.match(output, /Sentry error telemetry is enabled/);
  assert.doesNotMatch(output, /private|secret-name/);
});
