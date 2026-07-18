export interface ChargeRequest {
  readonly paymentId: string;
  readonly amount: number;
  readonly idempotencyKey: string;
}

export interface ChargeReceipt {
  chargeId: string;
  paymentId: string;
  amount: number;
}

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeReceipt>;
}

export class TransientPaymentError extends Error {
  constructor(message = "Payment provider timed out") {
    super(message);
    this.name = "TransientPaymentError";
  }
}

export class PaymentService {
  constructor(private readonly provider: PaymentProvider) {}

  process(paymentId: string, amount: number): Promise<ChargeReceipt> {
    return this.provider.charge({ paymentId, amount, idempotencyKey: paymentId });
  }
}
