# Double Charge

This scenario models a retry operation around an external payment side effect. The
visible suite covers ordinary payment, one retry, and refund behavior, but it does not
prove sequential, cross-instance concurrent, restart-safe, or failure-recovery
idempotency.

The worker receives only `baseline/` and the exact contents of `task.txt`. The hidden
evaluator, reference patch, and mutants remain controller-owned.

The reference uses the operation token consistently across persistent service state and
the gateway's atomic idempotency boundary. Seven mutants cover process-local state,
non-atomic check-then-write, missing input validation, a key derived from mutable input,
premature completion state, a constant provider key, and in-flight-only deduplication.

Version 3 moves preparation, visible checks, test paths, and Node/npm version evidence into the
language-neutral scenario manifest without changing the public task.
Version 4 adds mutation value for sequential retries through the in-flight-only strategy.
