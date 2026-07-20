import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  isApprovalSensitivePath,
  isTestPath,
  normalizeRepositoryPath,
  normalizeRepositoryPathForRoot,
  pathWithinPrefixes,
} from "../src/repository-policy.js";

test("normalizes repository-relative paths and matches the repository root", () => {
  assert.equal(normalizeRepositoryPath("./src/value.ts"), "src/value.ts");
  assert.equal(normalizeRepositoryPath("./"), ".");
  assert.equal(pathWithinPrefixes("src/value.ts", ["./src/"]), true);
  assert.equal(pathWithinPrefixes("src/value.ts", ["."]), true);
  assert.equal(pathWithinPrefixes("outside.ts", ["src"]), false);
});

test("normalizes absolute paths only inside the repository root", () => {
  assert.equal(
    normalizeRepositoryPathForRoot("/tmp/repo/src/value.ts", "/tmp/repo"),
    "src/value.ts",
  );
  assert.equal(
    normalizeRepositoryPathForRoot("test/value.test.ts", "/tmp/repo"),
    "test/value.test.ts",
  );
  assert.throws(
    () => normalizeRepositoryPathForRoot("/tmp/other/src/value.ts", "/tmp/repo"),
    /outside repository root/u,
  );
});

test("rejects traversal, absolute, and Windows-style repository paths", () => {
  for (const path of ["../outside", "src/../outside", "/absolute", "C:\\outside", "src\\file"]) {
    assert.throws(() => normalizeRepositoryPath(path), /Invalid repository-relative path/);
    assert.equal(pathWithinPrefixes(path, ["."]), false);
    assert.equal(isTestPath(path), false);
  }
});

test("identifies test and approval-sensitive paths from one policy", () => {
  for (const path of ["test/value.ts", "src/value.test.ts", "fixtures/value.json"]) {
    assert.equal(isTestPath(path), true);
  }
  for (const path of [
    "AGENTS.md",
    "packages/api/package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "db/migrations/001.sql",
    "config/secrets/token.txt",
  ]) {
    assert.equal(isApprovalSensitivePath(path), true);
  }
  assert.equal(isApprovalSensitivePath("src/value.ts"), false);
});

test("never accepts a generated parent traversal path", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (suffix) => {
      assert.equal(pathWithinPrefixes(`../${suffix}`, ["."]), false);
    }),
    { numRuns: 500 },
  );
});
