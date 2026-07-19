import assert from "node:assert/strict";
import test from "node:test";
import { encodeOrderEvent } from "../event.mjs";

test("encodes the existing v1 contract", () => {
  assert.deepEqual(
    JSON.parse(encodeOrderEvent({ id: "order-1", amountCents: "1250", sequence: 3 })),
    {
      version: 1,
      type: "order.created",
      id: "order-1",
      amount_cents: "1250",
      sequence: 3,
    },
  );
});

test("does not mutate producer input", () => {
  const input = { id: "order-2", amountCents: "500", sequence: 4 };
  const before = structuredClone(input);
  encodeOrderEvent(input);
  assert.deepEqual(input, before);
});
