import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AppServerClient } from "../src/app-server/client.js";
import { smokeArtifactSchema, validateSmokeArtifact } from "../src/schemas.js";
import { loadTrace, TraceWriter } from "../src/trace.js";
import { fakeAppServerFactory, withFakeClient } from "./support/app-server.js";

async function startReadOnlyThread(client: AppServerClient) {
  await client.start();
  return client.startThread({
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
  });
}

async function withTracedFakeClient(
  t: TestContext,
  mode: string,
  action: (client: AppServerClient, trace: TraceWriter) => Promise<void>,
): Promise<void> {
  const repoPath = await mkdtemp(join(tmpdir(), "changesafely-app-server-trace-"));
  t.after(async () => rm(repoPath, { recursive: true, force: true }));
  const trace = new TraceWriter(repoPath, "app-server-run");
  const client = fakeAppServerFactory(repoPath, mode)();
  client.setTrace(trace);
  try {
    await action(client, trace);
  } finally {
    await client.close();
  }
}

test("completes the App Server handshake and one structured turn", async () => {
  await withFakeClient("expect-spark", async (client) => {
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
  });
});

test("rejects unsupported App Server requests and continues the turn", async () => {
  await withFakeClient("server-request", async (client) => {
    const thread = await startReadOnlyThread(client);
    const result = await client.runTurn(thread.thread.id, "Return the smoke artifact.", {
      cwd: process.cwd(),
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: smokeArtifactSchema,
    });
    assert.deepEqual(validateSmokeArtifact(JSON.parse(result.message)), {
      kind: "smoke",
      message: "ok",
    });
  });
});

test("fails closed on a malformed App Server notification without persisting its body", async (t) => {
  await withTracedFakeClient(t, "malformed-notification", async (client, trace) => {
    const thread = await startReadOnlyThread(client);
    await assert.rejects(
      client.runTurn(thread.thread.id, "Return the smoke artifact.", {
        cwd: process.cwd(),
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: smokeArtifactSchema,
      }),
      /Invalid item\/completed notification/,
    );
    const document = await loadTrace(trace.repoPath, trace.runId);
    const failure = document.events.find((event) => event.event === "protocol.message");
    assert.equal(failure?.status, "failed");
    assert.ok(failure?.payloadBytes);
    assert.match(failure?.payloadSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.doesNotMatch(await readFile(document.tracePath, "utf8"), /"params"/);
  });
});

test("fails closed on a malformed App Server error response", async () => {
  await withFakeClient("malformed-error", async (client) => {
    await assert.rejects(client.start(), /Invalid error response from App Server/);
  });
});

test("bounds App Server requests with a concrete timeout trace", async (t) => {
  await withTracedFakeClient(t, "request-timeout", async (client, trace) => {
    await assert.rejects(client.start(), /App Server request initialize timed out/);
    const document = await loadTrace(trace.repoPath, trace.runId);
    assert.ok(
      document.events.some(
        (event) =>
          event.event === "rpc.request" &&
          event.method === "initialize" &&
          event.reasonCode === "APP_SERVER_REQUEST_TIMEOUT",
      ),
    );
  });
});
