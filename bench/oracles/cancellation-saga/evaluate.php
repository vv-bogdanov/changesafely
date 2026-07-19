<?php

declare(strict_types=1);

$root = realpath($argv[1] ?? '');
if ($root === false) {
    throw new RuntimeException('workspace is required');
}
require_once $root . '/src/CancellationService.php';

$checks = [];
function check_case(array &$checks, string $id, string $category, callable $operation): void
{
    try {
        $operation();
        $checks[] = ['id' => $id, 'category' => $category, 'passed' => true, 'detail' => 'passed'];
    } catch (Throwable $error) {
        $checks[] = ['id' => $id, 'category' => $category, 'passed' => false, 'detail' => $error->getMessage()];
    }
}
function sample_order(string $id = 'order-1', int $amount = 2500, ?string $retryKey = null): array
{
    $order = [
        'id' => $id,
        'status' => 'paid',
        'amount' => $amount,
        'items' => [['sku' => 'sku-1', 'quantity' => 2]],
    ];
    if ($retryKey !== null) $order['meta'] = ['retry_key' => $retryKey];
    return $order;
}
function assert_true(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function assert_effects_once(SagaState $state): void
{
    foreach ($state->snapshot() as $kind => $effects) {
        assert_true(count($effects) === 1, "expected one {$kind} effect, got " . count($effects));
    }
}

check_case($checks, 'partial-boundary-retry', 'acceptance', static function (): void {
    foreach (['refunds', 'restocks', 'notifications', 'audits'] as $boundary) {
        $state = new SagaState($boundary);
        $first = (new CancellationService($state))->cancel(sample_order("order-{$boundary}"));
        assert_true($first['status'] === 'retry', "{$boundary} failure was not retryable");
        $second = (new CancellationService($state))->cancel(sample_order("order-{$boundary}"));
        assert_true($second['status'] === 'cancelled', "{$boundary} retry did not complete");
        assert_effects_once($state);
    }
});
check_case($checks, 'cross-instance-retry', 'acceptance', static function (): void {
    $state = new SagaState('restocks');
    (new CancellationService($state))->cancel(sample_order());
    $result = (new CancellationService($state))->cancel(sample_order());
    assert_true($result['status'] === 'cancelled', 'new service did not resume');
    assert_effects_once($state);
});
check_case($checks, 'reentrant-cancellation', 'acceptance', static function (): void {
    $state = null;
    $second = null;
    $state = new SagaState(null, static function () use (&$state, &$second): void {
        $second = (new CancellationService($state))->cancel(sample_order());
    });
    $first = (new CancellationService($state))->cancel(sample_order());
    assert_true($first['status'] === 'cancelled' && $second['status'] === 'cancelled', 'overlap failed');
    assert_effects_once($state);
});
check_case($checks, 'input-conflict', 'acceptance', static function (): void {
    $state = new SagaState();
    $service = new CancellationService($state);
    $service->cancel(sample_order(amount: 2500));
    $before = $state->snapshot();
    try {
        $service->cancel(sample_order(amount: 9999));
    } catch (InvalidArgumentException) {
        assert_true($state->snapshot() === $before, 'conflict added an effect');
        return;
    }
    throw new RuntimeException('changed input was accepted');
});
check_case($checks, 'retry-key-isolation', 'acceptance', static function (): void {
    $state = new SagaState();
    $service = new CancellationService($state);
    $service->cancel(sample_order('order-a', retryKey: 'shared'));
    $service->cancel(sample_order('order-b', retryKey: 'shared'));
    $ids = array_unique(array_column($state->audits, 'order_id'));
    sort($ids);
    assert_true($ids === ['order-a', 'order-b'], 'retry key merged unrelated orders');
});
check_case($checks, 'hook-exactly-once', 'acceptance', static function (): void {
    $events = [];
    $GLOBALS['cancellation_hooks']['audits'] = static function (array $event) use (&$events): void { $events[] = $event; };
    $state = new SagaState('audits');
    (new CancellationService($state))->cancel(sample_order());
    (new CancellationService($state))->cancel(sample_order());
    unset($GLOBALS['cancellation_hooks']['audits']);
    assert_true(count($events) === 1, 'audit hook repeated');
});
check_case($checks, 'state-isolation', 'acceptance', static function (): void {
    $first = new SagaState();
    $second = new SagaState();
    (new CancellationService($first))->cancel(sample_order());
    (new CancellationService($second))->cancel(sample_order());
    assert_effects_once($first);
    assert_effects_once($second);
});
check_case($checks, 'already-cancelled', 'preservation', static function (): void {
    $state = new SagaState();
    $order = sample_order();
    $order['status'] = 'cancelled';
    $result = (new CancellationService($state))->cancel($order);
    assert_true($result['status'] === 'already_cancelled', 'cancelled order changed');
    assert_true(array_sum(array_map('count', $state->snapshot())) === 0, 'cancelled order had effects');
});
check_case($checks, 'input-immutability', 'preservation', static function (): void {
    $order = sample_order();
    $before = $order;
    (new CancellationService(new SagaState()))->cancel($order);
    assert_true($order === $before, 'order input changed');
});
check_case($checks, 'public-api', 'scope', static function (): void {
    $state = new ReflectionClass(SagaState::class);
    $service = new ReflectionClass(CancellationService::class);
    assert_true($state->getConstructor()?->getNumberOfParameters() === 2, 'SagaState constructor changed');
    assert_true($service->getConstructor()?->getNumberOfParameters() === 1, 'service constructor changed');
    assert_true($service->getMethod('cancel')->getNumberOfParameters() === 1, 'cancel API changed');
});

echo json_encode(['checks' => $checks], JSON_THROW_ON_ERROR), "\n";
