import type { TraceEvent } from "./trace.js";

const RUN_ANALYTICS_VERSION = 1;

export interface TokenMetrics {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  nonCachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheHitRatio: number | null;
}

interface RoleTurnAnalytics {
  role: string;
  phase: string;
  status: "completed" | "failed" | "blocked";
  model: string | null;
  effort: string | null;
  durationMs: number | null;
  artifactBytes: number | null;
  toolCalls: number | null;
  toolFailures: number | null;
  tokens: TokenMetrics;
}

interface PhaseAnalytics {
  phase: string;
  wallTimeMs: number | null;
  modelTimeMs: number;
  commandTimeMs: number;
  commands: number;
  commandFailures: number;
  commandTimeouts: number;
  toolCalls: number | null;
  toolFailures: number | null;
  turns: number;
  tokens: TokenMetrics;
}

export interface RunAnalytics {
  analyticsVersion: typeof RUN_ANALYTICS_VERSION;
  traceWallTimeMs: number | null;
  modelTimeMs: number;
  commandTimeMs: number;
  commands: number;
  commandFailures: number;
  commandTimeouts: number;
  artifactBytes: number | null;
  toolCalls: number | null;
  toolFailures: number | null;
  turns: number;
  correctionTurns: number;
  tokens: TokenMetrics;
  phases: PhaseAnalytics[];
  roleTurns: RoleTurnAnalytics[];
}

type CumulativeTokenKey =
  | "totalTokens"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningTokens";

type CumulativeTokenMetrics = Pick<TokenMetrics, CumulativeTokenKey>;

const tokenKeys = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
] as const satisfies readonly CumulativeTokenKey[];

interface TokenSnapshot extends CumulativeTokenMetrics {
  turnId: string;
}

interface PhaseAccumulator {
  firstSeq: number;
  completedWallTimeMs: number;
  openStarts: number[];
}

interface CommandAnalytics {
  timeMs: number;
  commands: number;
  failures: number;
  timeouts: number;
}

interface ToolAnalytics {
  calls: number | null;
  failures: number | null;
}

export function analyzeTrace(events: readonly TraceEvent[]): RunAnalytics {
  const snapshotsByThread = collectTokenSnapshots(events);
  const forkedThreads = new Set(
    events
      .filter((event) => event.event === "thread.forked" && event.threadId)
      .map((event) => event.threadId as string),
  );
  const roleTurns = events
    .filter((event) => event.event === "turn.executed" && event.status !== "started" && event.role)
    .map((event) => roleTurnAnalytics(event, events, snapshotsByThread, forkedThreads));
  const phaseTimes = collectPhaseTimes(events);
  const commandAnalytics = collectCommandAnalytics(events);
  const phaseNames = new Set<string>([
    ...phaseTimes.keys(),
    ...commandAnalytics.keys(),
    ...roleTurns.map((turn) => turn.phase),
  ]);
  const phases = [...phaseNames]
    .map((phase) => {
      const turns = roleTurns.filter((turn) => turn.phase === phase);
      const commands = commandAnalytics.get(phase) ?? emptyCommandAnalytics();
      return {
        phase,
        wallTimeMs: phaseTimes.get(phase) ?? null,
        modelTimeMs: sumDurations(turns.map((turn) => turn.durationMs)),
        commandTimeMs: commands.timeMs,
        commands: commands.commands,
        commandFailures: commands.failures,
        commandTimeouts: commands.timeouts,
        toolCalls: sumNullableCounts(turns.map((turn) => turn.toolCalls)),
        toolFailures: sumNullableCounts(turns.map((turn) => turn.toolFailures)),
        turns: turns.length,
        tokens: sumTokenMetrics(turns.map((turn) => turn.tokens)),
      } satisfies PhaseAnalytics;
    })
    .sort((left, right) => phaseOrder(events, left.phase) - phaseOrder(events, right.phase));

  return {
    analyticsVersion: RUN_ANALYTICS_VERSION,
    traceWallTimeMs: traceWallTime(events),
    modelTimeMs: sumDurations(roleTurns.map((turn) => turn.durationMs)),
    commandTimeMs: [...commandAnalytics.values()].reduce((total, value) => total + value.timeMs, 0),
    commands: [...commandAnalytics.values()].reduce((total, value) => total + value.commands, 0),
    commandFailures: [...commandAnalytics.values()].reduce(
      (total, value) => total + value.failures,
      0,
    ),
    commandTimeouts: [...commandAnalytics.values()].reduce(
      (total, value) => total + value.timeouts,
      0,
    ),
    artifactBytes: artifactBytes(events),
    toolCalls: sumNullableCounts(roleTurns.map((turn) => turn.toolCalls)),
    toolFailures: sumNullableCounts(roleTurns.map((turn) => turn.toolFailures)),
    turns: roleTurns.length,
    correctionTurns: roleTurns.filter((turn) => turn.role.includes("correction")).length,
    tokens: sumTokenMetrics(roleTurns.map((turn) => turn.tokens)),
    phases,
    roleTurns,
  };
}

export function normalizeTokenMetrics(input: {
  totalTokens?: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  nonCachedInputTokens?: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}): TokenMetrics {
  const nonCachedInputTokens =
    input.nonCachedInputTokens ?? subtractAvailable(input.inputTokens, input.cachedInputTokens);
  return {
    totalTokens: input.totalTokens ?? addAvailable(input.inputTokens, input.outputTokens),
    inputTokens: input.inputTokens,
    cachedInputTokens: input.cachedInputTokens,
    nonCachedInputTokens,
    outputTokens: input.outputTokens,
    reasoningTokens: input.reasoningTokens,
    cacheHitRatio:
      input.inputTokens === null ||
      input.inputTokens === 0 ||
      input.cachedInputTokens === null ||
      input.cachedInputTokens > input.inputTokens
        ? null
        : input.cachedInputTokens / input.inputTokens,
  };
}

function collectTokenSnapshots(events: readonly TraceEvent[]): Map<string, TokenSnapshot[]> {
  const byThread = new Map<string, TokenSnapshot[]>();
  for (const event of events) {
    if (event.event !== "token.usage" || !event.threadId || !event.turnId) continue;
    const snapshots = byThread.get(event.threadId) ?? [];
    const snapshot = tokenSnapshot(event);
    const existing = snapshots.findIndex((entry) => entry.turnId === event.turnId);
    if (existing === -1) snapshots.push(snapshot);
    else snapshots[existing] = snapshot;
    byThread.set(event.threadId, snapshots);
  }
  return byThread;
}

function tokenSnapshot(event: TraceEvent): TokenSnapshot {
  return {
    turnId: event.turnId as string,
    totalTokens: event.totalTokens ?? null,
    inputTokens: event.inputTokens ?? null,
    cachedInputTokens: event.cachedInputTokens ?? null,
    outputTokens: event.outputTokens ?? null,
    reasoningTokens: event.reasoningTokens ?? null,
  };
}

function roleTurnAnalytics(
  event: TraceEvent,
  events: readonly TraceEvent[],
  snapshotsByThread: ReadonlyMap<string, TokenSnapshot[]>,
  forkedThreads: ReadonlySet<string>,
): RoleTurnAnalytics {
  const threadId = event.threadId;
  const turnId = event.turnId;
  const snapshots = threadId ? (snapshotsByThread.get(threadId) ?? []) : [];
  const currentIndex = turnId ? snapshots.findIndex((snapshot) => snapshot.turnId === turnId) : -1;
  const current = currentIndex >= 0 ? snapshots[currentIndex] : undefined;
  const previous = currentIndex > 0 ? snapshots[currentIndex - 1] : undefined;
  const baselineMissing = Boolean(threadId && forkedThreads.has(threadId) && !previous);
  const tools = collectToolAnalytics(events, threadId, turnId);
  return {
    role: event.role ?? "unknown",
    phase: event.phase ?? "unknown",
    status: event.status === "completed" || event.status === "blocked" ? event.status : "failed",
    model: event.model ?? null,
    effort: event.effort ?? null,
    durationMs: event.durationMs ?? null,
    artifactBytes: turnArtifactBytes(events, event),
    toolCalls: tools.calls,
    toolFailures: tools.failures,
    tokens: current && !baselineMissing ? tokenDelta(current, previous) : unavailableTokens(),
  };
}

function tokenDelta(current: TokenSnapshot, previous?: TokenSnapshot): TokenMetrics {
  const delta = Object.fromEntries(
    tokenKeys.map((key) => [key, subtractAvailable(current[key], previous?.[key] ?? 0)]),
  ) as CumulativeTokenMetrics;
  return normalizeTokenMetrics(delta);
}

function collectPhaseTimes(events: readonly TraceEvent[]): Map<string, number | null> {
  const phases = new Map<string, PhaseAccumulator>();
  for (const event of events) {
    if (!event.phase || (event.event !== "phase.started" && event.event !== "phase.finished")) {
      continue;
    }
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const phase = phases.get(event.phase) ?? {
      firstSeq: event.seq,
      completedWallTimeMs: 0,
      openStarts: [],
    };
    phase.firstSeq = Math.min(phase.firstSeq, event.seq);
    if (event.event === "phase.started") phase.openStarts.push(timestamp);
    else {
      const startedAt = phase.openStarts.pop();
      if (startedAt !== undefined && timestamp >= startedAt) {
        phase.completedWallTimeMs += timestamp - startedAt;
      }
    }
    phases.set(event.phase, phase);
  }
  return new Map(
    [...phases].map(([phase, value]) => [
      phase,
      value.openStarts.length === 0 ? value.completedWallTimeMs : null,
    ]),
  );
}

function collectCommandAnalytics(events: readonly TraceEvent[]): Map<string, CommandAnalytics> {
  const commands = new Map<string, CommandAnalytics>();
  for (const event of events) {
    if (
      event.component !== "command" ||
      event.event !== "command.executed" ||
      event.status === "started" ||
      !event.phase ||
      event.durationMs === undefined
    ) {
      continue;
    }
    const value = commands.get(event.phase) ?? emptyCommandAnalytics();
    value.timeMs += event.durationMs;
    value.commands += 1;
    if (event.status !== "completed") value.failures += 1;
    if (event.timedOut) value.timeouts += 1;
    commands.set(event.phase, value);
  }
  return commands;
}

function emptyCommandAnalytics(): CommandAnalytics {
  return { timeMs: 0, commands: 0, failures: 0, timeouts: 0 };
}

function collectToolAnalytics(
  events: readonly TraceEvent[],
  threadId: string | undefined,
  turnId: string | undefined,
): ToolAnalytics {
  if (!threadId || !turnId) return { calls: null, failures: null };
  const trackingAvailable = events.some(
    (event) => event.event === "thread.forked" || event.event === "item.completed",
  );
  if (!trackingAvailable) return { calls: null, failures: null };
  const matching = events.filter(
    (event) =>
      event.component === "app-server" &&
      event.event === "item.completed" &&
      event.threadId === threadId &&
      event.turnId === turnId,
  );
  return {
    calls: matching.length,
    failures: matching.filter((event) => event.toolFailed).length,
  };
}

function artifactBytes(events: readonly TraceEvent[]): number | null {
  const artifacts = events.filter(
    (event) => event.component === "artifact" && event.event === "artifact.written",
  );
  if (artifacts.some((event) => event.payloadBytes === undefined)) return null;
  return artifacts.reduce((total, event) => total + (event.payloadBytes ?? 0), 0);
}

function turnArtifactBytes(events: readonly TraceEvent[], turn: TraceEvent): number | null {
  const nextTurn = events.find(
    (event) =>
      event.seq > turn.seq &&
      event.component === "role" &&
      event.event === "turn.executed" &&
      event.status !== "started" &&
      event.role === turn.role,
  );
  const artifacts = events.filter(
    (event) =>
      event.seq > turn.seq &&
      event.seq < (nextTurn?.seq ?? Number.POSITIVE_INFINITY) &&
      event.component === "artifact" &&
      event.event === "artifact.written" &&
      event.role === turn.role,
  );
  if (artifacts.some((event) => event.payloadBytes === undefined)) return null;
  return artifacts.reduce((total, event) => total + (event.payloadBytes ?? 0), 0);
}

function sumNullableCounts(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function traceWallTime(events: readonly TraceEvent[]): number | null {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return null;
  const startedAt = Date.parse(first.timestamp);
  const completedAt = Date.parse(last.timestamp);
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? completedAt - startedAt
    : null;
}

function phaseOrder(events: readonly TraceEvent[], phase: string): number {
  return events.find((event) => event.phase === phase)?.seq ?? Number.MAX_SAFE_INTEGER;
}

function sumDurations(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function sumTokenMetrics(values: readonly TokenMetrics[]): TokenMetrics {
  if (values.length === 0) return unavailableTokens();
  const cumulative = Object.fromEntries(
    tokenKeys.map((key) => [
      key,
      values.some((value) => value[key] === null)
        ? null
        : values.reduce<number>((total, value) => total + (value[key] ?? 0), 0),
    ]),
  ) as CumulativeTokenMetrics;
  return normalizeTokenMetrics(cumulative);
}

function unavailableTokens(): TokenMetrics {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    nonCachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheHitRatio: null,
  };
}

function subtractAvailable(left: number | null, right: number | null): number | null {
  if (left === null || right === null || left < right) return null;
  return left - right;
}

function addAvailable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}
