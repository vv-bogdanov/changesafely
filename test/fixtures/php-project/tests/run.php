<?php

declare(strict_types=1);

require __DIR__ . '/../src/value.php';

$failures = [];

function check(bool $condition, string $message): void
{
    global $failures;
    if (!$condition) {
        $failures[] = $message;
    }
}

foreach (glob(__DIR__ . '/*_test.php') ?: [] as $testFile) {
    require $testFile;
}

if ($failures !== []) {
    fwrite(STDERR, implode(PHP_EOL, $failures) . PHP_EOL);
    exit(1);
}

fwrite(STDOUT, "PHP checks passed\n");
