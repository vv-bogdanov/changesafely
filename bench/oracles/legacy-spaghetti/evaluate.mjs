import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  check,
  evaluationDocument,
  runNodeScopeChecks,
  runScenarioVisibleChecks,
} from "../evaluator-support.mjs";

const oracleRoot = dirname(fileURLToPath(import.meta.url));
const scenarioRoot = resolve(oracleRoot, "../../scenarios/legacy-spaghetti");
const baselineRoot = join(scenarioRoot, "baseline");
const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;

const behaviorCheckDefinitions = [
  ["preview-result", "acceptance"],
  ["preview-no-inventory-or-globals", "acceptance"],
  ["preview-no-messages-audit-or-events", "acceptance"],
  ["preview-no-metrics-or-pricing-state", "acceptance"],
  ["preview-input-immutable", "acceptance"],
  ["preview-callback-once", "acceptance"],
  ["preview-error-clean", "acceptance"],
  ["preview-repeatable", "acceptance"],
  ["preview-commit-isolation", "acceptance"],
  ["commit-preservation", "preservation"],
  ["fallback-preservation", "preservation"],
  ["refund-preservation", "preservation"],
];

async function evaluate(root) {
  const checks = [];
  const visible = await runScenarioVisibleChecks({ checks, root, scenarioRoot });
  if (visible) {
    const moduleUrl = pathToFileURL(join(root, "src/order-service.js")).href;
    const imported = await import(`${moduleUrl}?evaluation=${Date.now()}`);
    await runBehaviorChecks(checks, imported.default);
  } else {
    for (const [id, category] of behaviorCheckDefinitions) {
      checks.push({ id, category, passed: false, detail: "not evaluated after visible failure" });
    }
  }
  await runNodeScopeChecks({ checks, root, oracleRoot, baselineRoot });
  return evaluationDocument("legacy-spaghetti", checks);
}

async function runBehaviorChecks(checks, service) {
  await check(checks, "preview-result", "acceptance", async () => {
    service.reset();
    const outcome = await reprice(
      service,
      sampleOrder("preview-result"),
      requestContext("preview"),
    );
    assert(!outcome.error, `preview failed: ${outcome.error?.message}`);
    assert(outcome.calls === 1, `expected one callback, got ${outcome.calls}`);
    assert(outcome.result?.total === 2100, `expected total 2100, got ${outcome.result?.total}`);
    assert(outcome.result?.mode === "preview", "preview returned the wrong mode");
    assert(service.snapshot().orders.length === 0, "preview persisted an order");
  });

  await check(checks, "preview-no-inventory-or-globals", "acceptance", async () => {
    service.reset();
    await reprice(service, sampleOrder("preview-globals"), requestContext("preview"));
    const state = service.snapshot();
    assert(Object.keys(state.inventory).length === 0, "preview reserved inventory");
    assert(state.pendingReservation === null, "preview left a pending reservation");
    assert(state.lastTouchedId === null, "preview changed the shared last-order alias");
    assert(state.refundMode === false, "preview changed the refund state machine");
  });

  await check(checks, "preview-no-messages-audit-or-events", "acceptance", async () => {
    service.reset();
    const transport = [];
    await reprice(
      service,
      sampleOrder("preview-effects"),
      requestContext("preview", { transport }),
    );
    const state = service.snapshot();
    assert(state.notifications.length === 0, "preview queued a notification");
    assert(state.audit.length === 0, "preview wrote an audit event");
    assert(state.events.length === 0, "preview emitted a domain event");
    assert(transport.length === 0, "preview called the external transport");
  });

  await check(checks, "preview-no-metrics-or-pricing-state", "acceptance", async () => {
    service.reset();
    const before = service.snapshot();
    await reprice(
      service,
      sampleOrder("preview-metrics"),
      requestContext("preview", { region: "EU" }),
    );
    const after = service.snapshot();
    assert(after.metrics.reprices === 0, "preview incremented reprice metrics");
    assert(after.metrics.fallbacks === 0, "preview incremented fallback metrics");
    assert(after.pricing.quoteCalls === 0, "preview used the stateful quote path");
    assert(
      after.pricing.rememberedRegion === before.pricing.rememberedRegion,
      "preview changed require-cache pricing state",
    );
  });

  await check(checks, "preview-input-immutable", "acceptance", async () => {
    service.reset();
    const order = sampleOrder("preview-input");
    const before = structuredClone(order);
    await reprice(service, order, requestContext("preview"));
    assert(JSON.stringify(order) === JSON.stringify(before), "preview mutated the caller's order");
  });

  await check(checks, "preview-callback-once", "acceptance", async () => {
    service.reset();
    const outcome = await reprice(
      service,
      sampleOrder("preview-callback"),
      requestContext("preview"),
    );
    assert(outcome.calls === 1, `expected one callback, got ${outcome.calls}`);
  });

  await check(checks, "preview-error-clean", "acceptance", async () => {
    service.reset();
    const order = sampleOrder("preview-error");
    const before = structuredClone(order);
    const context = requestContext("preview");
    context.session.flash.coupon = "UNKNOWN";
    const outcome = await reprice(service, order, context);
    assert(!outcome.error, "legacy preview fallback became an error");
    assert(outcome.result?.total === 0, "legacy preview fallback payload changed");
    assert(outcome.calls === 1, `expected one error callback, got ${outcome.calls}`);
    assert(JSON.stringify(order) === JSON.stringify(before), "failed preview mutated its input");
    assert(isClean(service.snapshot()), "failed preview left a side effect");
  });

  await check(checks, "preview-repeatable", "acceptance", async () => {
    service.reset();
    const first = await reprice(service, sampleOrder("repeat"), requestContext("preview"));
    const second = await reprice(service, sampleOrder("repeat"), requestContext("preview"));
    assert(first.result?.total === second.result?.total, "repeated preview changed its result");
    assert(isClean(service.snapshot()), "repeated previews accumulated side effects");
  });

  await check(checks, "preview-commit-isolation", "acceptance", async () => {
    service.reset();
    const preview = await reprice(service, sampleOrder("preview"), requestContext("preview"));
    const commit = await reprice(service, sampleOrder("commit"), requestContext("commit"));
    assert(preview.result?.total === 2100 && commit.result?.total === 2100, "price changed");
    assertCommitEffects(service.snapshot(), "commit");
  });

  await check(checks, "commit-preservation", "preservation", async () => {
    service.reset();
    const transport = [];
    const order = sampleOrder("commit-preserved");
    const outcome = await reprice(service, order, requestContext("commit", { transport }));
    assert(!outcome.error && outcome.calls === 1, "commit callback changed");
    assert(outcome.result?.total === 2100, "commit price changed");
    assert(order.total === 2100 && order.items[0]?.extended === 2000, "commit mutation changed");
    assertCommitEffects(service.snapshot(), "commit-preserved");
    assert(transport.length === 1, "commit external notification changed");
  });

  await check(checks, "fallback-preservation", "preservation", async () => {
    service.reset();
    const order = sampleOrder("fallback");
    const context = requestContext("commit");
    context.session.flash.coupon = "UNKNOWN";
    const outcome = await reprice(service, order, context);
    assert(!outcome.error && outcome.result?.total === 0, "legacy commit fallback changed");
    const state = service.snapshot();
    assert(state.metrics.fallbacks === 1, "fallback metric changed");
    assert(state.orders.length === 1, "fallback commit was not persisted");
  });

  await check(checks, "refund-preservation", "preservation", async () => {
    service.reset();
    const outcome = await refund(service, { orderId: "order-9", amount: 500 });
    assert(!outcome.error && outcome.calls === 1, "refund callback changed");
    assert(outcome.result?.refundId === "refund-1", "refund id changed");
    const state = service.snapshot();
    assert(state.metrics.refunds === 1 && state.metrics.reprices === 0, "refund metrics changed");
    assert(state.audit.length === 1 && state.events.length === 1, "refund effects changed");
    assert(state.refundMode === false, "refund state did not unwind");
    assert(state.orders.length === 0, "refund touched order persistence");
  });
}

function sampleOrder(id) {
  return {
    id,
    status: 7,
    total: 0,
    items: [{ sku: "sku-1", unitPrice: 1000, quantity: 2 }],
  };
}

function requestContext(mode, overrides = {}) {
  const transport = overrides.transport ?? [];
  return {
    headers: { "x-change-mode": mode },
    locals: { actor: "support", region: overrides.region ?? "US" },
    session: { flash: { coupon: "SAVE10" } },
    transport: { send: (message) => transport.push(message) },
  };
}

async function reprice(service, order, context) {
  const outcome = { calls: 0, error: undefined, result: undefined };
  service.repriceOrder(order, context, (error, result) => {
    outcome.calls += 1;
    if (outcome.calls === 1) {
      outcome.error = error;
      outcome.result = result;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  return outcome;
}

async function refund(service, input) {
  const outcome = { calls: 0, error: undefined, result: undefined };
  service.submitRefund(input, (error, result) => {
    outcome.calls += 1;
    outcome.error = error;
    outcome.result = result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return outcome;
}

function isClean(state) {
  return (
    state.orders.length === 0 &&
    Object.keys(state.inventory).length === 0 &&
    state.notifications.length === 0 &&
    state.audit.length === 0 &&
    state.events.length === 0 &&
    state.metrics.reprices === 0 &&
    state.metrics.fallbacks === 0 &&
    state.pendingReservation === null &&
    state.lastTouchedId === null &&
    state.pricing.quoteCalls === 0
  );
}

function assertCommitEffects(state, orderId) {
  assert(
    state.orders.length === 1 && state.orders[0]?.id === orderId,
    "commit persistence changed",
  );
  assert(state.inventory["sku-1"] === 2, "commit inventory changed");
  assert(state.notifications.length === 1, "commit notification count changed");
  assert(state.audit.length === 1, "commit audit count changed");
  assert(state.events.length === 1, "commit event count changed");
  assert(state.metrics.reprices === 1, "commit metric changed");
  assert(state.pricing.quoteCalls === 1, "commit pricing state changed");
  assert(state.pendingReservation === null, "commit left a pending reservation");
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
    `${JSON.stringify({ schemaVersion: 1, scenario: "legacy-spaghetti", technicalError: message })}\n`,
  );
  process.exitCode = 1;
}
