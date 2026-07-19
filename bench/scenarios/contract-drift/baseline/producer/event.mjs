export function encodeOrderEvent(input) {
  return JSON.stringify({
    version: 1,
    type: "order.created",
    id: input.id,
    amount_cents: String(input.amountCents),
    sequence: input.sequence,
  });
}
