const pricing = require("./pricing.js");
const store = require("./state.js");
require("./legacy-hooks.js").install(pricing);

const READY = 7;

function repriceOrder(order, context, callback) {
  const preview = context.headers?.["x-change-mode"] === "preview";
  let quote;
  try {
    quote = pricing.quote(order, context);
  } catch {
    store.state.metrics.fallbacks += 1;
    quote = { total: order.total || 0, region: "fallback" };
  }

  store.state.metrics.reprices += 1;
  store.state.lastTouched = order;
  store.warm(order);
  store.state.audit.push({ action: "repriced", actor: context.locals?.actor || "system" });
  store.state.bus.emit("repriced", { orderId: order.id, total: quote.total });
  send(context, { kind: "price-changed", orderId: order.id });

  if (!preview) {
    if (order.status !== READY) return callback(new Error("order is not ready"));
    store.touch(order);
  }

  callback(null, {
    orderId: order.id,
    total: quote.total,
    mode: preview ? "preview" : "commit",
  });
}

function submitRefund(refund, callback) {
  store.state.refundMode = true;
  try {
    store.state.metrics.refunds += 1;
    store.state.audit.push({ action: "refunded", actor: "billing" });
    store.state.bus.emit("refunded", { orderId: refund.orderId, amount: refund.amount });
    callback(null, { refundId: `refund-${store.state.metrics.refunds}`, ...refund });
  } finally {
    store.state.refundMode = false;
  }
}

function send(context, message) {
  store.state.notifications.push(message);
  context.transport?.send?.(message);
}

function snapshot() {
  return { ...store.snapshot(), pricing: pricing.diagnostics() };
}

function reset() {
  store.reset();
  pricing.reset();
}

module.exports = { repriceOrder, reset, snapshot, submitRefund };
