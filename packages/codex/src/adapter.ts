import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentAttachment,
  AgentErrorKind,
  AgentQuestion,
  AgentTurnUsage,
  JsonObject,
  JsonValue,
  TurnError,
} from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HostToolDescriptor,
  RequestClosedError,
  type RequestDraft,
} from "@catamorphic/agent-protocol/runner";
import { positiveTokenCount, renderUserMessage } from "@catamorphic/sandbox";
import {
  CodexAppServer,
  type CodexServerRequest,
  isObject,
  type JsonRpcId,
} from "./app-server.js";
import { type CodexLaunch, codexLaunch } from "./config.js";
import { CodexItems } from "./items.js";
import {
  ancestorFile,
  ancestorSubpath,
  appendRollout,
  fileSize,
  ROLLOUT_SUBPATH,
  RolloutMirror,
  readRollout,
  rolloutPath,
  statePathOf,
  writeRollout,
} from "./rollout.js";
import type { CodexTransportFactory } from "./transport.js";

/**
 * What the Codex adapter can do (ADR 0196). Rollback is a fork through the
 * turn to keep; native state is the thread's rollout file.
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  steer: true,
  interrupt: true,
  retry: false,
  fork: true,
  rollback: true,
  questions: true,
  approvals: true,
  elicitations: true,
  subagents: true,
  streamsText: true,
  streamsReasoning: true,
  nativeState: "file",
  ids: { thread: "strong", turn: "strong", item: "strong" },
};

export interface CodexAdapterOptions {
  /**
   * Replaces the `codex app-server` process. Tests pass a replay peer from
   * `@catamorphic/codex/testing`; hosts leave it unset.
   */
  transport?: CodexTransportFactory;
}

/**
 * The Codex harness adapter (`codex`): one pinned `codex app-server`
 * process per attempt, beside the workspace it edits (ADR 0196). Per-agent
 * settings arrive with each attempt, never here.
 */
export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): HarnessAdapter {
  return {
    id: "codex",
    capabilities: () => CODEX_CAPABILITIES,
    start: (attempt, host) =>
      new CodexAttempt(attempt, host, options.transport).control(),
  };
}

/** How long an interrupted turn may take to say so before Codex is stopped. */
const INTERRUPT_GRACE_MS = 10_000;
const THREAD_TIMEOUT_MS = 120_000;
const CODEX_ORIGIN = {
  kind: "provider",
  id: "codex",
  displayName: "Codex",
} as const;

interface ThreadInfo {
  id: string;
  path: string | null;
  model: string | null;
}

class CodexAttempt {
  private client?: CodexAppServer;
  private launch?: CodexLaunch;
  private thread?: ThreadInfo;
  private turnId?: string;
  private turnStartedEmitted = false;
  private finishing = false;
  private completed = false;
  private interruptRequested = false;
  private interruptTimer?: ReturnType<typeof setTimeout>;
  private mirror?: RolloutMirror;
  private readonly usage: AgentTurnUsage[] = [];
  private contextWindow?: number;
  private lastError?: JsonObject;
  private readonly steered = new Set<string>();
  /** Open server requests by JSON-RPC id → the request key Work knows them by. */
  private readonly requestKeys = new Map<JsonRpcId, string>();
  /** MCP approvals waiting on a person, withdrawn when Codex resolves them. */
  private readonly approvals = new Map<JsonRpcId, AbortController>();
  private readonly fileChangePaths = new Map<string, string[]>();
  private readonly hostTools = new Map<string, HostToolDescriptor>();
  private readonly items: CodexItems;
  private inputDirectory?: string;
  /** The working directory as given and as Codex reports it (resolved). */
  private workRoots: string[] = [];
  /** A fork's ancestors' rollouts, stored with the fork once it exists. */
  private ancestors: Array<{ subpath: string; entries: JsonValue[] }> = [];
  private resolveTurn!: () => void;
  private readonly turnDone = new Promise<void>((resolve) => {
    this.resolveTurn = resolve;
  });
  private resolveTurnReady!: () => void;
  /** Settles once the native turn id is known, or the attempt is ending. */
  private readonly turnReady = new Promise<void>((resolve) => {
    this.resolveTurnReady = resolve;
  });

  constructor(
    private readonly attempt: AttemptStart,
    private readonly host: AttemptHost,
    private readonly transport: CodexTransportFactory | undefined,
  ) {
    for (const tool of attempt.hostTools) {
      const taken = this.hostTools.has(tool.name);
      this.hostTools.set(
        taken ? `${tool.server ?? "workspace"}__${tool.name}` : tool.name,
        tool,
      );
    }
    this.items = new CodexItems({
      emit: (event) => this.host.emit(event),
      serverName: (key) => this.launch?.serverKeys.get(key) ?? key,
      hostToolServer: (tool) => this.hostTools.get(tool)?.server ?? "workspace",
      filePath: (file) => this.workspacePath(file),
    });
  }

  /** A path inside the working directory, relative to it; others as given. */
  private workspacePath(file: string): string {
    for (const root of this.workRoots) {
      const relative = path.relative(root, file);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
        return relative;
    }
    return file;
  }

  control(): AttemptControl {
    const onAbort = () => this.interrupt();
    this.host.signal.addEventListener("abort", onAbort, { once: true });
    const finished = this.run().finally(() =>
      this.host.signal.removeEventListener("abort", onAbort),
    );
    return {
      steer: (input) => this.steer(input),
      interrupt: () => this.interrupt(),
      finished,
    };
  }

  private async run(): Promise<void> {
    try {
      await this.execute();
    } catch (error) {
      this.complete({
        status: this.interruptRequested ? "interrupted" : "failed",
        ...(this.interruptRequested
          ? {}
          : { error: { message: errorMessage(error) } }),
      });
    } finally {
      await this.shutdown();
    }
  }

  private async execute(): Promise<void> {
    const attempt = this.attempt;
    const input = attempt.input;
    if (!input) {
      this.complete({
        status: "failed",
        error: {
          message:
            "Codex cannot re-run a turn by itself; send the turn's input again.",
        },
      });
      return;
    }
    const launch = codexLaunch(attempt);
    if (typeof launch === "string") {
      this.complete({ status: "failed", error: { message: launch } });
      return;
    }
    this.launch = launch;
    await mkdir(launch.home, { recursive: true });
    const home = await realpath(launch.home).catch(() => launch.home);
    this.workRoots = [
      ...new Set([
        attempt.workingDirectory,
        await realpath(attempt.workingDirectory).catch(
          () => attempt.workingDirectory,
        ),
      ]),
    ];
    const binding = await this.prepareThread(home);
    if (this.interruptRequested) {
      this.complete({ status: "interrupted" });
      return;
    }
    const client = new CodexAppServer({
      spawn: launch.spawn,
      ...(this.transport ? { transport: this.transport } : {}),
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (request) => this.onRequest(request),
      onWithdrawn: (id) => this.onWithdrawn(id),
    });
    this.client = client;
    void client.exited.then((exit) => {
      if (this.completed || this.finishing) return;
      if (exit.stderr.trim())
        this.host.emit({
          type: "diagnostic",
          level: "error",
          message: exit.stderr.trim().slice(-2_000),
        });
      this.items.closeOpen(this.interruptRequested ? "interrupted" : "failed");
      this.complete(
        this.interruptRequested
          ? { status: "interrupted" }
          : {
              status: "failed",
              error: {
                message:
                  "Codex stopped before it finished the turn. Retry the turn.",
              },
            },
      );
    });
    await client.initialize();
    const thread = await this.openThread(client, binding);
    this.thread = thread;
    this.host.emit({
      type: "thread",
      ref: { id: thread.id, strength: "strong" },
      ...(thread.path && statePathOf({ home, file: thread.path })
        ? { statePath: statePathOf({ home, file: thread.path }) }
        : {}),
    });
    // A fork keeps its ancestors' rollouts, so it restores anywhere.
    for (const ancestor of this.ancestors)
      await appendRollout({ host: this.host, ...ancestor });
    if (thread.path)
      this.mirror = new RolloutMirror({
        file: thread.path,
        host: this.host,
        offset:
          binding.mode === "fresh" || binding.mode === "fork"
            ? 0
            : (binding.restoredBytes ?? (await fileSize(thread.path)) ?? 0),
      });
    if (this.interruptRequested) {
      this.complete({ status: "interrupted" });
      return;
    }
    const started = await client.request(
      "turn/start",
      {
        threadId: thread.id,
        clientUserMessageId: input.itemId,
        input: await this.userInput(input),
        cwd: attempt.workingDirectory,
        ...(attempt.model ? { model: attempt.model } : {}),
        ...(attempt.effort ? { effort: attempt.effort } : {}),
        ...(attempt.context.trim()
          ? {
              // Per-turn context (ADR 0152) rides Codex's own channel
              // beside the prompt, never inside the person's words.
              additionalContext: {
                "catamorphic.context": {
                  value: attempt.context,
                  kind: "application",
                },
              },
            }
          : {}),
      },
      { timeoutMs: THREAD_TIMEOUT_MS },
    );
    const turn =
      isObject(started) && isObject(started.turn) ? started.turn : {};
    if (typeof turn.id !== "string")
      throw new Error("Codex returned an invalid turn.");
    this.turnId ??= turn.id;
    this.resolveTurnReady();
    if (this.interruptRequested) this.sendInterrupt();
    await this.turnDone;
  }

  /**
   * Make the binding's native state present in this home before Codex
   * opens it: the thread's stored rollout, and its ancestors' when it is a
   * fork (a fork's history starts in its source's file).
   */
  private async prepareThread(home: string): Promise<{
    mode: "fresh" | "resume" | "restore" | "fork";
    path?: string;
    restoredBytes?: number;
  }> {
    const binding = this.attempt.thread;
    if (binding.mode === "fresh" || binding.mode === "resume")
      return { mode: binding.mode };
    const statePath = binding.statePath ? { statePath: binding.statePath } : {};
    if (binding.mode !== "fork") {
      await this.writeAncestors(home, await this.loadAncestors());
      const file = rolloutPath({
        home,
        threadId: binding.nativeRef.id,
        ...statePath,
      });
      const entries = await this.host.nativeState.load({
        subpath: ROLLOUT_SUBPATH,
      });
      if (entries && entries.length > 0)
        return {
          mode: "restore",
          path: file,
          restoredBytes: await writeRollout({ file, entries }),
        };
      // Nothing stored: the thread may still be in this home already.
      const existing = await fileSize(file);
      return existing !== null
        ? { mode: "restore", path: file, restoredBytes: existing }
        : { mode: "resume" };
    }
    const source = binding.source.id;
    const file = rolloutPath({ home, threadId: source, ...statePath });
    const ancestors = await this.loadAncestors(source);
    await this.writeAncestors(home, ancestors);
    let entries: JsonValue[] | null;
    if ((await fileSize(file)) !== null) entries = await readRollout(file);
    else {
      entries = await this.host.nativeState.load({
        thread: source,
        subpath: ROLLOUT_SUBPATH,
      });
      if (!entries || entries.length === 0) return { mode: "fork" };
      await writeRollout({ file, entries });
    }
    this.ancestors = [
      {
        subpath: ancestorSubpath(
          statePathOf({ home, file }) ?? path.basename(file),
        ),
        entries,
      },
      ...ancestors,
    ];
    return { mode: "fork", path: file };
  }

  private async loadAncestors(
    thread?: string,
  ): Promise<Array<{ subpath: string; entries: JsonValue[] }>> {
    const scope = thread ? { thread } : {};
    const subpaths = await this.host.nativeState.subpaths(scope);
    return Promise.all(
      subpaths
        .filter((subpath) => subpath !== ROLLOUT_SUBPATH)
        .map(async (subpath) => ({
          subpath,
          entries:
            (await this.host.nativeState.load({ ...scope, subpath })) ?? [],
        })),
    );
  }

  private async writeAncestors(
    home: string,
    ancestors: Array<{ subpath: string; entries: JsonValue[] }>,
  ): Promise<void> {
    for (const ancestor of ancestors) {
      const file = ancestorFile({ home, subpath: ancestor.subpath });
      if (
        file &&
        (await fileSize(file)) === null &&
        ancestor.entries.length > 0
      )
        await writeRollout({ file, entries: ancestor.entries });
    }
  }

  private async openThread(
    client: CodexAppServer,
    binding: { mode: "fresh" | "resume" | "restore" | "fork"; path?: string },
  ): Promise<ThreadInfo> {
    const attempt = this.attempt;
    const launch = this.launch;
    if (!launch) throw new Error("Codex was not launched.");
    const common = {
      cwd: attempt.workingDirectory,
      ...(attempt.model ? { model: attempt.model } : {}),
      sandbox: launch.sandbox,
      approvalPolicy: launch.approvalPolicy,
      developerInstructions: this.developerInstructions(),
      config: launch.threadConfig,
    };
    const thread = attempt.thread;
    let response: JsonValue;
    if (thread.mode === "fresh") {
      response = await client.request(
        "thread/start",
        {
          ...common,
          ...(this.hostTools.size > 0
            ? {
                dynamicTools: [...this.hostTools].map(([name, tool]) => ({
                  type: "function",
                  name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
              }
            : {}),
        },
        { timeoutMs: THREAD_TIMEOUT_MS },
      );
    } else if (thread.mode === "fork") {
      response = await client.request(
        "thread/fork",
        {
          threadId: thread.source.id,
          ...(binding.path ? { path: binding.path } : {}),
          ...(thread.throughTurnRef
            ? { lastTurnId: thread.throughTurnRef.id }
            : {}),
          excludeTurns: true,
          ...common,
        },
        { timeoutMs: THREAD_TIMEOUT_MS },
      );
    } else {
      response = await client.request(
        "thread/resume",
        {
          threadId: thread.nativeRef.id,
          ...(binding.path ? { path: binding.path } : {}),
          excludeTurns: true,
          ...common,
        },
        { timeoutMs: THREAD_TIMEOUT_MS },
      );
    }
    const info =
      isObject(response) && isObject(response.thread) ? response.thread : {};
    if (typeof info.id !== "string")
      throw new Error("Codex returned an invalid thread.");
    return {
      id: info.id,
      path: typeof info.path === "string" && info.path ? info.path : null,
      model:
        isObject(response) && typeof response.model === "string"
          ? response.model
          : null,
    };
  }

  private developerInstructions(): string {
    const plugins = this.attempt.plugins;
    return [
      this.attempt.systemPrompt,
      plugins.length > 0
        ? [
            "Plugins installed for this agent (read a plugin's files before using it):",
            ...plugins.map((plugin) => `- ${plugin.name}: ${plugin.path}`),
          ].join("\n")
        : "",
    ]
      .filter((part) => part.trim())
      .join("\n\n");
  }

  /** The person's words with text attachments inline; media as local files. */
  private async userInput(input: {
    itemId: string;
    text: string;
    attachments: AgentAttachment[];
  }): Promise<JsonValue[]> {
    const parts: JsonValue[] = [
      {
        type: "text",
        text: renderUserMessage(input.text, input.attachments),
        text_elements: [],
      },
    ];
    const media = input.attachments.filter(
      (attachment) => attachment.kind !== "text",
    );
    if (media.length === 0) return parts;
    this.inputDirectory ??= path.join(
      this.attempt.stateDirectory,
      "codex-input",
      this.attempt.attemptId,
    );
    const directory = path.join(this.inputDirectory, input.itemId);
    await mkdir(directory, { recursive: true });
    for (const [index, attachment] of media.entries()) {
      const file = path.join(
        directory,
        `${index}.${EXTENSIONS[attachment.mediaType] ?? "bin"}`,
      );
      await writeFile(file, Buffer.from(attachment.dataBase64, "base64"));
      parts.push(
        attachment.kind === "image"
          ? { type: "localImage", path: file }
          : {
              type: "text",
              text: `Attached document ${JSON.stringify(attachment.name)} (${attachment.mediaType}) is at ${JSON.stringify(file)} for this turn. Read it with your file or shell tools.`,
              text_elements: [],
            },
      );
    }
    return parts;
  }

  private async steer(input: {
    itemId: string;
    text: string;
    attachments: AgentAttachment[];
  }): Promise<boolean> {
    if (this.finishing || this.completed) return false;
    await this.turnReady;
    const client = this.client;
    const thread = this.thread;
    const turnId = this.turnId;
    if (!client || !thread || !turnId || this.finishing || this.completed)
      return false;
    this.steered.add(input.itemId);
    try {
      await client.request("turn/steer", {
        threadId: thread.id,
        expectedTurnId: turnId,
        clientUserMessageId: input.itemId,
        input: await this.userInput(input),
      });
      return true;
    } catch {
      // The turn finished first, or Codex cannot take input now.
      this.steered.delete(input.itemId);
      return false;
    }
  }

  private interrupt(): void {
    if (this.completed || this.interruptRequested) return;
    this.interruptRequested = true;
    this.resolveTurnReady();
    if (this.turnId) this.sendInterrupt();
  }

  private sendInterrupt(): void {
    const client = this.client;
    const thread = this.thread;
    if (!client || !thread || !this.turnId || this.completed) return;
    client
      .request("turn/interrupt", { threadId: thread.id, turnId: this.turnId })
      .catch(() => {});
    this.interruptTimer ??= setTimeout(() => {
      this.complete({ status: "interrupted" });
    }, INTERRUPT_GRACE_MS);
    this.interruptTimer.unref?.();
  }

  private onNotification(method: string, params: JsonObject): void {
    const thread = this.thread;
    if (!thread) return;
    if (
      method === "thread/started" &&
      isObject(params.thread) &&
      params.thread.parentThreadId === thread.id &&
      typeof params.thread.id === "string"
    ) {
      this.items.adoptChild(params.thread.id);
      return;
    }
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId && threadId !== thread.id) {
      // A native subagent's thread: its items nest under the spawn.
      const parentKey = this.items.childThreads.get(threadId);
      if (!parentKey) return;
      this.itemNotification(method, params, parentKey);
      return;
    }
    switch (method) {
      case "turn/started": {
        const turn = isObject(params.turn) ? params.turn : {};
        if (typeof turn.id !== "string") return;
        this.turnId ??= turn.id;
        this.resolveTurnReady();
        if (turn.id !== this.turnId || this.turnStartedEmitted) return;
        this.turnStartedEmitted = true;
        this.host.emit({
          type: "turn.started",
          ref: { id: turn.id, strength: "strong" },
        });
        return;
      }
      case "turn/plan/updated":
        this.items.plan(
          typeof params.turnId === "string"
            ? params.turnId
            : (this.turnId ?? ""),
          params.plan ?? [],
        );
        return;
      case "thread/tokenUsage/updated": {
        if (
          typeof params.turnId === "string" &&
          this.turnId &&
          params.turnId !== this.turnId
        )
          return;
        const usage = isObject(params.tokenUsage) ? params.tokenUsage : {};
        if (isObject(usage.last)) this.usage.push(turnUsage(usage.last));
        if (typeof usage.modelContextWindow === "number")
          this.contextWindow = usage.modelContextWindow;
        return;
      }
      case "error": {
        const error = isObject(params.error) ? params.error : {};
        if (params.willRetry === true)
          this.host.emit({
            type: "diagnostic",
            level: "warn",
            message: String(error.message ?? "Codex is retrying."),
          });
        else this.lastError = error;
        return;
      }
      case "warning":
      case "configWarning":
        if (typeof params.message === "string")
          this.host.emit({
            type: "diagnostic",
            level: "warn",
            message: params.message,
          });
        return;
      case "turn/completed": {
        const turn = isObject(params.turn) ? params.turn : {};
        if (this.turnId && turn.id !== this.turnId) return;
        void this.finishTurn(turn);
        return;
      }
      default:
        this.itemNotification(method, params);
    }
  }

  private itemNotification(
    method: string,
    params: JsonObject,
    parentKey?: string,
  ): void {
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    const delta = typeof params.delta === "string" ? params.delta : "";
    switch (method) {
      case "item/started": {
        const item = isObject(params.item) ? params.item : undefined;
        if (!item) return;
        if (item.type === "userMessage") {
          const clientId =
            typeof item.clientId === "string" ? item.clientId : "";
          if (!parentKey && this.steered.delete(clientId))
            this.host.emit({ type: "input.consumed", itemIds: [clientId] });
          return;
        }
        if (item.type === "fileChange" && typeof item.id === "string")
          this.fileChangePaths.set(
            item.id,
            (Array.isArray(item.changes) ? item.changes : [])
              .filter(isObject)
              .map((change) => this.workspacePath(String(change.path ?? ""))),
          );
        this.items.itemStarted(item, parentKey);
        return;
      }
      case "item/completed": {
        const item = isObject(params.item) ? params.item : undefined;
        if (item && item.type !== "userMessage")
          this.items.itemCompleted(item, parentKey);
        void this.mirror?.poll();
        return;
      }
      case "item/agentMessage/delta":
        this.items.agentDelta(itemId, delta);
        return;
      case "item/reasoning/summaryTextDelta":
        this.items.reasoningDelta(
          itemId,
          delta,
          typeof params.summaryIndex === "number" ? params.summaryIndex : 0,
        );
        return;
      case "item/commandExecution/outputDelta":
        this.items.commandDelta(itemId, delta);
        return;
    }
  }

  private async finishTurn(turn: JsonObject): Promise<void> {
    if (this.finishing || this.completed) return;
    this.finishing = true;
    this.resolveTurnReady();
    const status =
      turn.status === "completed"
        ? "completed"
        : turn.status === "interrupted"
          ? "interrupted"
          : "failed";
    this.items.closeOpen(status);
    const usage = this.turnUsage();
    if (usage) this.host.emit({ type: "usage", usage });
    // The turn's rollout lines are stored before it settles.
    await this.mirror?.poll();
    const error =
      status === "failed"
        ? classifyTurnError(
            isObject(turn.error) ? turn.error : (this.lastError ?? {}),
            { workStarted: this.items.workStarted },
          )
        : undefined;
    this.complete({
      status,
      ...(error ? { error } : {}),
      ...(typeof turn.id === "string"
        ? { ref: { id: turn.id, strength: "strong" as const } }
        : {}),
    });
  }

  private turnUsage(): AgentTurnUsage | undefined {
    if (this.usage.length === 0) return undefined;
    const sum = (field: keyof AgentTurnUsage) =>
      this.usage.reduce((total, usage) => {
        const value = usage[field];
        return total + (typeof value === "number" ? value : 0);
      }, 0);
    const last = this.usage.at(-1);
    const model = this.attempt.model ?? this.thread?.model ?? undefined;
    return {
      ...(model ? { model } : {}),
      inputTokens: sum("inputTokens"),
      cachedInputTokens: sum("cachedInputTokens"),
      outputTokens: sum("outputTokens"),
      reasoningTokens: sum("reasoningTokens"),
      ...(last?.contextTokens !== undefined
        ? { contextTokens: last.contextTokens }
        : {}),
      ...(this.contextWindow ? { contextWindow: this.contextWindow } : {}),
    };
  }

  private complete(event: {
    status: "completed" | "failed" | "interrupted";
    error?: TurnError;
    ref?: { id: string; strength: "strong" };
  }): void {
    if (this.completed) return;
    this.completed = true;
    this.finishing = true;
    clearTimeout(this.interruptTimer);
    this.host.emit({ type: "turn.completed", ...event });
    this.resolveTurnReady();
    this.resolveTurn();
  }

  /** Stop Codex, then store the rollout lines it wrote on its way out. */
  private async shutdown(): Promise<void> {
    await this.client?.close();
    await this.mirror?.poll();
    if (this.inputDirectory)
      await rm(this.inputDirectory, { recursive: true, force: true }).catch(
        () => {},
      );
  }

  // -------------------------------------------------------------------------
  // Requests from Codex

  private onWithdrawn(id: JsonRpcId): void {
    this.approvals.get(id)?.abort();
    const key = this.requestKeys.get(id);
    if (!key) return;
    this.requestKeys.delete(id);
    this.host.emit({
      type: "request.closed",
      key,
      reason: "Codex no longer needs an answer.",
    });
  }

  private async ask(
    id: JsonRpcId,
    key: string,
    request: RequestDraft,
  ): Promise<Awaited<ReturnType<AttemptHost["request"]>> | undefined> {
    this.requestKeys.set(id, key);
    try {
      return await this.host.request(key, request);
    } catch (error) {
      if (error instanceof RequestClosedError) return undefined;
      throw error;
    } finally {
      this.requestKeys.delete(id);
    }
  }

  private async onRequest(request: CodexServerRequest): Promise<JsonValue> {
    const { id, method, params } = request;
    switch (method) {
      case "item/commandExecution/requestApproval":
        return this.commandApproval(id, params);
      case "item/fileChange/requestApproval":
        return this.fileChangeApproval(id, params);
      case "item/permissions/requestApproval":
        return this.permissionsApproval(id, params);
      case "item/tool/requestUserInput":
        return this.userInputRequest(id, params);
      case "mcpServer/elicitation/request":
        return this.elicitation(id, params);
      case "item/tool/call":
        return this.toolCall(params);
      default:
        throw new Error(`Unsupported client request: ${method}`);
    }
  }

  private async commandApproval(
    id: JsonRpcId,
    params: JsonObject,
  ): Promise<JsonValue> {
    const command = typeof params.command === "string" ? params.command : "";
    const decisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : undefined;
    const response = await this.ask(
      id,
      `approval:${String(params.approvalId ?? params.itemId ?? id)}`,
      {
        kind: "approval",
        blocking: true,
        title: "Run this command?",
        ...(typeof params.reason === "string" && params.reason
          ? { description: params.reason }
          : {}),
        origin: CODEX_ORIGIN,
        approval: {
          action: "Run a command",
          details: command,
          tool: {
            server: null,
            name: "shell",
            input: {
              command,
              ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
            },
          },
        },
      },
    );
    return { decision: approvalDecision(response, decisions) };
  }

  private async fileChangeApproval(
    id: JsonRpcId,
    params: JsonObject,
  ): Promise<JsonValue> {
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    const paths = this.fileChangePaths.get(itemId) ?? [];
    const response = await this.ask(id, `approval:${itemId || String(id)}`, {
      kind: "approval",
      blocking: true,
      title: "Apply these file changes?",
      ...(typeof params.reason === "string" && params.reason
        ? { description: params.reason }
        : {}),
      origin: CODEX_ORIGIN,
      approval: {
        action: "Change files",
        ...(paths.length > 0 ? { details: paths.join("\n") } : {}),
        tool: { server: null, name: "apply_patch", input: { paths } },
      },
    });
    return { decision: approvalDecision(response, undefined) };
  }

  private async permissionsApproval(
    id: JsonRpcId,
    params: JsonObject,
  ): Promise<JsonValue> {
    const requested = isObject(params.permissions) ? params.permissions : {};
    const response = await this.ask(
      id,
      `permissions:${String(params.itemId ?? id)}`,
      {
        kind: "approval",
        blocking: true,
        title: "Allow more access?",
        ...(typeof params.reason === "string" && params.reason
          ? { description: params.reason }
          : {}),
        origin: CODEX_ORIGIN,
        approval: {
          action: "Widen the sandbox",
          details: JSON.stringify(requested),
          tool: { server: null, name: "permissions", input: requested },
        },
      },
    );
    const approved =
      response?.kind === "approval" && response.decision === "approved";
    return {
      permissions: approved
        ? Object.fromEntries(
            Object.entries(requested).filter(([, value]) => value !== null),
          )
        : {},
      scope:
        approved && response?.kind === "approval" && response.remember
          ? "session"
          : "turn",
    };
  }

  private async userInputRequest(
    id: JsonRpcId,
    params: JsonObject,
  ): Promise<JsonValue> {
    const native = (
      Array.isArray(params.questions) ? params.questions : []
    ).filter(isObject);
    const questions: AgentQuestion[] = native.map((question) => ({
      question: String(question.question ?? ""),
      header: String(question.header ?? ""),
      multiSelect: false,
      options: (Array.isArray(question.options) ? question.options : [])
        .filter(isObject)
        .map((option) => ({
          label: String(option.label ?? ""),
          description: String(option.description ?? ""),
        })),
    }));
    const response = await this.ask(
      id,
      `question:${String(params.itemId ?? id)}`,
      {
        kind: "question",
        blocking: params.isBlocking !== false,
        title: questions[0]?.header || "Question",
        origin: CODEX_ORIGIN,
        questions,
      },
    );
    const answers = response?.kind === "question" ? response.answers : [];
    return {
      answers: Object.fromEntries(
        native.map((question, index) => [
          String(question.id ?? index),
          { answers: answers[index] === undefined ? [] : [answers[index]] },
        ]),
      ),
    };
  }

  private async elicitation(
    id: JsonRpcId,
    params: JsonObject,
  ): Promise<JsonValue> {
    const codexServer = String(params.serverName ?? "");
    const server = this.launch?.serverKeys.get(codexServer) ?? codexServer;
    const meta = isObject(params._meta) ? params._meta : {};
    const message = String(params.message ?? "");
    if (meta.codex_approval_kind === "mcp_tool_call") {
      // An MCP tool asks before it runs (`default_tools_approval_mode =
      // prompt`): the attempt's tool policy decides, asking only for `ask`.
      const call = this.items.mcpCall(codexServer);
      const tool =
        call?.tool ?? message.match(/run tool "([^"]+)"/)?.[1] ?? "tool";
      // Codex may withdraw the elicitation while its person decides.
      const withdrawn = new AbortController();
      this.approvals.set(id, withdrawn);
      const verdict = await this.host
        .authorize({
          server,
          tool,
          input: call?.input ?? meta.tool_params ?? {},
          ...(call ? { itemKey: call.key } : {}),
          signal: withdrawn.signal,
        })
        .finally(() => this.approvals.delete(id));
      return verdict.allowed
        ? { action: "accept", content: {}, _meta: null }
        : { action: "decline", content: null, _meta: null };
    }
    const schema = isObject(params.requestedSchema)
      ? params.requestedSchema
      : undefined;
    const response = await this.ask(id, `elicitation:${server}:${String(id)}`, {
      kind: "elicitation",
      blocking: true,
      title: `${server} needs your input`,
      ...(message ? { description: message } : {}),
      origin: { kind: "mcp", id: server, displayName: server },
      elicitation: {
        server,
        message,
        ...(schema ? { schema } : {}),
        ...(typeof params.url === "string" ? { url: params.url } : {}),
      },
    });
    if (response?.kind !== "elicitation")
      return { action: "cancel", content: null, _meta: null };
    return {
      action: response.action,
      content: response.action === "accept" ? (response.content ?? {}) : null,
      _meta: null,
    };
  }

  /** A host tool Codex called as a dynamic tool (ADR 0196: a host call). */
  private async toolCall(params: JsonObject): Promise<JsonValue> {
    const name = String(params.tool ?? "");
    const callId =
      typeof params.callId === "string" ? params.callId : undefined;
    const tool = this.hostTools.get(name);
    const input = params.arguments ?? {};
    const failure = (text: string) => ({
      contentItems: [{ type: "inputText", text }],
      success: false,
    });
    if (!tool) return failure(`There is no tool named ${name}.`);
    const server = tool.server ?? "workspace";
    if (this.attempt.toolPolicies[server]) {
      const verdict = await this.host.authorize({
        server,
        tool: tool.name,
        input,
        ...(callId ? { itemKey: callId } : {}),
      });
      if (!verdict.allowed) return failure(verdict.message);
    }
    try {
      const result = await this.host.callTool({
        name: tool.name,
        input,
        ...(callId ? { itemKey: callId } : {}),
      });
      return {
        contentItems: result.content.map(
          (part): JsonObject =>
            part.type === "text"
              ? { type: "inputText", text: part.text }
              : {
                  type: "inputImage",
                  imageUrl: `data:${part.mimeType};base64,${part.data}`,
                },
        ),
        success: result.isError !== true,
      };
    } catch (error) {
      return failure(errorMessage(error));
    }
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

/**
 * A Codex approval decision for the person's answer. "Always" is Codex's
 * own per-session grant when it offers one. A denial declines, so the
 * agent continues and can say what it could not do; a request that ended
 * unanswered cancels, which stops the turn.
 */
function approvalDecision(
  response: Awaited<ReturnType<AttemptHost["request"]>> | undefined,
  available: JsonValue[] | undefined,
): JsonValue {
  if (response?.kind !== "approval") return "cancel";
  if (response.decision !== "approved") return "decline";
  return response.remember === "always" &&
    (!available || available.includes("acceptForSession"))
    ? "acceptForSession"
    : "accept";
}

/**
 * One response's usage (ADR 0057). Codex counts input inclusive of the
 * cached portion, so the uncached figure is the difference; reasoning is
 * a subset of output.
 */
function turnUsage(last: JsonObject): AgentTurnUsage {
  const input = positiveTokenCount(last.inputTokens);
  const cached = positiveTokenCount(last.cachedInputTokens);
  const output = positiveTokenCount(last.outputTokens);
  return {
    inputTokens: Math.max(0, input - cached),
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningTokens: Math.min(
      output,
      positiveTokenCount(last.reasoningOutputTokens),
    ),
    contextTokens: positiveTokenCount(last.totalTokens) || input + output,
  };
}

/**
 * A failed turn's error, classified from Codex's `codexErrorInfo`. Retrying
 * is safe only when the provider turned the turn away before any work.
 */
export function classifyTurnError(
  error: JsonObject,
  context: { workStarted: boolean },
): TurnError {
  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : "Codex could not finish the turn.";
  const info = error.codexErrorInfo;
  // A custom provider's HTTP failure is `other`; its status is in the text.
  const status =
    (isObject(info)
      ? Object.values(info)
          .filter(isObject)
          .map((detail) => detail.httpStatusCode)
          .find((code): code is number => typeof code === "number")
      : undefined) ??
    numberOrUndefined(message.match(/\bstatus:? (\d{3})\b/)?.[1]);
  const name =
    typeof info === "string"
      ? info
      : isObject(info)
        ? Object.keys(info)[0]
        : undefined;
  let kind: AgentErrorKind | undefined;
  if (name === "unauthorized" || status === 401 || status === 403)
    kind = "auth";
  else if (
    name === "usageLimitExceeded" ||
    name === "rateLimitExceeded" ||
    status === 429
  )
    kind = "rate_limit";
  else if (
    name === "serverOverloaded" ||
    name === "internalServerError" ||
    name === "httpConnectionFailed" ||
    name === "responseStreamConnectionFailed" ||
    name === "responseStreamDisconnected" ||
    name === "responseTooManyFailedAttempts" ||
    (status !== undefined && status >= 500)
  )
    kind = "unavailable";
  else if (name === "badRequest" && /reasoning|encrypted/i.test(message))
    kind = "model_incompat";
  return {
    message,
    ...(kind ? { kind } : {}),
    ...(kind && kind !== "model_incompat" && !context.workStarted
      ? { retrySafe: true }
      : {}),
  };
}

function numberOrUndefined(text: string | undefined): number | undefined {
  return text ? Number(text) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
