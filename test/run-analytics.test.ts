import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTrace, normalizeTokenMetrics } from "../src/run-analytics.js";
import { TRACE_VERSION, type TraceEvent } from "../src/trace.js";

function event(
  seq: number,
  offsetMs: number,
  input: Omit<TraceEvent, "traceVersion" | "seq" | "timestamp" | "runId">,
): TraceEvent {
  return {
    traceVersion: TRACE_VERSION,
    seq,
    timestamp: new Date(Date.UTC(2026, 6, 19, 0, 0, 0, offsetMs)).toISOString(),
    runId: "analytics-run",
    ...input,
  };
}

test("derives incremental per-role and aggregate analytics from cumulative usage", () => {
  const events = [
    event(1, 0, {
      component: "workflow",
      event: "phase.started",
      status: "started",
      phase: "planning",
    }),
    event(2, 5, {
      component: "role",
      event: "turn.executed",
      status: "started",
      phase: "planning",
      role: "planner:plan-1",
      threadId: "root",
    }),
    event(3, 50, {
      component: "app-server",
      event: "token.usage",
      status: "info",
      threadId: "root",
      turnId: "turn-1",
      totalTokens: 120,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
    }),
    event(4, 60, {
      component: "app-server",
      event: "item.completed",
      status: "completed",
      threadId: "root",
      turnId: "turn-1",
      itemType: "commandExecution",
      toolFailed: false,
      durationMs: 10,
    }),
    event(5, 70, {
      component: "role",
      event: "turn.executed",
      status: "completed",
      phase: "planning",
      role: "planner:plan-1",
      threadId: "root",
      turnId: "turn-1",
      durationMs: 100,
      model: "gpt-5.6-sol",
      effort: "medium",
    }),
    event(6, 100, {
      component: "artifact",
      event: "artifact.written",
      status: "completed",
      role: "planner:plan-1",
      artifactKey: "plan-1",
      payloadBytes: 200,
    }),
    event(7, 105, {
      component: "app-server",
      event: "thread.forked",
      status: "completed",
      threadId: "child",
      parentThreadId: "root",
      turnId: "turn-1",
    }),
    event(8, 110, {
      component: "app-server",
      event: "token.usage",
      status: "info",
      threadId: "child",
      turnId: "turn-1",
      totalTokens: 120,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
    }),
    event(9, 115, {
      component: "role",
      event: "turn.executed",
      status: "started",
      phase: "planning",
      role: "planner-correction:plan-1",
      threadId: "child",
    }),
    event(10, 150, {
      component: "app-server",
      event: "token.usage",
      status: "info",
      threadId: "child",
      turnId: "turn-2",
      totalTokens: 200,
      inputTokens: 165,
      cachedInputTokens: 70,
      outputTokens: 35,
      reasoningTokens: 10,
    }),
    event(11, 155, {
      component: "app-server",
      event: "item.completed",
      status: "failed",
      threadId: "child",
      turnId: "turn-2",
      itemType: "commandExecution",
      toolFailed: true,
      durationMs: 5,
    }),
    event(12, 165, {
      component: "role",
      event: "turn.executed",
      status: "completed",
      phase: "planning",
      role: "planner-correction:plan-1",
      threadId: "child",
      turnId: "turn-2",
      durationMs: 50,
      model: "gpt-5.6-sol",
      effort: "medium",
    }),
    event(13, 170, {
      component: "command",
      event: "command.executed",
      status: "started",
      phase: "planning",
      commandId: "test",
    }),
    event(14, 200, {
      component: "command",
      event: "command.executed",
      status: "failed",
      phase: "planning",
      commandId: "test",
      durationMs: 30,
      timedOut: true,
      exitCode: null,
    }),
    event(15, 200, {
      component: "workflow",
      event: "phase.finished",
      status: "completed",
      phase: "planning",
    }),
  ];

  const analytics = analyzeTrace(events);
  assert.equal(analytics.traceWallTimeMs, 200);
  assert.equal(analytics.modelTimeMs, 150);
  assert.equal(analytics.commandTimeMs, 30);
  assert.equal(analytics.commands, 1);
  assert.equal(analytics.commandFailures, 1);
  assert.equal(analytics.commandTimeouts, 1);
  assert.equal(analytics.artifactBytes, 200);
  assert.equal(analytics.toolCalls, 2);
  assert.equal(analytics.toolFailures, 1);
  assert.equal(analytics.turns, 2);
  assert.equal(analytics.correctionTurns, 1);
  assert.deepEqual(analytics.tokens, {
    totalTokens: 200,
    inputTokens: 165,
    cachedInputTokens: 70,
    nonCachedInputTokens: 95,
    outputTokens: 35,
    reasoningTokens: 10,
    cacheHitRatio: 70 / 165,
  });
  assert.deepEqual(analytics.roleTurns[1]?.tokens, {
    totalTokens: 80,
    inputTokens: 65,
    cachedInputTokens: 30,
    nonCachedInputTokens: 35,
    outputTokens: 15,
    reasoningTokens: 5,
    cacheHitRatio: 30 / 65,
  });
  assert.equal(analytics.roleTurns[0]?.artifactBytes, 200);
  assert.equal(analytics.phases[0]?.wallTimeMs, 200);
  assert.equal(analytics.phases[0]?.toolFailures, 1);
});

test("marks fork token metrics unavailable when the inherited baseline is absent", () => {
  const events = [
    event(1, 0, {
      component: "app-server",
      event: "thread.forked",
      status: "completed",
      threadId: "child",
      parentThreadId: "root",
      turnId: "root-turn",
    }),
    event(2, 10, {
      component: "app-server",
      event: "token.usage",
      status: "info",
      threadId: "child",
      turnId: "child-turn",
      totalTokens: 200,
      inputTokens: 150,
      cachedInputTokens: 50,
      outputTokens: 50,
      reasoningTokens: 20,
    }),
    event(3, 20, {
      component: "role",
      event: "turn.executed",
      status: "completed",
      phase: "verification",
      role: "verifier",
      threadId: "child",
      turnId: "child-turn",
      durationMs: 20,
    }),
  ];

  assert.equal(analyzeTrace(events).tokens.totalTokens, null);
  assert.equal(analyzeTrace(events).tokens.cachedInputTokens, null);
});

test("does not derive a cache ratio from inconsistent provider counters", () => {
  const tokens = normalizeTokenMetrics({
    inputTokens: 10,
    cachedInputTokens: 11,
    outputTokens: 2,
    reasoningTokens: 1,
  });
  assert.equal(tokens.totalTokens, 12);
  assert.equal(tokens.nonCachedInputTokens, null);
  assert.equal(tokens.cacheHitRatio, null);
});
