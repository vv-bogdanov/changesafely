import assert from "node:assert/strict";
import test from "node:test";
import { diffRemovesExistingLines } from "../src/harness.js";

test("detects removal or rewriting of existing harness lines", () => {
  assert.equal(
    diffRemovesExistingLines("--- a/test/value.test.ts\n+++ b/test/value.test.ts\n+added"),
    false,
  );
  assert.equal(
    diffRemovesExistingLines("--- a/test/value.test.ts\n+++ b/test/value.test.ts\n-old\n+new"),
    true,
  );
});
