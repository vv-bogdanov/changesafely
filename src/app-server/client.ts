import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  createJSONRPCErrorResponse,
  JSONRPCClient,
  JSONRPCErrorException,
  type JSONRPCRequest,
  type JSONRPCResponse,
  JSONRPCServer,
  JSONRPCServerAndClient,
} from "json-rpc-2.0";
import { safeEnvironment } from "../environment.js";
import { VERSION } from "../version.js";
import type { InitializeParams } from "./generated/types/InitializeParams.js";
import type { InitializeResponse } from "./generated/types/InitializeResponse.js";
import type { JsonValue } from "./generated/types/serde_json/JsonValue.js";
import type { ItemCompletedNotification } from "./generated/types/v2/ItemCompletedNotification.js";
import type { SandboxPolicy } from "./generated/types/v2/SandboxPolicy.js";
import type { ThreadForkParams } from "./generated/types/v2/ThreadForkParams.js";
import type { ThreadForkResponse } from "./generated/types/v2/ThreadForkResponse.js";
import type { ThreadResumeParams } from "./generated/types/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/types/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/types/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/types/v2/ThreadStartResponse.js";
import type { TurnCompletedNotification } from "./generated/types/v2/TurnCompletedNotification.js";
import type { TurnInterruptParams } from "./generated/types/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./generated/types/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/types/v2/TurnStartResponse.js";

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface TurnWaiter {
  resolve(notification: TurnCompletedNotification): void;
  reject(error: Error): void;
}

export interface AppServerClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RunTurnOptions {
  cwd: string;
  sandboxPolicy: SandboxPolicy;
  outputSchema?: object;
  timeoutMs?: number;
  effort?: string;
  model?: string;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  status: string;
  message: string;
}

export class AppServerError extends Error {
  constructor(
    message: string,
    public readonly rpcError?: RpcError,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function withoutVersion(message: JSONRPCRequest | JSONRPCResponse): object {
  const { jsonrpc: _, ...appServerMessage } = message;
  return appServerMessage;
}

function isRpcId(value: unknown): value is number | string {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function validateRpcError(value: unknown): RpcError | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    !Number.isFinite(value.code) ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    ...(hasOwn(value, "data") ? { data: value.data } : {}),
  };
}

function validateInitializeResponse(value: unknown): InitializeResponse {
  if (
    !isRecord(value) ||
    typeof value.userAgent !== "string" ||
    typeof value.codexHome !== "string" ||
    typeof value.platformFamily !== "string" ||
    typeof value.platformOs !== "string"
  ) {
    throw new AppServerError("Invalid initialize response from App Server");
  }
  return value as unknown as InitializeResponse;
}

function validateThreadResponse<T>(value: unknown, method: string): T {
  if (!isRecord(value) || !isRecord(value.thread) || typeof value.thread.id !== "string") {
    throw new AppServerError(`Invalid ${method} response from App Server`);
  }
  return value as T;
}

function validateTurnStartResponse(value: unknown): TurnStartResponse {
  if (!isRecord(value) || !isRecord(value.turn) || typeof value.turn.id !== "string") {
    throw new AppServerError("Invalid turn/start response from App Server");
  }
  return value as unknown as TurnStartResponse;
}

function validateItemCompleted(value: unknown): ItemCompletedNotification | undefined {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.completedAtMs !== "number" ||
    !isRecord(value.item) ||
    typeof value.item.type !== "string"
  ) {
    return undefined;
  }
  if (value.item.type === "agentMessage" && typeof value.item.text !== "string") {
    return undefined;
  }
  return value as unknown as ItemCompletedNotification;
}

function validateTurnCompleted(value: unknown): TurnCompletedNotification | undefined {
  if (!isRecord(value) || typeof value.threadId !== "string" || !isRecord(value.turn)) {
    return undefined;
  }
  const turn = value.turn;
  const validStatus = ["completed", "interrupted", "failed", "inProgress"].includes(
    String(turn.status),
  );
  const validItems =
    Array.isArray(turn.items) &&
    turn.items.every(
      (item) =>
        isRecord(item) &&
        typeof item.type === "string" &&
        (item.type !== "agentMessage" || typeof item.text === "string"),
    );
  const validError =
    turn.error === null || (isRecord(turn.error) && typeof turn.error.message === "string");
  const nullableNumber = (item: unknown) => item === null || typeof item === "number";
  if (
    typeof turn.id !== "string" ||
    !validStatus ||
    !validItems ||
    !["notLoaded", "summary", "full"].includes(String(turn.itemsView)) ||
    !validError ||
    !nullableNumber(turn.startedAt) ||
    !nullableNumber(turn.completedAt) ||
    !nullableNumber(turn.durationMs)
  ) {
    return undefined;
  }
  return value as unknown as TurnCompletedNotification;
}

export class AppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private readonly rpc: JSONRPCServerAndClient;
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly completedTurns = new Map<string, TurnCompletedNotification>();
  private readonly agentMessages = new Map<string, string>();
  private fatalError: AppServerError | undefined;
  private abortListener: (() => void) | undefined;

  constructor(private readonly options: AppServerClientOptions = {}) {
    const server = new JSONRPCServer({
      errorListener: (message) => this.failProtocol(message),
    });
    server.addMethod("item/completed", (params) =>
      this.handleNotification("item/completed", params),
    );
    server.addMethod("turn/completed", (params) =>
      this.handleNotification("turn/completed", params),
    );
    const client = new JSONRPCClient((message) => this.write(withoutVersion(message)));
    this.rpc = new JSONRPCServerAndClient(server, client, {
      errorListener: (message) => this.failProtocol(message),
    });
  }

  async start(): Promise<InitializeResponse> {
    if (this.process) {
      throw new AppServerError("App Server is already started");
    }
    if (this.options.signal?.aborted) {
      throw new AppServerError("App Server start was aborted");
    }

    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    this.process = spawn(command, args, {
      cwd: this.options.cwd,
      env: safeEnvironment(this.options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("exit", (code, signal) =>
      this.failAll(new AppServerError(`App Server exited (${signal ?? String(code)})`)),
    );
    this.process.on("error", (error) => this.failAll(new AppServerError(error.message)));
    this.process.stderr.resume();

    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.abortListener = () => {
      this.failAll(new AppServerError("App Server operation was aborted"));
      void this.close();
    };
    this.options.signal?.addEventListener("abort", this.abortListener, { once: true });

    const params: InitializeParams = {
      clientInfo: {
        name: "safechange",
        title: "SafeChange",
        version: VERSION,
      },
      capabilities: null,
    };
    const initialized = validateInitializeResponse(
      await this.request<InitializeResponse>("initialize", params),
    );
    this.notify("initialized", {});
    return initialized;
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.request("thread/start", params).then((value) =>
      validateThreadResponse<ThreadStartResponse>(value, "thread/start"),
    );
  }

  forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> {
    return this.request("thread/fork", params).then((value) =>
      validateThreadResponse<ThreadForkResponse>(value, "thread/fork"),
    );
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params).then((value) =>
      validateThreadResponse<ThreadResumeResponse>(value, "thread/resume"),
    );
  }

  async runTurn(threadId: string, prompt: string, options: RunTurnOptions): Promise<TurnResult> {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: options.cwd,
      approvalPolicy: "never",
      sandboxPolicy: options.sandboxPolicy,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema as JsonValue } : {}),
    };
    const started = validateTurnStartResponse(
      await this.request<TurnStartResponse>("turn/start", params),
    );
    const turnId = started.turn.id;

    let completion: TurnCompletedNotification;
    try {
      completion = await this.waitForTurn(
        turnId,
        options.timeoutMs ?? this.options.turnTimeoutMs ?? 300_000,
      );
    } catch (error) {
      this.agentMessages.delete(turnId);
      const interrupt: TurnInterruptParams = { threadId, turnId };
      await this.request("turn/interrupt", interrupt).catch(() => undefined);
      throw error;
    }

    if (completion.turn.status !== "completed") {
      this.agentMessages.delete(turnId);
      throw new AppServerError(
        `Turn ${turnId} ended with ${completion.turn.status}: ${completion.turn.error?.message ?? "no details"}`,
      );
    }

    const completedMessage = [...completion.turn.items]
      .reverse()
      .find((item) => item.type === "agentMessage");
    const message =
      completedMessage?.type === "agentMessage"
        ? completedMessage.text
        : (this.agentMessages.get(turnId) ?? "");
    this.agentMessages.delete(turnId);

    return {
      threadId,
      turnId,
      status: completion.turn.status,
      message,
    };
  }

  async close(): Promise<void> {
    if (this.abortListener) {
      this.options.signal?.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
    const child = this.process;
    if (!child) return;

    this.lines?.close();
    this.process = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    try {
      return (await this.rpc.client
        .timeout(this.options.requestTimeoutMs ?? 10_000, (id) =>
          createJSONRPCErrorResponse(id, -32_000, `App Server request ${method} timed out`),
        )
        .request(method, params)) as T;
    } catch (error) {
      if (error instanceof JSONRPCErrorException) {
        throw new AppServerError(error.message, {
          code: error.code,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        });
      }
      throw error;
    }
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.process?.stdin.writable) {
      throw new AppServerError("App Server stdin is not writable");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failProtocol("Invalid JSON from App Server");
      return;
    }

    if (!isRecord(message)) {
      this.failProtocol("Invalid message from App Server");
      return;
    }

    if (hasOwn(message, "id") && typeof message.method === "string") {
      if (!isRpcId(message.id)) {
        this.failProtocol("Invalid request id from App Server");
        return;
      }
    } else if (hasOwn(message, "id")) {
      if (!isRpcId(message.id) || (!hasOwn(message, "result") && !hasOwn(message, "error"))) {
        this.failProtocol("Invalid response from App Server");
        return;
      }
      if (hasOwn(message, "error") && !validateRpcError(message.error)) {
        this.failProtocol("Invalid error response from App Server");
        return;
      }
    } else if (typeof message.method !== "string") {
      this.failProtocol("Invalid notification from App Server");
      return;
    }

    void this.rpc
      .receiveAndSend({ jsonrpc: "2.0", ...message } as JSONRPCRequest | JSONRPCResponse)
      .catch((error) =>
        this.failProtocol(error instanceof Error ? error.message : "Invalid JSON-RPC message"),
      );
  }

  private handleNotification(method: string, value: unknown): void {
    if (method === "item/completed") {
      const params = validateItemCompleted(value);
      if (!params) {
        this.failProtocol("Invalid item/completed notification from App Server");
        return;
      }
      if (params.item.type === "agentMessage") {
        this.agentMessages.set(params.turnId, params.item.text);
      }
      return;
    }

    if (method !== "turn/completed") return;
    const params = validateTurnCompleted(value);
    if (!params) {
      this.failProtocol("Invalid turn/completed notification from App Server");
      return;
    }
    const waiter = this.turnWaiters.get(params.turn.id);
    if (waiter) {
      this.turnWaiters.delete(params.turn.id);
      waiter.resolve(params);
    } else {
      this.completedTurns.set(params.turn.id, params);
      if (this.completedTurns.size > 100) {
        const oldest = this.completedTurns.keys().next().value;
        if (typeof oldest === "string") this.completedTurns.delete(oldest);
      }
    }
  }

  private waitForTurn(turnId: string, timeoutMs: number): Promise<TurnCompletedNotification> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new AppServerError(`Turn ${turnId} timed out`));
      }, timeoutMs);
      this.turnWaiters.set(turnId, {
        resolve: (notification) => {
          clearTimeout(timer);
          resolve(notification);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private failAll(error: Error): void {
    this.rpc.rejectAllPendingRequests(error.message);
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
  }

  private failProtocol(message: string): void {
    const error = new AppServerError(message);
    this.fatalError = error;
    this.failAll(error);
    void this.close();
  }
}
