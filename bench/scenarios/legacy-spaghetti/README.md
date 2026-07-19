# Legacy Spaghetti

This CommonJS scenario models a small order repricing path whose preview mode is mixed
with persistence, inventory, notification, audit, event, callback, and module-global
behavior. The visible suite proves the returned preview price and absence of an order
record; hidden checks measure the remaining effects and preservation boundaries.

The fixture intentionally includes 18 recognizable legacy hazard families across the
critical path, preservation paths, and decoys: shared globals, mutable objects, parameter
smuggling, misleading names, magic values, hidden side effects, require-cache state,
import-order coupling, monkey patches, callback/event coupling, alias mutation,
exception-driven flow, implicit state machines, temporal coupling, duplicated near-logic,
error-masking fallbacks, environment-dependent behavior, and cross-feature coupling.

Version 2 preserves the pre-existing fallback payload for invalid preview coupons while
requiring that fallback to remain free of state, metric, alias, and external effects. It
also excludes local ChangeSafely evidence from the candidate diff.

The worker receives only `baseline/` and the exact contents of `task.txt`. The hidden
evaluator, reference patch, and unsafe mutants remain controller-owned.
