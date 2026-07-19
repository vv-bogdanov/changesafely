<?php

declare(strict_types=1);

$GLOBALS['cancellation_hooks'] ??= [];

final class SagaState
{
    public array $refunds = [];
    public array $restocks = [];
    public array $notifications = [];
    public array $audits = [];
    private bool $failureUsed = false;
    private bool $interleaveUsed = false;

    public function __construct(
        private readonly ?string $failAfter = null,
        private readonly mixed $interleave = null,
    ) {
    }

    public function begin(string $orderId, string $signature): void
    {
    }

    public function effect(string $kind, string $key, array $payload): void
    {
        $this->{$kind}[] = $payload;
        if (!$this->interleaveUsed && is_callable($this->interleave)) {
            $this->interleaveUsed = true;
            ($this->interleave)();
        }
        $hook = $GLOBALS['cancellation_hooks'][$kind] ?? null;
        if (is_callable($hook)) {
            $hook($payload);
        }
        if ($this->failAfter === $kind && !$this->failureUsed) {
            $this->failureUsed = true;
            throw new RuntimeException("injected failure after {$kind}");
        }
    }

    public function snapshot(): array
    {
        return [
            'refunds' => $this->refunds,
            'restocks' => $this->restocks,
            'notifications' => $this->notifications,
            'audits' => $this->audits,
        ];
    }
}

final class CancellationService
{
    private static array $recent = [];

    public function __construct(private readonly SagaState $state)
    {
    }

    public function cancel(array $order): array
    {
        $orderId = $order['meta']['retry_key'] ?? $order['id'];
        if (($order['status'] ?? null) == 'cancelled') {
            return ['status' => 'already_cancelled', 'order_id' => $orderId];
        }
        $signature = json_encode([$order['amount'], $order['items']], JSON_THROW_ON_ERROR);
        $this->state->begin($orderId, $signature);
        try {
            $base = ['order_id' => $orderId];
            $this->state->effect('refunds', $orderId, $base + ['amount' => $order['amount']]);
            foreach ($order['items'] as $item) {
                $this->state->effect(
                    'restocks',
                    "{$orderId}:{$item['sku']}",
                    $base + ['sku' => $item['sku'], 'quantity' => $item['quantity']],
                );
            }
            $this->state->effect('notifications', $orderId, $base);
            $this->state->effect('audits', $orderId, $base + ['event' => 'order.cancelled']);
        } catch (Throwable $error) {
            return ['status' => 'retry', 'order_id' => $orderId, 'error' => $error->getMessage()];
        }
        self::$recent[$orderId] = true;
        return ['status' => 'cancelled', 'order_id' => $orderId];
    }
}
