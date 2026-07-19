const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");
const service = require("../src/order-service.js");

beforeEach(() => service.reset());

test("commits a repriced ready order", async () => {
  const order = sampleOrder("order-1");
  const result = await reprice(order, context("commit"));

  assert.deepEqual(result, { orderId: "order-1", total: 2100, mode: "commit" });
  assert.equal(service.snapshot().orders.length, 1);
  assert.equal(service.snapshot().notifications.length, 1);
});

test("previews the same price without persisting the order", async () => {
  const result = await reprice(sampleOrder("preview-1"), context("preview"));

  assert.deepEqual(result, { orderId: "preview-1", total: 2100, mode: "preview" });
  assert.equal(service.snapshot().orders.length, 0);
});

test("preserves the refund callback flow", async () => {
  const result = await refund({ orderId: "order-9", amount: 500 });

  assert.deepEqual(result, { refundId: "refund-1", orderId: "order-9", amount: 500 });
  assert.equal(service.snapshot().refundMode, false);
});

function sampleOrder(id) {
  return {
    id,
    status: 7,
    total: 0,
    items: [{ sku: "sku-1", unitPrice: 1000, quantity: 2 }],
  };
}

function context(mode) {
  return {
    headers: { "x-change-mode": mode },
    locals: { actor: "support", region: "US" },
    session: { flash: { coupon: "SAVE10" } },
    transport: { send() {} },
  };
}

function reprice(order, requestContext) {
  return new Promise((resolve, reject) => {
    service.repriceOrder(order, requestContext, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
}

function refund(input) {
  return new Promise((resolve, reject) => {
    service.submitRefund(input, (error, result) => (error ? reject(error) : resolve(result)));
  });
}
