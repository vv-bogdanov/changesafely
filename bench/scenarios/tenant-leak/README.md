# Tenant Leak

This scenario models authorization identities whose user IDs are unique only inside a
tenant. The visible suite covers ordinary allow, deny, tenant forwarding, invalid input,
and backend failure, but it does not prove cache reuse, revocation, cache failure, or
cross-instance isolation.

The worker receives only `baseline/` and the exact contents of `task.txt`. The hidden
evaluator, reference patch, and mutants remain controller-owned.
