import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUsableCapabilities,
  authorizeRepositoryCheck,
  capabilitiesSha256,
  discoverRepositoryCapabilities,
  isCapabilityTestPath,
  REPOSITORY_CONFIG_PATH,
  requireRepositoryCheck,
} from "../src/repository-capabilities.js";
import { createTestRepo } from "./support/repository.js";

test("discovers deterministic npm checks in root and nested packages", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: {
      "package.json": `${JSON.stringify({ scripts: { test: "node --test", lint: "biome check .", deploy: "no" } })}\n`,
      "package-lock.json": "{}\n",
      "packages/api/package.json": `${JSON.stringify({ scripts: { "test:unit": "node --test", typecheck: "tsc" } })}\n`,
      "packages/api/test/value.test.js": "// test\n",
    },
  });

  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.deepEqual(
    capabilities.checks.map(({ id, kind, argv, cwd }) => ({ id, kind, argv, cwd })),
    [
      {
        id: "npm:.:lint",
        kind: "lint",
        argv: ["npm", "run", "lint"],
        cwd: ".",
      },
      { id: "npm:.:test", kind: "test", argv: ["npm", "test"], cwd: "." },
      {
        id: "npm:packages/api:test:unit",
        kind: "test",
        argv: ["npm", "run", "test:unit"],
        cwd: "packages/api",
      },
      {
        id: "npm:packages/api:typecheck",
        kind: "typecheck",
        argv: ["npm", "run", "typecheck"],
        cwd: "packages/api",
      },
    ],
  );
  assert.deepEqual(
    capabilities.sources.filter((source) => source.startsWith("npm:")),
    ["npm:package.json", "npm:packages/api/package.json"],
  );
  assert.ok(capabilities.sources.some((source) => source.startsWith("executable:npm:/")));
  assert.equal(isCapabilityTestPath(capabilities, "packages/api/test/value.test.js"), true);
  assert.equal(isCapabilityTestPath(capabilities, "src/value.ts"), false);
  assert.doesNotThrow(() => assertUsableCapabilities(capabilities));
});

test("capability authorization is exact and content addressed", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: { "package.json": `${JSON.stringify({ scripts: { test: "node --test" } })}\n` },
  });
  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.ok(authorizeRepositoryCheck(capabilities, ["npm", "test"], ".", "test"));
  assert.equal(
    authorizeRepositoryCheck(capabilities, ["npm", "test", "--", "value"], ".", "test"),
    undefined,
  );
  assert.throws(
    () => requireRepositoryCheck(capabilities, ["npm", "run", "deploy"]),
    /not in the baseline repository capability catalog/u,
  );
  assert.match(capabilitiesSha256(capabilities), /^[a-f0-9]{64}$/u);
  assert.equal(capabilitiesSha256(capabilities), capabilitiesSha256(capabilities));
});

test("unsupported repositories fail closed without a detected test check", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: { "package.json": `${JSON.stringify({ scripts: { build: "tsc" } })}\n` },
  });
  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.throws(() => assertUsableCapabilities(capabilities), /No deterministic repository test/u);
});

test("discovers a prepared pytest repository without executing project code", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: {
      "pyproject.toml": '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      "requirements-test.txt": "pytest==9.1.1\n",
      "src/value.py": "def value():\n    return 1\n",
      "tests/test_value.py": "def test_value():\n    assert True\n",
    },
  });
  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.deepEqual(capabilities.checks, [
    {
      id: "python:.:pytest",
      kind: "test",
      argv: ["python", "-m", "pytest"],
      cwd: ".",
    },
  ]);
  assert.ok(capabilities.sources.some((source) => source.startsWith("runtime:pytest:pytest ")));
  assert.deepEqual(capabilities.controlFiles, ["pyproject.toml", "requirements-test.txt"]);
  assert.equal(isCapabilityTestPath(capabilities, "tests/test_new_behavior.py"), true);
});

test("authorizes a non-built-in tool through the tracked repository config", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: {
      [REPOSITORY_CONFIG_PATH]: `${JSON.stringify({
        version: 1,
        checks: [{ id: "make:test", kind: "test", argv: ["make", "test"], cwd: "." }],
        testPathPrefixes: ["checks"],
        testFilePatterns: ["*_check.js"],
        controlFiles: ["Makefile"],
      })}\n`,
      Makefile: "test:\n\t@true\n",
      "checks/value_check.js": "// acceptance test\n",
    },
  });

  const capabilities = await discoverRepositoryCapabilities(repoPath);
  assert.deepEqual(capabilities.checks, [
    { id: "make:test", kind: "test", argv: ["make", "test"], cwd: "." },
  ]);
  assert.deepEqual(capabilities.controlFiles, ["Makefile", REPOSITORY_CONFIG_PATH]);
  assert.ok(capabilities.sources.includes(`config:${REPOSITORY_CONFIG_PATH}`));
  assert.ok(capabilities.sources.some((source) => source.startsWith("executable:make:")));
  assert.equal(isCapabilityTestPath(capabilities, "checks/new_check.js"), true);
});

test("rejects unsafe or ambiguous repository config checks", async (t) => {
  const unsafeRepo = await createTestRepo(t, {
    prefix: "changesafely-unsafe-config-",
    files: {
      [REPOSITORY_CONFIG_PATH]: `${JSON.stringify({
        version: 1,
        checks: [{ id: "unsafe", kind: "test", argv: ["sh", "-c", "true"], cwd: "." }],
        testPathPrefixes: ["tests"],
        testFilePatterns: [],
        controlFiles: [],
      })}\n`,
    },
  });
  await assert.rejects(
    discoverRepositoryCapabilities(unsafeRepo),
    /Invalid changesafely\.config\.json.*not approved/u,
  );

  const ambiguousRepo = await createTestRepo(t, {
    prefix: "changesafely-ambiguous-config-",
    files: {
      [REPOSITORY_CONFIG_PATH]: `${JSON.stringify({
        version: 1,
        checks: [{ id: "configured-test", kind: "test", argv: ["npm", "test"], cwd: "." }],
        testPathPrefixes: ["test"],
        testFilePatterns: ["*.test.js"],
        controlFiles: [],
      })}\n`,
      "package.json": `${JSON.stringify({ scripts: { test: "node --test" } })}\n`,
      "test/value.test.js": "// test\n",
    },
  });
  await assert.rejects(
    discoverRepositoryCapabilities(ambiguousRepo),
    /declare the same command and cwd/u,
  );
});

test("rejects malformed config paths and untracked controls", async (t) => {
  const repoPath = await createTestRepo(t, {
    files: {
      [REPOSITORY_CONFIG_PATH]: `${JSON.stringify({
        version: 1,
        checks: [{ id: "make:test", kind: "test", argv: ["make", "test"], cwd: "." }],
        testPathPrefixes: ["../outside"],
        testFilePatterns: [],
        controlFiles: ["missing.mk"],
      })}\n`,
    },
  });
  await assert.rejects(discoverRepositoryCapabilities(repoPath), /Invalid test prefix path/u);
});
