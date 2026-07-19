# Tenant Leak

This scenario models authorization identities whose user IDs are unique only inside a
tenant. The visible suite covers ordinary allow, deny, tenant forwarding, invalid input,
and backend failure. Version 2 additionally checks concurrent cold misses, collision-safe
keys, shared-cache reuse, permission-specific decisions, negative-result caching, grants and
revocations, and fail-closed backend/cache errors.

The hidden evaluator validates eleven focused unsafe-green mutants. Each mutant keeps the
visible suite green while breaking a distinct cache, trust-boundary, concurrency, freshness,
or error-handling invariant.

The worker receives only `baseline/` and the exact contents of `task.txt`. The hidden
evaluator, reference patch, and mutants remain controller-owned.

Version 3 moves preparation, visible checks, test paths, and Node/npm version evidence into the
language-neutral scenario manifest without changing the public task.
Version 4 adds explicit mutation value for cache reuse and fail-closed unknown subjects.
