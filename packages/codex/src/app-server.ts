import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolPermissionHandler } from "@catamorphic/sandbox";
import {
  agentQuestionDescription,
  agentQuestionInputSchema,
  agentQuestionJsonSchema,
  type TurnOptions,
} from "@catamorphic/sandbox";
import type {
  CodexOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  UserInput,
} from "@openai/codex-sdk";

export type CodexElicitation = {
  serverName: string;
  mode: string;
  message: string;
  requestedSchema?: unknown;
  url?: string;
  elicitationId?: string;
  _meta?: unknown;
};
export type CodexElicitationResult = {
  action: "accept" | "decline" | "cancel";
  content?: unknown;
  _meta?: unknown;
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Native bidirectional Codex protocol. Owns MCP children for the session lifetime. */
export class CodexAppServer {
  private context?: string;
  private turnOptions?: TurnOptions;
  private running = false;
  private turnEpoch = 0;
  private activeSignal?: AbortSignal;
  private requestAbort?: AbortController;
  private idleTimer?: ReturnType<typeof setTimeout>;
  get available() {
    return !this.failure;
  }
  setContext(context: string | undefined) {
    this.context = context;
  }
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private sequence = 0;
  private initialized?: Promise<void>;
  private failure?: Error;
  private notify?: (method: string, params: Record<string, unknown>) => void;
  constructor(
    private options: CodexOptions,
    private elicit?: (
      request: CodexElicitation,
      signal?: AbortSignal,
    ) => Promise<CodexElicitationResult>,
    private approve?: ToolPermissionHandler,
    private hostSessionId?: string,
  ) {}

  private async ready() {
    this.initialized ??= this.initialize().catch((error) => {
      this.close();
      throw error;
    });
    await this.initialized;
    if (this.failure) throw this.failure;
  }
  private async initialize() {
    const command =
      this.options.codexPathOverride ??
      path.join(
        path.dirname(
          createRequire(import.meta.resolve("@openai/codex-sdk")).resolve(
            "@openai/codex/package.json",
          ),
        ),
        "bin/codex.js",
      );
    const args = ["app-server"];
    // The public CLI accepts TOML scalar/table values, not JSON objects.
    const toml = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
      if (object(value))
        return `{${Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`)
          .join(",")}}`;
      if (value === null || value === undefined)
        throw new Error("Codex config values cannot be null");
      return JSON.stringify(value);
    };
    for (const [key, value] of Object.entries(this.options.config ?? {}))
      if (value !== undefined) args.push("-c", `${key}=${toml(value)}`);
    if (this.options.apiKey) {
      const provider =
        typeof this.options.config?.model_provider === "string"
          ? this.options.config.model_provider
          : "openai";
      args.push(
        "-c",
        `model_providers.${provider}.env_key="CODEX_API_KEY"`,
        "-c",
        `model_providers.${provider}.requires_openai_auth=false`,
      );
    }
    this.child = spawn(command, args, {
      env: {
        ...process.env,
        ...this.options.env,
        ...(this.options.apiKey ? { CODEX_API_KEY: this.options.apiKey } : {}),
        ...(this.options.baseUrl
          ? { OPENAI_BASE_URL: this.options.baseUrl }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Drain diagnostics without leaking credentials or duplicating model output.
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", () =>
      this.fail(new Error("Codex app server stopped. Retry the turn.")),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message: unknown = JSON.parse(line);
        if (!object(message)) return;
        if (typeof message.method === "string") {
          const params = object(message.params) ? message.params : {};
          if (typeof message.id === "number" || typeof message.id === "string")
            void this.respond(message.id, message.method, params);
          else this.notify?.(message.method, params);
        } else if (typeof message.id === "number") {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error)
            request.reject(
              new Error(
                object(message.error) &&
                  typeof message.error.message === "string"
                  ? message.error.message
                  : "Codex request failed",
              ),
            );
          else request.resolve(message.result);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    await this.request("initialize", {
      clientInfo: { name: "catamorphic", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }
  private send(value: unknown) {
    if (this.failure) throw this.failure;
    this.child?.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private acceptsRequests() {
    return !!this.notify && !this.failure && !this.activeSignal?.aborted;
  }
  private async respond(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ) {
    const epoch = this.turnEpoch;
    const active = () => this.acceptsRequests() && epoch === this.turnEpoch;
    try {
      if (
        active() &&
        method === "item/tool/call" &&
        params.tool === "ask_user" &&
        this.turnOptions?.askQuestion
      ) {
        const input = agentQuestionInputSchema.parse(params.arguments);
        const text = await this.turnOptions.askQuestion({
          ...input,
          requestId: String(params.callId ?? id),
          signal: this.activeSignal,
        });
        this.send({
          id,
          result: {
            contentItems: [{ type: "inputText", text }],
            success: active(),
          },
        });
        return;
      }
      if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "item/permissions/requestApproval"
      ) {
        const decision = active()
          ? await this.approve?.(
              {
                sessionId: this.hostSessionId,
                server: "codex",
                tool: method,
                input: params,
                description:
                  typeof params.reason === "string"
                    ? params.reason
                    : "Codex requests permission",
              },
              this.activeSignal,
            )
          : undefined;
        const allowed = active() && decision?.decision === "allow";
        this.send({
          id,
          result:
            method === "item/permissions/requestApproval"
              ? {
                  permissions: allowed ? params.permissions : {},
                  scope: "turn",
                }
              : { decision: allowed ? "accept" : "decline" },
        });
        return;
      }
      if (
        !active() ||
        method !== "mcpServer/elicitation/request" ||
        typeof params.serverName !== "string" ||
        typeof params.message !== "string" ||
        typeof params.mode !== "string"
      ) {
        this.send({
          id,
          error: {
            code: -32601,
            message: `Unsupported client request: ${method}`,
          },
        });
        return;
      }
      const result = (await this.elicit?.(
        {
          serverName: params.serverName,
          message: params.message,
          mode: params.mode,
          requestedSchema: params.requestedSchema,
          ...(typeof params.url === "string" ? { url: params.url } : {}),
          ...(typeof params.elicitationId === "string"
            ? { elicitationId: params.elicitationId }
            : {}),
          _meta: params._meta,
        },
        this.activeSignal,
      )) ?? { action: "decline" };
      this.send({
        id,
        result: active()
          ? {
              ...result,
              content: result.content ?? null,
              _meta: result._meta ?? null,
            }
          : { action: "cancel", content: null, _meta: null },
      });
    } catch {
      if (!this.failure)
        this.send({
          id,
          error: {
            code: -32603,
            message: "Client request could not be completed",
          },
        });
    }
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.requestAbort?.abort();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.notify?.("transport/error", { message: error.message });
  }
  close() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    child?.stdin.end();
    child?.kill();
    if (child && child.exitCode === null) {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
    this.fail(new Error("Codex session closed."));
  }
  /** Read the native skill catalog without creating a thread or model turn. */
  async listSkills({ workingDirectory }: { workingDirectory: string }) {
    await this.ready();
    const result = await this.request("skills/list", {
      cwds: [workingDirectory],
      forceReload: true,
    });
    if (!object(result) || !Array.isArray(result.data))
      throw new Error("Codex returned an invalid skill catalog.");
    const skills: Array<{ name: string; description: string; path: string }> =
      [];
    for (const group of result.data) {
      if (!object(group) || !Array.isArray(group.skills))
        throw new Error("Codex returned an invalid skill catalog.");
      if (Array.isArray(group.errors) && group.errors.length > 0)
        throw new Error(
          "Codex could not load some skills. Check their SKILL.md files.",
        );
      for (const skill of group.skills) {
        if (!object(skill) || skill.enabled === false) continue;
        if (typeof skill.name !== "string" || typeof skill.path !== "string")
          throw new Error("Codex returned an invalid skill.");
        skills.push({
          name: skill.name,
          description:
            typeof skill.description === "string" ? skill.description : "",
          path: skill.path,
        });
      }
    }
    return skills;
  }
  startThread(options: ThreadOptions) {
    return this.thread(undefined, options);
  }
  resumeThread(id: string, options: ThreadOptions) {
    return this.thread(id, options);
  }
  private thread(id: string | undefined, options: ThreadOptions) {
    return {
      runStreamed: async (
        input: string | UserInput[],
        run: { signal?: AbortSignal; turnOptions?: TurnOptions },
      ) => ({
        events: this.run(id, options, input, run.signal, run.turnOptions),
      }),
    };
  }
  private async *run(
    id: string | undefined,
    options: ThreadOptions,
    input: string | UserInput[],
    signal?: AbortSignal,
    turnOptions?: TurnOptions,
  ): AsyncGenerator<ThreadEvent> {
    if (this.running)
      throw new Error("A Codex turn is already running in this session.");
    signal?.throwIfAborted();
    this.running = true;
    this.turnOptions = turnOptions;
    this.turnEpoch++;
    const requestAbort = new AbortController();
    this.requestAbort = requestAbort;
    this.activeSignal = requestAbort.signal;
    clearTimeout(this.idleTimer);
    const events: ThreadEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let threadId = id;
    let turnId: string | undefined;
    let usage = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      cache_write_input_tokens: 0,
    };
    const push = (event: ThreadEvent) => {
      events.push(event);
      wake?.();
    };
    this.notify = (method, params) => {
      if (method === "transport/error") {
        push({
          type: "turn.failed",
          error: { message: String(params.message) },
        });
        done = true;
        return;
      }
      if (params.threadId !== threadId) return;
      if (method === "error" && object(params.error))
        push({ type: "error", message: String(params.error.message) });
      if (
        (method === "item/started" || method === "item/completed") &&
        object(params.item)
      ) {
        const item = mapItem(params.item);
        if (item)
          push({
            type: method === "item/started" ? "item.started" : "item.completed",
            item,
          });
      }
      if (
        method === "thread/tokenUsage/updated" &&
        object(params.tokenUsage) &&
        object(params.tokenUsage.last)
      ) {
        const last = params.tokenUsage.last;
        usage = {
          input_tokens: Number(last.inputTokens) || 0,
          cached_input_tokens: Number(last.cachedInputTokens) || 0,
          output_tokens: Number(last.outputTokens) || 0,
          reasoning_output_tokens: Number(last.reasoningOutputTokens) || 0,
          cache_write_input_tokens: 0,
        };
      }
      if (method === "turn/completed" && object(params.turn)) {
        if (params.turn.status === "completed")
          push({ type: "turn.completed", usage });
        else
          push({
            type: "turn.failed",
            error: {
              message: object(params.turn.error)
                ? String(params.turn.error.message)
                : "Turn interrupted",
            },
          });
        done = true;
      }
    };
    let inputPump: Promise<void> | undefined;
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      requestAbort.abort();
      if (threadId && turnId) {
        void this.request("turn/interrupt", { threadId, turnId }).catch(() =>
          this.close(),
        );
        interruptTimer ??= setTimeout(() => this.close(), 5000);
        interruptTimer.unref();
      } else this.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.ready();
      signal?.throwIfAborted();
      const response = await this.request(
        id ? "thread/resume" : "thread/start",
        {
          ...(id ? { threadId: id, excludeTurns: true } : {}),
          ...(turnOptions?.askQuestion
            ? {
                dynamicTools: [
                  {
                    name: "ask_user",
                    description: agentQuestionDescription,
                    inputSchema: agentQuestionJsonSchema,
                  },
                ],
              }
            : {}),
          cwd: options.workingDirectory,
          model: options.model,
          sandbox: options.sandboxMode,
          approvalPolicy: options.approvalPolicy,
          developerInstructions: this.context ?? "",
          config: {
            "sandbox_workspace_write.network_access":
              options.networkAccessEnabled ?? true,
          },
        },
      );
      if (
        !object(response) ||
        !object(response.thread) ||
        typeof response.thread.id !== "string"
      )
        throw new Error("Codex returned an invalid thread.");
      threadId = response.thread.id;
      push({ type: "thread.started", thread_id: threadId });
      const started = await this.request("turn/start", {
        threadId,
        effort: options.modelReasoningEffort,
        input:
          typeof input === "string"
            ? [{ type: "text", text: input, text_elements: [] }]
            : input.map((part) =>
                part.type === "local_image"
                  ? { type: "localImage", path: part.path }
                  : { type: "text", text: part.text, text_elements: [] },
              ),
      });
      if (
        !object(started) ||
        !object(started.turn) ||
        typeof started.turn.id !== "string"
      )
        throw new Error("Codex returned an invalid turn.");
      turnId = started.turn.id;
      if (signal?.aborted) abort();
      if (turnOptions?.readPendingMessages) {
        const expectedTurnId = turnId;
        const targetThreadId = threadId;
        inputPump = (async () => {
          while (!done && !requestAbort.signal.aborted) {
            const pending = (await turnOptions.readPendingMessages?.()) ?? [];
            for (const entry of pending) {
              if (done || requestAbort.signal.aborted) return;
              try {
                await this.request("turn/steer", {
                  threadId: targetThreadId,
                  expectedTurnId,
                  input: [
                    { type: "text", text: entry.content, text_elements: [] },
                  ],
                });
              } catch (error) {
                // Completion can race a steer. Unaccepted input remains in the durable inbox.
                if (done || requestAbort.signal.aborted) return;
                throw error;
              }
              await turnOptions.acknowledgeMessages?.({ ids: [entry.id] });
            }
            await delay(100, undefined, { signal: requestAbort.signal });
          }
        })().catch((error) => {
          if (!requestAbort.signal.aborted)
            this.fail(
              error instanceof Error ? error : new Error(String(error)),
            );
        });
      }
      while (!done || events.length) {
        while (events.length) {
          const event = events.shift();
          if (event) yield event;
        }
        if (!done)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      requestAbort.abort();
      // Returning early or failing startup must not leave the native turn running.
      if (!done || this.failure) this.close();
      await inputPump;
      this.turnOptions = undefined;
      this.requestAbort = undefined;
      this.notify = undefined;
      clearTimeout(interruptTimer);
      this.running = false;
      this.turnEpoch++;
      this.activeSignal = undefined;
      if (!this.failure) {
        this.idleTimer = setTimeout(() => this.close(), 5 * 60 * 1000);
        this.idleTimer.unref();
      }
    }
  }
}

function mapItem(item: Record<string, unknown>): ThreadItem | undefined {
  if (typeof item.id !== "string") return;
  const id = item.id;
  switch (item.type) {
    case "agentMessage":
      return { type: "agent_message", id, text: String(item.text ?? "") };
    case "reasoning":
      return {
        type: "reasoning",
        id,
        text: Array.isArray(item.summary) ? item.summary.join("\n") : "",
      };
    case "commandExecution":
      return {
        type: "command_execution",
        id,
        command: String(item.command),
        aggregated_output: String(item.aggregatedOutput ?? ""),
        ...(typeof item.exitCode === "number"
          ? { exit_code: item.exitCode }
          : {}),
        status:
          item.status === "inProgress"
            ? "in_progress"
            : item.status === "completed"
              ? "completed"
              : "failed",
      };
    case "mcpToolCall":
      return {
        type: "mcp_tool_call",
        id,
        server: String(item.server),
        tool: String(item.tool),
        arguments: item.arguments,
        status:
          item.status === "inProgress"
            ? "in_progress"
            : item.status === "completed"
              ? "completed"
              : "failed",
        ...(object(item.result) && Array.isArray(item.result.content)
          ? {
              result: {
                content: item.result.content,
                structured_content: item.result.structuredContent,
              },
            }
          : {}),
        ...(object(item.error)
          ? { error: { message: String(item.error.message) } }
          : {}),
      };
    case "fileChange":
      return {
        type: "file_change",
        id,
        changes: Array.isArray(item.changes)
          ? item.changes.filter(object).map((change) => ({
              path: String(change.path),
              kind:
                object(change.kind) && change.kind.type === "delete"
                  ? "delete"
                  : object(change.kind) && change.kind.type === "add"
                    ? "add"
                    : "update",
            }))
          : [],
        status: item.status === "completed" ? "completed" : "failed",
      };
    case "webSearch":
      return {
        type: "web_search",
        id,
        query: object(item.action) ? String(item.action.query ?? "") : "",
      };
  }
}
