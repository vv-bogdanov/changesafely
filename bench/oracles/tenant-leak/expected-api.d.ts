// source: authorization-service.d.ts
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
export declare class AuthorizationService {
  private readonly backend;
  private readonly cache;
  constructor(backend: AuthorizationBackend, cache: AuthorizationCache);
  authorize(request: AuthorizationRequest): Promise<boolean>;
}
