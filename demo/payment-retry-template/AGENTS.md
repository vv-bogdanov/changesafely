# Payment demo instructions

- Keep `PaymentService.process(paymentId, amount)` backward compatible.
- Preserve the stable `paymentId` idempotency key on every provider call.
- Do not add dependencies, network calls, timers, queues, migrations, or external writes.
- Tests use `node:test`; run `npm test`, `npm run typecheck`, and `npm run build`.
- Safety tests belong under `test/` and must fail for the missing retry behavior before implementation.
