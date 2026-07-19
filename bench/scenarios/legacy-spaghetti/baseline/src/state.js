const { EventEmitter } = require("node:events");

const state = {
  orders: new Map(),
  inventory: new Map(),
  notifications: [],
  audit: [],
  events: [],
  metrics: { reprices: 0, refunds: 0, fallbacks: 0 },
  pendingReservation: null,
  lastTouched: null,
  refundMode: false,
  bus: new EventEmitter(),
};

function installListeners() {
  state.bus.removeAllListeners();
  state.bus.on("repriced", (event) => state.events.push({ ...event }));
  state.bus.on("refunded", (event) => state.events.push({ ...event }));
}

function reset() {
  state.orders.clear();
  state.inventory.clear();
  state.notifications.length = 0;
  state.audit.length = 0;
  state.events.length = 0;
  state.metrics.reprices = 0;
  state.metrics.refunds = 0;
  state.metrics.fallbacks = 0;
  state.pendingReservation = null;
  state.lastTouched = null;
  state.refundMode = false;
  installListeners();
}

function warm(order) {
  state.pendingReservation = order.id;
  for (const item of order.items) {
    state.inventory.set(item.sku, (state.inventory.get(item.sku) || 0) + item.quantity);
  }
}

function touch(order) {
  if (state.pendingReservation !== order.id) throw new Error("order was not prepared");
  state.orders.set(order.id, structuredClone(order));
  state.lastTouched = order;
  state.pendingReservation = null;
}

function snapshot() {
  return {
    orders: [...state.orders.values()].map((order) => structuredClone(order)),
    inventory: Object.fromEntries(state.inventory),
    notifications: state.notifications.map((message) => ({ ...message })),
    audit: state.audit.map((entry) => ({ ...entry })),
    events: state.events.map((event) => ({ ...event })),
    metrics: { ...state.metrics },
    pendingReservation: state.pendingReservation,
    lastTouchedId: state.lastTouched?.id || null,
    refundMode: state.refundMode,
  };
}

reset();

module.exports = { reset, snapshot, state, touch, warm };
