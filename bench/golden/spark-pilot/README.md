# Published Spark pilot evidence

This directory contains the retained Tenant Leak and Restart Storm development pairs
from 2026-07-19. They use `gpt-5.3-codex-spark` at medium effort and are not final or
statistically significant measurements.

Double Charge is intentionally excluded because its retained pair predates the
deterministic command-output fix in commit `1a3184c`. Its outcome remains documented
in [`../../RESULTS.md`](../../RESULTS.md) without presenting it as current-product
golden evidence.

## Integrity

Each run has an immutable `evidence-manifest.json`; each analysis has an
`analysis-manifest.json` bound to the evidence manifest. `report.json` and `report.md`
are derived only from those verified packages.

Before publication, all four runs passed `benchmark replay`, the report was regenerated,
and the exact directory passed:

```sh
gitleaks detect --no-git --source bench/golden/spark-pilot --redact
```

No leaks were found. The generated report hashes were:

- JSON: `52479e82279bea8094d8cdc6cbda954a5e9074216769627635623af4fca28396`;
- Markdown: `33656d38195baee447543532e136521c0acba20d7f8222df06038ce22a9fb881`.

Report version 3 derives per-role token deltas from cumulative thread snapshots, so
forked `C0` usage is counted once. Legacy traces did not record tool or artifact-size
events; those fields are shown as unavailable rather than estimated.

## Replay

Replay one run without a model or network call:

```sh
npm run benchmark -- replay \
  --results bench/golden/spark-pilot \
  --run restart-storm-changesafely-20260719154846674-ac381eee
```

Regenerate the paired report:

```sh
npm run benchmark -- report --results bench/golden/spark-pilot
```

Absolute temporary workspace paths may remain in exact runtime messages. They contain
no credentials and are preserved because redaction would invalidate the evidence
manifest.
