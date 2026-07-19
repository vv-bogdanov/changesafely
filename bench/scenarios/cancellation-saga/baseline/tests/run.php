<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/CancellationService.php';

function order(string $id = 'order-normal'): array
{
    return [
        'id' => $id,
        'status' => 'paid',
        'amount' => 2500,
        'items' => [['sku' => 'sku-1', 'quantity' => 2]],
    ];
}

function expect(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$tests = [];
$tests['records cancellation effects'] = static function (): void {
    $state = new SagaState();
    $result = (new CancellationService($state))->cancel(order('order-effects'));
    expect($result === ['status' => 'cancelled', 'order_id' => 'order-effects'], 'wrong result');
    foreach ($state->snapshot() as $effects) {
        expect(count($effects) === 1, 'missing cancellation effect');
    }
};
$tests['preserves already cancelled orders'] = static function (): void {
    $state = new SagaState();
    $value = order('order-cancelled');
    $value['status'] = 'cancelled';
    $result = (new CancellationService($state))->cancel($value);
    expect($result['status'] === 'already_cancelled', 'cancelled order changed');
    expect(array_sum(array_map('count', $state->snapshot())) === 0, 'cancelled order had effects');
};
$tests['invokes the audit hook'] = static function (): void {
    $events = [];
    $GLOBALS['cancellation_hooks']['audits'] = static function (array $event) use (&$events): void {
        $events[] = $event;
    };
    (new CancellationService(new SagaState()))->cancel(order('order-hook'));
    unset($GLOBALS['cancellation_hooks']['audits']);
    expect(count($events) === 1, 'audit hook not called');
};

foreach ($tests as $name => $test) {
    try {
        $test();
        fwrite(STDOUT, "ok - {$name}\n");
    } catch (Throwable $error) {
        fwrite(STDERR, "not ok - {$name}: {$error->getMessage()}\n");
        exit(1);
    }
}
