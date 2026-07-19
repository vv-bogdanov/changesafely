import { analyzeTrace, normalizeTokenMetrics } from "../../src/run-analytics.js";
import type { TraceEvent } from "../../src/trace.js";
import { contentSha256 } from "./evidence.js";
import type { ProcessInvocation } from "./process.js";

interface AdapterOptions {
  program: string;
  prefixArgs?: string[];
  workspace: string;
  taskText: string;
  model: string;
  effort: string;
  permissionProfile: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export interface DirectEvidence {
  eventsJsonl: string;
  finalMessage: string;
  turns: number;
  usage: TokenUsage;
}

export interface ChangeSafelyOutcome {
  runId: string;
  status: string;
  reason: string;
  nextAction: string;
}

interface TokenUsage {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  nonCachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface UsageEvidence extends TokenUsage {
  turns: number;
}

export function directInvocation(options: AdapterOptions): ProcessInvocation {
  return {
    program: options.program,
    args: [
      ...(options.prefixArgs ?? []),
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-rules",
      "--model",
      options.model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(options.effort)}`,
      "-c",
      'approval_policy="never"',
      "-c",
      `default_permissions=${JSON.stringify(options.permissionProfile)}`,
      "-C",
      options.workspace,
      "-",
    ],
    cwd: options.workspace,
    stdin: options.taskText,
    env: options.env,
    timeoutMs: options.timeoutMs,
  };
}

export function changeSafelyInvocation(options: AdapterOptions): ProcessInvocation {
  return {
    program: options.program,
    args: [
      ...(options.prefixArgs ?? []),
      "run",
      "--task",
      options.taskText,
      "--plans",
      "3",
      "--model",
      options.model,
      "--permission-profile",
      options.permissionProfile,
      "--timeout",
      String(Math.ceil(options.timeoutMs / 1000)),
      "--repo",
      options.workspace,
      "--json",
    ],
    cwd: options.workspace,
    env: options.env,
    timeoutMs: options.timeoutMs + 5_000,
  };
}

export function parseDirectEvidence(output: string): DirectEvidence {
  const safeEvents: unknown[] = [];
  let finalMessage = "";
  let turns = 0;
  let usage: TokenUsage = emptyUsage();
  for (const line of output.split("\n").filter(Boolean)) {
    const event = parseRecord(line, "Direct JSONL event");
    const type = stringValue(event.type, "Direct event type");
    if (type === "turn.completed") {
      turns += 1;
      usage = directUsage(event.usage);
    }
    if (type === "item.completed" && recordValue(event.item)?.type === "agent_message") {
      const text = recordValue(event.item)?.text;
      if (typeof text === "string") finalMessage = text.slice(0, 50_000);
    }
    safeEvents.push(sanitizeDirectEvent(type, event));
  }
  if (!finalMessage) throw new Error("Direct runtime did not emit a final agent message");
  return {
    eventsJsonl: `${safeEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    finalMessage,
    turns,
    usage,
  };
}

export function parseChangeSafelyOutcome(output: string): ChangeSafelyOutcome {
  const value = parseRecord(output, "ChangeSafely outcome");
  return {
    runId: stringValue(value.runId, "ChangeSafely run id"),
    status: stringValue(value.status, "ChangeSafely status"),
    reason: stringValue(value.reason, "ChangeSafely reason").slice(0, 10_000),
    nextAction: stringValue(value.nextAction, "ChangeSafely next action").slice(0, 10_000),
  };
}

export function changeSafelyUsage(events: readonly TraceEvent[]): UsageEvidence {
  const analytics = analyzeTrace(events);
  return {
    turns: analytics.turns,
    totalTokens: analytics.tokens.totalTokens,
    inputTokens: analytics.tokens.inputTokens,
    cachedInputTokens: analytics.tokens.cachedInputTokens,
    nonCachedInputTokens: analytics.tokens.nonCachedInputTokens,
    outputTokens: analytics.tokens.outputTokens,
    reasoningTokens: analytics.tokens.reasoningTokens,
  };
}

function sanitizeDirectEvent(type: string, event: Record<string, unknown>): unknown {
  const base: Record<string, unknown> = { type };
  for (const key of ["thread_id", "turn_id"]) {
    if (typeof event[key] === "string") base[key] = event[key];
  }
  if (type === "turn.completed") {
    base.usage = directUsage(event.usage);
    return base;
  }
  if (type === "item.completed") {
    const item = recordValue(event.item);
    const itemType = typeof item?.type === "string" ? item.type : "unknown";
    const safeItem: Record<string, unknown> = { type: itemType };
    if (typeof item?.id === "string") safeItem.id = item.id;
    if (itemType === "agent_message" && typeof item?.text === "string") {
      safeItem.text = item.text.slice(0, 50_000);
    } else if (itemType === "command_execution") {
      if (typeof item?.command === "string") safeItem.command = item.command.slice(0, 8_000);
      if (typeof item?.exit_code === "number") safeItem.exitCode = item.exit_code;
      const output = typeof item?.aggregated_output === "string" ? item.aggregated_output : "";
      safeItem.outputBytes = Buffer.byteLength(output);
      safeItem.outputSha256 = contentSha256(output);
    } else if (item) {
      const serialized = JSON.stringify(item);
      safeItem.payloadBytes = Buffer.byteLength(serialized);
      safeItem.payloadSha256 = contentSha256(serialized);
    }
    base.item = safeItem;
  }
  if (type === "error" && typeof event.message === "string") {
    base.message = event.message.slice(0, 2_000);
  }
  return base;
}

function directUsage(value: unknown): TokenUsage {
  const usage = recordValue(value);
  const normalized = normalizeTokenMetrics({
    totalTokens: nullableInteger(usage?.total_tokens),
    inputTokens: nullableInteger(usage?.input_tokens),
    cachedInputTokens: nullableInteger(usage?.cached_input_tokens),
    nonCachedInputTokens: nullableInteger(usage?.non_cached_input_tokens),
    outputTokens: nullableInteger(usage?.output_tokens),
    reasoningTokens: nullableInteger(usage?.reasoning_output_tokens),
  });
  return {
    totalTokens: normalized.totalTokens,
    inputTokens: normalized.inputTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    nonCachedInputTokens: normalized.nonCachedInputTokens,
    outputTokens: normalized.outputTokens,
    reasoningTokens: normalized.reasoningTokens,
  };
}

function emptyUsage(): TokenUsage {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    nonCachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  };
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseRecord(content: string, description: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    const record = recordValue(value);
    if (!record) throw new Error(`${description} must be an object`);
    return record;
  } catch (error) {
    throw new Error(
      `Invalid ${description}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown, description: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${description} is missing`);
  return value;
}
