# Restart Storm

This scenario models service health methods and a Kubernetes-like deployment document.
The visible suite covers a healthy process, a stopped process, and startup progression,
but it does not exercise a database outage or recovery.

The worker receives only `baseline/` and the exact contents of `task.txt`. The hidden
evaluator, reference patch, and mutants remain controller-owned; no cluster is required.
