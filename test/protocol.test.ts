import assert from "node:assert/strict";
import test from "node:test";
import { PreflightError } from "../src/git.js";
import { assertProtocolVersionValue } from "../src/protocol.js";

test("protocol gate accepts equality and rejects drift", () => {
  assert.doesNotThrow(() => assertProtocolVersionValue("codex-cli 1", "codex-cli 1"));
  assert.throws(
    () => assertProtocolVersionValue("codex-cli 2", "codex-cli 1"),
    (error: unknown) => error instanceof PreflightError && error.reasonCode === "PROTOCOL_MISMATCH",
  );
});
