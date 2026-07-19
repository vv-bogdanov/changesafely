export type Permission = "admin" | "document:read" | "document:write";

export interface AuthorizationSubject {
  tenantId: string;
  userId: string;
}

export interface AuthorizationRequest extends AuthorizationSubject {
  permission: Permission;
}

export interface AuthorizationSnapshot {
  version: string;
  permissions: readonly Permission[];
}

export interface AuthorizationBackend {
  version(subject: AuthorizationSubject): Promise<string>;
  loadPermissions(subject: AuthorizationSubject): Promise<readonly Permission[]>;
}

export interface AuthorizationCache {
  get(key: string): Promise<AuthorizationSnapshot | undefined>;
  set(key: string, snapshot: AuthorizationSnapshot): Promise<void>;
}

export class AuthorizationService {
  constructor(
    private readonly backend: AuthorizationBackend,
    private readonly cache: AuthorizationCache,
  ) {}

  async authorize(request: AuthorizationRequest): Promise<boolean> {
    if (!request.tenantId.trim() || !request.userId.trim()) return false;
    const subject = { tenantId: request.tenantId, userId: request.userId };
    try {
      await this.backend.version(subject);
      const permissions = await this.backend.loadPermissions(subject);
      return permissions.includes(request.permission);
    } catch {
      return false;
    }
  }
}
