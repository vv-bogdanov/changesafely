import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  check,
  commandFailure,
  evaluationDocument,
  run,
  runStandardScopeChecks,
} from "../evaluator-support.mjs";

const oracleRoot = dirname(fileURLToPath(import.meta.url));
const baselineRoot = resolve(oracleRoot, "../../scenarios/restart-storm/baseline");
const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;

async function evaluate(root) {
  const checks = [];
  const visible = run("npm", ["test"], root, 120_000);
  checks.push({
    id: "visible-checks",
    category: "visible",
    passed: visible.status === 0,
    detail: visible.status === 0 ? "npm test passed" : commandFailure(visible),
  });
  if (visible.status === 0) {
    const moduleUrl = pathToFileURL(join(root, "dist/src/health-service.js")).href;
    await runBehaviorChecks(checks, await import(`${moduleUrl}?evaluation=${Date.now()}`));
  } else {
    for (const [id, category] of behaviorCheckDefinitions) {
      checks.push({ id, category, passed: false, detail: "not evaluated after visible failure" });
    }
  }
  await runConfigurationChecks(checks, root);
  await runStandardScopeChecks({ checks, root, oracleRoot, baselineRoot });
  return evaluationDocument("restart-storm", checks);
}

const behaviorCheckDefinitions = [
  ["database-outage-readiness", "acceptance"],
  ["recovery-without-restart", "acceptance"],
  ["database-errors", "acceptance"],
  ["liveness-preservation", "preservation"],
  ["startup-preservation", "preservation"],
  ["stopped-process", "preservation"],
];

async function runBehaviorChecks(checks, healthModule) {
  const { HealthService } = healthModule;

  await check(checks, "database-outage-readiness", "acceptance", async () => {
    const database = new MutableDatabase(false);
    const service = new HealthService(database, { running: true, started: true });
    assert(!(await service.readiness()), "database outage left the service ready");
  });

  await check(checks, "recovery-without-restart", "acceptance", async () => {
    const database = new MutableDatabase(false);
    const processState = { running: true, started: true };
    const service = new HealthService(database, processState);
    assert(!(await service.readiness()), "outage did not remove readiness");
    database.available = true;
    assert(await service.readiness(), "readiness did not recover on the same service instance");
    assert(processState.running, "recovery required a process restart");
  });

  await check(checks, "database-errors", "acceptance", async () => {
    const database = new MutableDatabase(true);
    database.fail = true;
    const service = new HealthService(database, { running: true, started: true });
    assert(!(await service.readiness()), "database error became ready");
  });

  await check(checks, "liveness-preservation", "preservation", async () => {
    const unavailable = new MutableDatabase(false);
    const service = new HealthService(unavailable, { running: true, started: true });
    assert(await service.liveness(), "database outage failed liveness");
    assert(unavailable.reads === 0, "liveness queried the database");

    const failing = new MutableDatabase(true);
    failing.fail = true;
    assert(
      await new HealthService(failing, { running: true, started: true }).liveness(),
      "database error failed liveness",
    );
    assert(failing.reads === 0, "liveness queried a failing database");
  });

  await check(checks, "startup-preservation", "preservation", async () => {
    const database = new MutableDatabase(false);
    const processState = { running: true, started: false };
    const service = new HealthService(database, processState);
    assert(!(await service.startup()), "unstarted process passed startup");
    processState.started = true;
    assert(await service.startup(), "started process failed startup");
    assert(database.reads === 0, "startup queried the database");
  });

  await check(checks, "stopped-process", "preservation", async () => {
    const service = new HealthService(new MutableDatabase(true), {
      running: false,
      started: true,
    });
    assert(!(await service.liveness()), "stopped process passed liveness");
    assert(!(await service.readiness()), "stopped process passed readiness");
    assert(!(await service.startup()), "stopped process passed startup");
  });
}

async function runConfigurationChecks(checks, root) {
  await check(checks, "deployment-parameters", "scope", async () => {
    const [expected, actual] = await Promise.all([
      readFile(join(baselineRoot, "deployment.json"), "utf8"),
      readFile(join(root, "deployment.json"), "utf8"),
    ]);
    assert(actual === expected, "deployment parameters or probe routing changed");
  });

  await check(checks, "no-destructive-apply", "scope", async () => {
    const match = run(
      "git",
      [
        "grep",
        "-n",
        "-E",
        "kubectl (apply|delete)|helm (upgrade|uninstall)|terraform apply",
        "--",
        ".",
      ],
      root,
    );
    assert(match.status === 1, match.status === 0 ? match.stdout : commandFailure(match));
  });
}

class MutableDatabase {
  reads = 0;
  fail = false;
  constructor(available) {
    this.available = available;
  }
  async isAvailable() {
    this.reads += 1;
    if (this.fail) throw new Error("database health check failed");
    return this.available;
  }
}

if (!workspace) {
  process.stderr.write("Usage: node evaluate.mjs <workspace>\n");
  process.exit(2);
}

try {
  process.stdout.write(`${JSON.stringify(await evaluate(workspace), null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, scenario: "restart-storm", technicalError: message })}\n`,
  );
  process.exitCode = 1;
}
