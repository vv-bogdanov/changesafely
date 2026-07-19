import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assert,
  captureRejection,
  check,
  evaluationDocument,
  runNodeScopeChecks,
  runScenarioVisibleChecks,
} from "../evaluator-support.mjs";

const oracleRoot = dirname(fileURLToPath(import.meta.url));
const scenarioRoot = resolve(oracleRoot, "../../scenarios/double-charge");
const baselineRoot = join(scenarioRoot, "baseline");
const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;

async function evaluate(root) {
  const checks = [];
  const visible = await runScenarioVisibleChecks({ checks, root, scenarioRoot });

  if (visible) {
    const moduleUrl = pathToFileURL(join(root, "dist/src/payment-service.js")).href;
    const paymentModule = await import(`${moduleUrl}?evaluation=${Date.now()}`);
    await runBehaviorChecks(checks, paymentModule);
  } else {
    for (const [id, category] of behaviorCheckDefinitions) {
      checks.push({ id, category, passed: false, detail: "not evaluated after visible failure" });
    }
  }

  await runNodeScopeChecks({ checks, root, oracleRoot, baselineRoot });
  return evaluationDocument("double-charge", checks);
}

const behaviorCheckDefinitions = [
  ["sequential-retry", "acceptance"],
  ["concurrent-retry", "acceptance"],
  ["cross-instance-concurrent-retry", "acceptance"],
  ["retry-after-restart", "acceptance"],
  ["recovery-after-failed-save", "acceptance"],
  ["recovery-after-gateway-rejection", "acceptance"],
  ["amount-conflict", "acceptance"],
  ["currency-conflict", "acceptance"],
  ["distinct-operations", "acceptance"],
  ["normal-payment", "preservation"],
  ["refund", "preservation"],
];

async function runBehaviorChecks(checks, paymentModule) {
  const { PaymentConflictError, PaymentService } = paymentModule;

  await check(checks, "sequential-retry", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore();
    const service = new PaymentService(gateway, store);
    const input = payment("sequential");
    const first = await service.retryPayment(input);
    const second = await service.retryPayment(input);
    assert(first.paymentId === second.paymentId, "retry returned a different payment");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "concurrent-retry", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore();
    const service = new PaymentService(gateway, store);
    const [first, second] = await Promise.all([
      service.retryPayment(payment("concurrent")),
      service.retryPayment(payment("concurrent")),
    ]);
    assert(first.paymentId === second.paymentId, "concurrent retries returned different payments");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "cross-instance-concurrent-retry", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore();
    const firstService = new PaymentService(gateway, store);
    const secondService = new PaymentService(gateway, store);
    const [first, second] = await Promise.all([
      firstService.retryPayment(payment("cross-instance")),
      secondService.retryPayment(payment("cross-instance")),
    ]);
    assert(first.paymentId === second.paymentId, "service instances returned different payments");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "retry-after-restart", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore();
    const first = await new PaymentService(gateway, store).retryPayment(payment("restart"));
    const second = await new PaymentService(gateway, store).retryPayment(payment("restart"));
    assert(first.paymentId === second.paymentId, "restart retry returned a different payment");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "recovery-after-failed-save", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const store = new PersistentStore(1);
    await assertRejects(
      () => new PaymentService(gateway, store).retryPayment(payment("failed-save")),
      "first save should fail",
    );
    const recovered = await new PaymentService(gateway, store).retryPayment(payment("failed-save"));
    assert(recovered.paymentId === "payment-1", "recovery returned a different payment");
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
    assert(store.saveAttempts === 2, `expected 2 save attempts, got ${store.saveAttempts}`);
    assert(store.successfulSaves === 1, `expected 1 successful save, got ${store.successfulSaves}`);
    assert(
      (await store.get("failed-save"))?.receipt.paymentId === recovered.paymentId,
      "recovered operation was not persisted",
    );
  });

  await check(checks, "recovery-after-gateway-rejection", "acceptance", async () => {
    const gateway = new PersistentGateway(1);
    const store = new PersistentStore();
    const service = new PaymentService(gateway, store);
    await assertRejects(
      () => service.retryPayment(payment("gateway-rejection")),
      "first gateway call should fail",
    );
    const recovered = await service.retryPayment(payment("gateway-rejection"));
    assert(recovered.paymentId === "payment-1", "gateway retry returned the wrong payment");
    assert(
      gateway.chargeAttempts === 2,
      `expected 2 charge attempts, got ${gateway.chargeAttempts}`,
    );
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
    assert(store.successfulSaves === 1, `expected 1 successful save, got ${store.successfulSaves}`);
  });

  await check(checks, "amount-conflict", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    await service.retryPayment(payment("amount-conflict"));
    const error = await captureRejection(() =>
      service.retryPayment({ operationToken: "amount-conflict", amount: 1100, currency: "USD" }),
    );
    assert(error, "conflicting retry was accepted");
    assert(
      error instanceof PaymentConflictError || error.name === "PaymentConflictError",
      `expected PaymentConflictError, got ${error.name || typeof error}`,
    );
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "currency-conflict", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    await service.retryPayment(payment("currency-conflict"));
    const error = await captureRejection(() =>
      service.retryPayment({ operationToken: "currency-conflict", amount: 1000, currency: "EUR" }),
    );
    assert(error, "conflicting retry was accepted");
    assert(
      error instanceof PaymentConflictError || error.name === "PaymentConflictError",
      `expected PaymentConflictError, got ${error.name || typeof error}`,
    );
    assert(gateway.chargeEffects === 1, `expected 1 charge effect, got ${gateway.chargeEffects}`);
  });

  await check(checks, "distinct-operations", "acceptance", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    const first = await service.retryPayment(payment("operation-a"));
    const second = await service.retryPayment(payment("operation-b"));
    assert(first.paymentId !== second.paymentId, "distinct operations reused one payment");
    assert(gateway.chargeEffects === 2, `expected 2 charge effects, got ${gateway.chargeEffects}`);
  });

  await check(checks, "normal-payment", "preservation", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    const first = await service.pay({ amount: 800, currency: "USD" });
    const second = await service.pay({ amount: 800, currency: "USD" });
    assert(first.paymentId !== second.paymentId, "normal payments were incorrectly deduplicated");
    assert(gateway.chargeEffects === 2, `expected 2 charge effects, got ${gateway.chargeEffects}`);
  });

  await check(checks, "refund", "preservation", async () => {
    const gateway = new PersistentGateway();
    const service = new PaymentService(gateway, new PersistentStore());
    const refund = await service.refund({ paymentId: "payment-7", amount: 300 });
    assert(refund.paymentId === "payment-7", "refund changed the payment id");
    assert(refund.amount === 300, "refund changed the amount");
    assert(gateway.refundEffects === 1, `expected 1 refund effect, got ${gateway.refundEffects}`);
  });
}

class PersistentGateway {
  chargeAttempts = 0;
  chargeEffects = 0;
  refundEffects = 0;
  #payments = new Map();

  constructor(failedCharges = 0) {
    this.failedCharges = failedCharges;
  }

  async charge(input) {
    this.chargeAttempts += 1;
    if (this.failedCharges > 0) {
      this.failedCharges -= 1;
      throw new Error("simulated gateway rejection");
    }
    if (!input.idempotencyKey) return await this.#createPayment(input);

    const previous = this.#payments.get(input.idempotencyKey);
    if (previous) {
      if (previous.amount !== input.amount || previous.currency !== input.currency) {
        const error = new Error("idempotency key conflict");
        error.name = "PaymentConflictError";
        throw error;
      }
      return await previous.receipt;
    }

    const receipt = this.#createPayment(input).catch((error) => {
      if (this.#payments.get(input.idempotencyKey)?.receipt === receipt) {
        this.#payments.delete(input.idempotencyKey);
      }
      throw error;
    });
    this.#payments.set(input.idempotencyKey, { ...input, receipt });
    return await receipt;
  }

  async refund(input) {
    this.refundEffects += 1;
    return { refundId: `refund-${this.refundEffects}`, ...input };
  }

  async #createPayment(input) {
    await new Promise((resolveDelay) => setImmediate(resolveDelay));
    this.chargeEffects += 1;
    return {
      paymentId: `payment-${this.chargeEffects}`,
      amount: input.amount,
      currency: input.currency,
    };
  }
}

class PersistentStore {
  #operations = new Map();
  saveAttempts = 0;
  successfulSaves = 0;

  constructor(failedSaves = 0) {
    this.failedSaves = failedSaves;
  }

  async get(operationToken) {
    return this.#operations.get(operationToken);
  }

  async save(operation) {
    this.saveAttempts += 1;
    if (this.failedSaves > 0) {
      this.failedSaves -= 1;
      throw new Error("simulated persistent-store failure");
    }
    this.#operations.set(operation.operationToken, operation);
    this.successfulSaves += 1;
  }
}

function payment(operationToken) {
  return { operationToken, amount: 1000, currency: "USD" };
}

async function assertRejects(operation, message) {
  assert(await captureRejection(operation), message);
}

if (!workspace) {
  process.stderr.write("Usage: node evaluate.mjs <workspace>\n");
  process.exit(2);
}

try {
  const result = await evaluate(workspace);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, scenario: "double-charge", technicalError: message })}\n`,
  );
  process.exitCode = 1;
}
