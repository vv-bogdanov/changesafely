import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandFailure,
  evaluationDocument,
  run,
  runChangedFileScopeCheck,
  runScenarioVisibleChecks,
} from "../evaluator-support.mjs";

const oracleRoot = dirname(fileURLToPath(import.meta.url));
const scenarioRoot = resolve(oracleRoot, "../../scenarios/cancellation-saga");
const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;
const definitions = [
  ["partial-boundary-retry", "acceptance"],
  ["cross-instance-retry", "acceptance"],
  ["reentrant-cancellation", "acceptance"],
  ["input-conflict", "acceptance"],
  ["retry-key-isolation", "acceptance"],
  ["hook-exactly-once", "acceptance"],
  ["state-isolation", "acceptance"],
  ["already-cancelled", "preservation"],
  ["input-immutability", "preservation"],
  ["public-api", "scope"],
];

async function evaluate(root) {
  const checks = [];
  const visible = await runScenarioVisibleChecks({ checks, root, scenarioRoot });
  if (visible) {
    const hidden = run("php", [resolve(oracleRoot, "evaluate.php"), root], root, 120_000);
    if (hidden.status === 0) checks.push(...JSON.parse(hidden.stdout).checks);
    else
      for (const [id, category] of definitions)
        checks.push({ id, category, passed: false, detail: commandFailure(hidden) });
  } else {
    for (const [id, category] of definitions)
      checks.push({ id, category, passed: false, detail: "not evaluated after visible failure" });
  }
  await runChangedFileScopeCheck({ checks, root, allowed: /^(?:src\/|tests\/)/u });
  return evaluationDocument("cancellation-saga", checks);
}

if (!workspace) {
  process.stderr.write("usage: evaluate.mjs <workspace>\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify(await evaluate(workspace), null, 2)}\n`);
}
