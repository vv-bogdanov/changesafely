import assert from "node:assert/strict";
import test from "node:test";
import {
  type ChargeReceipt,
  type ChargeRequest,
  type PaymentProvider,
  PaymentService,
} from "../src/payment.js";

class RecordingProvider implements PaymentProvider {
  readonly requests: ChargeRequest[] = [];

  async charge(request: ChargeRequest): Promise<ChargeReceipt> {
    this.requests.push(request);
    return {
      chargeId: `charge-${request.paymentId}`,
      paymentId: request.paymentId,
      amount: request.amount,
    };
  }
}

test("process charges once with the payment id as idempotency key", async () => {
  const provider = new RecordingProvider();
  const service = new PaymentService(provider);

  const receipt = await service.process("payment-1", 1250);

  assert.deepEqual(receipt, {
    chargeId: "charge-payment-1",
    paymentId: "payment-1",
    amount: 1250,
  });
  assert.deepEqual(provider.requests, [
    { paymentId: "payment-1", amount: 1250, idempotencyKey: "payment-1" },
  ]);
});
