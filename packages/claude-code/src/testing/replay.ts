import { readFile } from "node:fs/promises";
import type {
  HookCallbackMatcher,
  Options,
  SDKMessage,
  SDKUserMessage,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClaudeQuery, ClaudeQueryHandle } from "../adapter.js";
import {
  type ClaudeOutbound,
  type ClaudeReplayAttempt,
  type ClaudeReplayTranscript,
  detokenize,
  isReplayCallback,
  outboundOf,
  type ReplayCallback,
  type ReplayTokens,
} from "./format.js";

/** The replay and the adapter disagree: the adapter changed what it sends or does. */
export class ReplayDivergenceError extends Error {
  override readonly name = "ReplayDivergenceError";
}

/** A fixture shipped with this package, by scenario name. */
export function fixturePath(scenario: string): string {
  // From src/testing (Bun, Vitest) and dist/testing alike.
  return new URL(`../../src/testing/fixtures/${scenario}.json`, import.meta.url)
    .pathname;
}

function isTranscript(value: unknown): value is ClaudeReplayTranscript {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "provider") === "claude-code" &&
    Array.isArray(Reflect.get(value, "attempts"))
  );
}

/**
 * Load a transcript, putting the replay's own directories in place of the
 * recorded tokens (`{{cwd}}`, `{{state}}`, `{{home}}`, `{{model}}`).
 */
export async function loadClaudeTranscript(input: {
  scenario?: string;
  path?: string;
  tokens: ReplayTokens;
}): Promise<ClaudeReplayTranscript> {
  const file = input.path ?? fixturePath(input.scenario ?? "");
  const parsed: unknown = JSON.parse(
    detokenize(await readFile(file, "utf8"), input.tokens),
  );
  if (!isTranscript(parsed))
    throw new Error(`${file} is not a Claude Code replay transcript`);
  return parsed;
}

function isSdkUserMessageText(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string"
    ? content
    : content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value);
  return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

function isStoreEntry(value: unknown): value is SessionStoreEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "type") === "string"
  );
}

/** A deep copy, so nothing the adapter keeps aliases the transcript. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

function abortError(): Error {
  const error = new Error("The replayed query was aborted");
  error.name = "AbortError";
  return error;
}

export interface ReplayOptions {
  /**
   * Compare what the adapter sends with the recording (default true). A
   * mismatch throws {@link ReplayDivergenceError} from the query.
   */
  checkOutbound?: boolean;
  /** Called with each attempt's actual outbound essentials. */
  onOutbound?: (outbound: ClaudeOutbound, attempt: number) => void;
}

/**
 * A `query` that replays a transcript: the n-th call replays the n-th
 * attempt. It checks the outbound essentials, yields the recorded SDK
 * messages, and at each recorded callback calls the adapter's own
 * callback (permission checks, hooks, the session store, in-process MCP
 * tools) and waits for it, as the CLI would. It waits for the adapter's
 * input and interrupts where the recording saw them, so steering and
 * interrupt scenarios replay deterministically.
 */
export function replayQuery(
  transcript: ClaudeReplayTranscript,
  options: ReplayOptions = {},
): ClaudeQuery {
  let calls = 0;
  return ({ prompt, options: queryOptions }) => {
    const index = calls;
    calls += 1;
    const recorded = transcript.attempts[index];
    if (!recorded)
      throw new ReplayDivergenceError(
        `The adapter started query ${index + 1}; the transcript '${transcript.scenario}' has ${transcript.attempts.length}.`,
      );
    return new ReplayHandle({
      recorded,
      prompt,
      options: queryOptions,
      index,
      check: options.checkOutbound !== false,
      ...(options.onOutbound ? { onOutbound: options.onOutbound } : {}),
    });
  };
}

class ReplayHandle implements ClaudeQueryHandle {
  private interrupted = false;
  private wakeInterrupt?: () => void;
  private closed = false;
  private readonly inputs: AsyncIterator<SDKUserMessage>;
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(
    private readonly input: {
      recorded: ClaudeReplayAttempt;
      prompt: AsyncIterable<SDKUserMessage>;
      options: Options;
      index: number;
      check: boolean;
      onOutbound?: (outbound: ClaudeOutbound, attempt: number) => void;
    },
  ) {
    this.inputs = input.prompt[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<undefined> {
    this.interrupted = true;
    this.wakeInterrupt?.();
    return undefined;
  }

  close(): void {
    this.closed = true;
    this.wakeInterrupt?.();
    void this.inputs.return?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    const signal = this.input.options.abortController?.signal;
    let firstInput = true;
    for (const entry of this.input.recorded.messages) {
      if (this.closed) return;
      if (signal?.aborted) throw abortError();
      if (!isReplayCallback(entry)) {
        yield copy(entry);
        continue;
      }
      if (entry.type === "replay.input") {
        const actual = await this.nextInput(signal);
        if (firstInput) {
          firstInput = false;
          this.checkOutbound(isSdkUserMessageText(actual));
        }
        if (this.input.check && actual.uuid !== (entry.uuid ?? undefined))
          throw new ReplayDivergenceError(
            `Input ${entry.uuid} was recorded; the adapter sent ${actual.uuid}.`,
          );
        continue;
      }
      await this.perform(entry, signal);
    }
  }

  private checkOutbound(prompt: string): void {
    const actual = outboundOf({ options: this.input.options, prompt });
    this.input.onOutbound?.(actual, this.input.index);
    if (!this.input.check) return;
    const expected = this.input.recorded.outbound;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
      throw new ReplayDivergenceError(
        `The adapter's query ${this.input.index + 1} differs from the recording.\nrecorded: ${e}\nactual:   ${a}`,
      );
  }

  private async nextInput(signal?: AbortSignal): Promise<SDKUserMessage> {
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()), {
        once: true,
      });
    });
    const next = await Promise.race([this.inputs.next(), aborted]);
    if (next.done)
      throw new ReplayDivergenceError(
        "The recording read another input; the adapter ended its input.",
      );
    return next.value;
  }

  private async perform(
    entry: Exclude<ReplayCallback, { type: "replay.input" }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const options = this.input.options;
    const callSignal = signal ?? new AbortController().signal;
    switch (entry.type) {
      case "replay.interrupt":
        if (!this.interrupted)
          await new Promise<void>((resolve) => {
            this.wakeInterrupt = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        return;
      case "replay.can_use_tool": {
        if (!options.canUseTool)
          throw new ReplayDivergenceError(
            "The recording asked canUseTool; the adapter set none.",
          );
        const result = await options.canUseTool(
          entry.toolName,
          copy(entry.input),
          {
            signal: callSignal,
            toolUseID: entry.toolUseID,
            requestId: `replay-${entry.toolUseID}`,
          },
        );
        const recordedBehavior = entry.result?.behavior;
        if (
          this.input.check &&
          recordedBehavior &&
          result?.behavior !== recordedBehavior
        )
          throw new ReplayDivergenceError(
            `canUseTool(${entry.toolName}) was recorded as ${String(recordedBehavior)}; the adapter answered ${String(result?.behavior)}.`,
          );
        return;
      }
      case "replay.elicitation": {
        if (!options.onElicitation)
          throw new ReplayDivergenceError(
            "The recording elicited; the adapter set no handler.",
          );
        const request = entry.request;
        const result = await options.onElicitation(
          {
            serverName:
              typeof request.serverName === "string" ? request.serverName : "",
            message: typeof request.message === "string" ? request.message : "",
            ...(request.mode === "form" || request.mode === "url"
              ? { mode: request.mode }
              : {}),
            ...(typeof request.url === "string" ? { url: request.url } : {}),
            ...(typeof request.title === "string"
              ? { title: request.title }
              : {}),
            ...(request.requestedSchema &&
            typeof request.requestedSchema === "object" &&
            !Array.isArray(request.requestedSchema)
              ? { requestedSchema: request.requestedSchema }
              : {}),
          },
          { signal: callSignal, requestId: entry.requestId },
        );
        const recordedAction = entry.result?.action;
        if (
          this.input.check &&
          recordedAction &&
          result?.action !== recordedAction
        )
          throw new ReplayDivergenceError(
            `The elicitation was recorded as ${String(recordedAction)}; the adapter answered ${String(result?.action)}.`,
          );
        return;
      }
      case "replay.hook": {
        const matchers: HookCallbackMatcher[] =
          Object.entries(options.hooks ?? {}).find(
            ([event]) => event === entry.event,
          )?.[1] ?? [];
        const toolName = entry.input.tool_name;
        for (const matcher of matchers) {
          if (
            matcher.matcher &&
            typeof toolName === "string" &&
            !new RegExp(matcher.matcher).test(toolName)
          )
            continue;
          for (const hook of matcher.hooks)
            await hook(
              copy(hookInputOf(entry.input)),
              entry.toolUseID ?? undefined,
              {
                signal: callSignal,
              },
            );
        }
        return;
      }
      case "replay.store": {
        const store = options.sessionStore;
        if (!store)
          throw new ReplayDivergenceError(
            "The recording used a session store; the adapter set none.",
          );
        const key = {
          projectKey: "replay",
          sessionId: entry.sessionId,
          ...(entry.subpath ? { subpath: entry.subpath } : {}),
        };
        if (entry.op === "append")
          await store.append(
            key,
            (entry.entries ?? []).flatMap((value) =>
              isStoreEntry(value) ? [copy(value)] : [],
            ),
          );
        else if (entry.op === "load") {
          const loaded = await store.load(key);
          if (
            this.input.check &&
            (loaded === null) !== (entry.entries === null)
          )
            throw new ReplayDivergenceError(
              `Loading ${entry.sessionId} was recorded ${entry.entries === null ? "empty" : "with entries"}; the adapter's store answered ${loaded === null ? "empty" : "with entries"}.`,
            );
        } else await store.listSubkeys?.(key);
        return;
      }
      case "replay.mcp_call": {
        const client = await this.client(entry.server);
        await client.callTool({
          name: entry.tool,
          arguments: copy(entry.arguments),
        });
        return;
      }
    }
  }

  /** An MCP client on one of the adapter's in-process servers. */
  private client(server: string): Promise<Client> {
    const existing = this.clients.get(server);
    if (existing) return existing;
    const config = this.input.options.mcpServers?.[server];
    if (config?.type !== "sdk" || !("instance" in config))
      throw new ReplayDivergenceError(
        `The recording called ${server}; the adapter offered no such in-process server.`,
      );
    const connecting = (async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await config.instance.connect(serverSide);
      const client = new Client({ name: "replay", version: "1.0.0" });
      await client.connect(clientSide);
      return client;
    })();
    this.clients.set(server, connecting);
    return connecting;
  }
}

/**
 * A recorded hook input, as the SDK's hook input union. Hooks read fields
 * structurally, so the recorded object passes through as recorded.
 */
function hookInputOf(
  input: JsonObject,
): Parameters<HookCallbackMatcher["hooks"][number]>[0] {
  return {
    hook_event_name: "PostToolUse",
    session_id: "",
    transcript_path: "",
    cwd: "",
    tool_name: "",
    tool_input: {},
    tool_response: {},
    tool_use_id: "",
    ...toJsonObject(input),
  };
}
