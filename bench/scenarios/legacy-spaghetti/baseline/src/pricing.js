let rememberedRegion = process.env.LEGACY_PRICE_REGION || "US";
let quoteCalls = 0;

function round(value) {
  return Math.round(value);
}

function calculate(order, context, remember) {
  const explicitRegion = context.locals?.region;
  const region = explicitRegion || rememberedRegion;
  if (remember) {
    rememberedRegion = region;
    quoteCalls += 1;
  }

  let subtotal = 0;
  for (const item of order.items) {
    item.extended = item.unitPrice * item.quantity;
    subtotal += item.extended;
  }

  let discount = 0;
  try {
    const coupon = context.session.flash.coupon;
    if (coupon === "SAVE10") discount = subtotal * 0.1;
    else if (coupon) throw Object.assign(new Error("unknown coupon"), { code: "BAD_COUPON" });
    else throw Object.assign(new Error("no coupon"), { code: "NO_COUPON" });
  } catch (error) {
    if (error?.code !== "NO_COUPON") throw error;
  }

  const shipping = region === "EU" ? 500 : 300;
  const total = module.exports.round(subtotal - discount + shipping);
  order.total = total;
  order.priceRegion = region;
  return { total, region };
}

function quote(order, context) {
  return calculate(order, context, true);
}

function previewQuote(order, context) {
  return calculate(order, context, false);
}

function diagnostics() {
  return { quoteCalls, rememberedRegion };
}

function reset() {
  rememberedRegion = process.env.LEGACY_PRICE_REGION || "US";
  quoteCalls = 0;
}

module.exports = { diagnostics, previewQuote, quote, reset, round };
