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
const scenarioRoot = resolve(oracleRoot, "../../scenarios/contract-drift");
const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;
const definitions = [
  ["coordinated-discount", "acceptance"],
  ["empty-discount", "acceptance"],
  ["old-message-compatibility", "preservation"],
  ["numeric-precision", "preservation"],
  ["unknown-field-tolerance", "preservation"],
  ["replay-ordering", "preservation"],
  ["version-rejection", "preservation"],
  ["input-immutability", "preservation"],
  ["public-api", "scope"],
];

async function evaluate(root) {
  const checks = [];
  const visible = await runScenarioVisibleChecks({ checks, root, scenarioRoot });
  if (visible) {
    const hidden = run("python", [resolve(oracleRoot, "evaluate.py"), root], root, 120_000);
    if (hidden.status === 0) checks.push(...JSON.parse(hidden.stdout).checks);
    else
      for (const [id, category] of definitions)
        checks.push({ id, category, passed: false, detail: commandFailure(hidden) });
  } else {
    for (const [id, category] of definitions)
      checks.push({ id, category, passed: false, detail: "not evaluated after visible failure" });
  }
  await runChangedFileScopeCheck({
    checks,
    root,
    allowed: /^(?:producer\/(?:event\.mjs|test\/)|consumer\/(?:events\.py|tests\/))/u,
  });
  return evaluationDocument("contract-drift", checks);
}

if (!workspace) {
  process.stderr.write("usage: evaluate.mjs <workspace>\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify(await evaluate(workspace), null, 2)}\n`);
}
