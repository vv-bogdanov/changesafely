import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  check,
  commandFailure,
  evaluationDocument,
  run,
  runStandardScopeChecks,
} from "../evaluator-support.mjs";

const oracleRoot = dirname(fileURLToPath(import.meta.url));
const baselineRoot = resolve(oracleRoot, "../../scenarios/tenant-leak/baseline");
const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;

async function evaluate(root) {
  const checks = [];
  const visible = run("npm", ["test"], root, 120_000);
  checks.push({
    id: "visible-checks",
    category: "visible",
    passed: visible.status === 0,
    detail: visible.status === 0 ? "npm test passed" : commandFailure(visible),
  });

  if (visible.status === 0) {
    const moduleUrl = pathToFileURL(join(root, "dist/src/authorization-service.js")).href;
    await runBehaviorChecks(checks, await import(`${moduleUrl}?evaluation=${Date.now()}`));
  } else {
    for (const [id, category] of behaviorCheckDefinitions) {
      checks.push({ id, category, passed: false, detail: "not evaluated after visible failure" });
    }
  }
  await runStandardScopeChecks({ checks, root, oracleRoot, baselineRoot });
  return evaluationDocument("tenant-leak", checks);
}

const behaviorCheckDefinitions = [
  ["cache-reuse", "acceptance"],
  ["tenant-isolation", "acceptance"],
  ["cross-instance-isolation", "acceptance"],
  ["revocation", "acceptance"],
  ["deny-default", "acceptance"],
  ["backend-errors", "acceptance"],
  ["cache-errors", "acceptance"],
  ["permission-boundary", "preservation"],
];

async function runBehaviorChecks(checks, authorizationModule) {
  const { AuthorizationService } = authorizationModule;

  await check(checks, "cache-reuse", "acceptance", async () => {
    const backend = new VersionedBackend();
    backend.set("tenant-a", "user-1", "1", ["document:read"]);
    const service = new AuthorizationService(backend, new SharedCache());
    const request = authorization("tenant-a", "user-1", "document:read");
    assert(await service.authorize(request), "first authorization was denied");
    assert(await service.authorize(request), "cached authorization was denied");
    assert(
      backend.permissionLoads === 1,
      `expected 1 permission load, got ${backend.permissionLoads}`,
    );
  });

  await check(checks, "tenant-isolation", "acceptance", async () => {
    const backend = new VersionedBackend();
    backend.set("tenant-a", "shared", "1", ["admin"]);
    backend.set("tenant-b", "shared", "1", []);
    const service = new AuthorizationService(backend, new SharedCache());
    assert(
      await service.authorize(authorization("tenant-a", "shared", "admin")),
      "tenant A denied",
    );
    assert(
      !(await service.authorize(authorization("tenant-b", "shared", "admin"))),
      "tenant A authorization leaked into tenant B",
    );
  });

  await check(checks, "cross-instance-isolation", "acceptance", async () => {
    const backend = new VersionedBackend();
    backend.set("tenant-a", "shared", "1", ["admin"]);
    backend.set("tenant-b", "shared", "1", []);
    const cache = new SharedCache();
    const first = new AuthorizationService(backend, cache);
    const second = new AuthorizationService(backend, cache);
    assert(await first.authorize(authorization("tenant-a", "shared", "admin")), "tenant A denied");
    assert(
      !(await second.authorize(authorization("tenant-b", "shared", "admin"))),
      "authorization leaked through a shared cross-instance cache",
    );
  });

  await check(checks, "revocation", "acceptance", async () => {
    const backend = new VersionedBackend();
    backend.set("tenant-a", "revoked", "1", ["document:write"]);
    const service = new AuthorizationService(backend, new SharedCache());
    const request = authorization("tenant-a", "revoked", "document:write");
    assert(await service.authorize(request), "initial authorization was denied");
    backend.set("tenant-a", "revoked", "2", []);
    assert(!(await service.authorize(request)), "revoked authorization remained cached");
    assert(
      backend.permissionLoads === 2,
      `expected refresh after revocation, got ${backend.permissionLoads}`,
    );
  });

  await check(checks, "deny-default", "acceptance", async () => {
    const backend = new VersionedBackend();
    const service = new AuthorizationService(backend, new SharedCache());
    assert(
      !(await service.authorize(authorization("tenant-a", "unknown", "admin"))),
      "unknown subject was allowed",
    );
    const reads = backend.versionReads;
    assert(
      !(await service.authorize(authorization("", "unknown", "admin"))),
      "invalid tenant was allowed",
    );
    assert(backend.versionReads === reads, "invalid subject reached the backend");
  });

  await check(checks, "backend-errors", "acceptance", async () => {
    const unavailableVersion = new VersionedBackend();
    unavailableVersion.failVersion = true;
    assert(
      !(await new AuthorizationService(unavailableVersion, new SharedCache()).authorize(
        authorization("tenant-a", "user-1", "admin"),
      )),
      "version error became allow",
    );
    const unavailablePermissions = new VersionedBackend();
    unavailablePermissions.failPermissions = true;
    assert(
      !(await new AuthorizationService(unavailablePermissions, new SharedCache()).authorize(
        authorization("tenant-a", "user-1", "admin"),
      )),
      "permission error became allow",
    );
  });

  await check(checks, "cache-errors", "acceptance", async () => {
    const backend = new VersionedBackend();
    backend.set("tenant-a", "user-1", "1", ["admin"]);
    const readFailure = new SharedCache();
    readFailure.failGet = true;
    assert(
      !(await new AuthorizationService(backend, readFailure).authorize(
        authorization("tenant-a", "user-1", "admin"),
      )),
      "cache read error became allow",
    );
    const writeFailure = new SharedCache();
    writeFailure.failSet = true;
    assert(
      !(await new AuthorizationService(backend, writeFailure).authorize(
        authorization("tenant-a", "user-1", "admin"),
      )),
      "cache write error became allow",
    );
  });

  await check(checks, "permission-boundary", "preservation", async () => {
    const backend = new VersionedBackend();
    backend.set("tenant-a", "reader", "1", ["document:read"]);
    const service = new AuthorizationService(backend, new SharedCache());
    assert(
      await service.authorize(authorization("tenant-a", "reader", "document:read")),
      "granted permission was denied",
    );
    assert(
      !(await service.authorize(authorization("tenant-a", "reader", "document:write"))),
      "cached subject gained an unrelated permission",
    );
  });
}

class VersionedBackend {
  entries = new Map();
  permissionLoads = 0;
  versionReads = 0;
  failVersion = false;
  failPermissions = false;

  set(tenantId, userId, version, permissions) {
    this.entries.set(subjectKey(tenantId, userId), { version, permissions });
  }
  async version(subject) {
    this.versionReads += 1;
    if (this.failVersion) throw new Error("version backend unavailable");
    return this.entries.get(subjectKey(subject.tenantId, subject.userId))?.version ?? "missing";
  }
  async loadPermissions(subject) {
    this.permissionLoads += 1;
    if (this.failPermissions) throw new Error("permission backend unavailable");
    return this.entries.get(subjectKey(subject.tenantId, subject.userId))?.permissions ?? [];
  }
}

class SharedCache {
  entries = new Map();
  failGet = false;
  failSet = false;
  async get(key) {
    if (this.failGet) throw new Error("cache read failed");
    return this.entries.get(key);
  }
  async set(key, snapshot) {
    if (this.failSet) throw new Error("cache write failed");
    this.entries.set(key, snapshot);
  }
}

function authorization(tenantId, userId, permission) {
  return { tenantId, userId, permission };
}

function subjectKey(tenantId, userId) {
  return JSON.stringify([tenantId, userId]);
}

if (!workspace) {
  process.stderr.write("Usage: node evaluate.mjs <workspace>\n");
  process.exit(2);
}

try {
  process.stdout.write(`${JSON.stringify(await evaluate(workspace), null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, scenario: "tenant-leak", technicalError: message })}\n`,
  );
  process.exitCode = 1;
}
