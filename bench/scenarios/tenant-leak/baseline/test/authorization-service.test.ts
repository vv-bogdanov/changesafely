import assert from "node:assert/strict";
import test from "node:test";

import {
  type AuthorizationBackend,
  type AuthorizationCache,
  type AuthorizationSnapshot,
  AuthorizationService,
  type AuthorizationSubject,
  type Permission,
} from "../src/authorization-service.js";

class MemoryBackend implements AuthorizationBackend {
  readonly entries = new Map<string, AuthorizationSnapshot>();
  permissionLoads = 0;
  fail = false;

  set(subject: AuthorizationSubject, version: string, permissions: Permission[]): void {
    this.entries.set(key(subject), { version, permissions });
  }

  async version(subject: AuthorizationSubject): Promise<string> {
    if (this.fail) throw new Error("backend unavailable");
    return this.entries.get(key(subject))?.version ?? "missing";
  }

  async loadPermissions(subject: AuthorizationSubject): Promise<readonly Permission[]> {
    if (this.fail) throw new Error("backend unavailable");
    this.permissionLoads += 1;
    return this.entries.get(key(subject))?.permissions ?? [];
  }
}

class MemoryCache implements AuthorizationCache {
  readonly entries = new Map<string, AuthorizationSnapshot>();
  async get(cacheKey: string): Promise<AuthorizationSnapshot | undefined> {
    return this.entries.get(cacheKey);
  }
  async set(cacheKey: string, snapshot: AuthorizationSnapshot): Promise<void> {
    this.entries.set(cacheKey, snapshot);
  }
}

test("allows only a permission returned by the backend", async () => {
  const backend = new MemoryBackend();
  backend.set({ tenantId: "tenant-a", userId: "user-1" }, "1", ["document:read"]);
  const service = new AuthorizationService(backend, new MemoryCache());

  assert.equal(
    await service.authorize({
      tenantId: "tenant-a",
      userId: "user-1",
      permission: "document:read",
    }),
    true,
  );
  assert.equal(
    await service.authorize({
      tenantId: "tenant-a",
      userId: "user-1",
      permission: "document:write",
    }),
    false,
  );
});

test("uses separate tenant lookups", async () => {
  const backend = new MemoryBackend();
  backend.set({ tenantId: "tenant-a", userId: "user-a" }, "1", ["admin"]);
  backend.set({ tenantId: "tenant-b", userId: "user-b" }, "1", []);
  const service = new AuthorizationService(backend, new MemoryCache());

  assert.equal(
    await service.authorize({ tenantId: "tenant-a", userId: "user-a", permission: "admin" }),
    true,
  );
  assert.equal(
    await service.authorize({ tenantId: "tenant-b", userId: "user-b", permission: "admin" }),
    false,
  );
});

test("denies invalid subjects and backend errors", async () => {
  const backend = new MemoryBackend();
  const service = new AuthorizationService(backend, new MemoryCache());
  assert.equal(
    await service.authorize({ tenantId: "", userId: "user-1", permission: "admin" }),
    false,
  );
  backend.fail = true;
  assert.equal(
    await service.authorize({ tenantId: "tenant-a", userId: "user-1", permission: "admin" }),
    false,
  );
});

function key(subject: AuthorizationSubject): string {
  return JSON.stringify([subject.tenantId, subject.userId]);
}
