import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { AppServerClient } from "../src/app-server/client.js";
import { smokeArtifactSchema, validateSmokeArtifact } from "../src/schemas.js";

const fixture = join(process.cwd(), "dist", "test", "fixtures", "fake-app-server.js");

test("completes the App Server handshake and one structured turn", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fixture, "expect-spark"],
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  });

  try {
    const initialized = await client.start();
    assert.equal(initialized.userAgent, "fake-app-server");

    const thread = await client.startThread({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    assert.equal(thread.thread.id, "thread-1");

    const result = await client.runTurn("thread-1", "Return the smoke artifact.", {
      cwd: process.cwd(),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: "gpt-5.3-codex-spark",
      effort: "low",
      outputSchema: smokeArtifactSchema,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(validateSmokeArtifact(JSON.parse(result.message)), {
      kind: "smoke",
      message: "ok",
    });
  } finally {
    await client.close();
  }
});

test("rejects unsupported App Server requests and continues the turn", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fixture, "server-request"],
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  });

  try {
    await client.start();
    const thread = await client.startThread({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const result = await client.runTurn(thread.thread.id, "Return the smoke artifact.", {
      cwd: process.cwd(),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: smokeArtifactSchema,
    });
    assert.deepEqual(validateSmokeArtifact(JSON.parse(result.message)), {
      kind: "smoke",
      message: "ok",
    });
  } finally {
    await client.close();
  }
});

test("fails closed on a malformed App Server notification", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fixture, "malformed-notification"],
    requestTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  });

  try {
    await client.start();
    const thread = await client.startThread({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    await assert.rejects(
      client.runTurn(thread.thread.id, "Return the smoke artifact.", {
        cwd: process.cwd(),
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: smokeArtifactSchema,
      }),
      /Invalid item\/completed notification/,
    );
  } finally {
    await client.close();
  }
});
