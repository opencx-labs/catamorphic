import {
  type HookCallbackMatcher,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import type { ClaudeQuery, ClaudeQueryHandle } from "../adapter.js";
import {
  type ClaudeReplayAttempt,
  outboundOf,
  type ReplayCallback,
  type ReplayEntry,
} from "./format.js";

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value);
  return json && typeof json === "object" && !Array.isArray(json) ? json : {};
}

function promptText(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string"
    ? content
    : content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}

/**
 * The real SDK `query`, recording each call as a replay attempt: its
 * outbound essentials, every message it yields and every callback it makes
 * into the adapter, in the order the adapter observed them.
 */
export function recordingQuery(input: {
  attempts: ClaudeReplayAttempt[];
  query?: ClaudeQuery;
}): ClaudeQuery {
  const real = input.query ?? sdkQuery;
  return ({ prompt, options }) => {
    const messages: ReplayEntry[] = [];
    const attempt: ClaudeReplayAttempt = {
      outbound: outboundOf({ options, prompt: "" }),
      messages,
    };
    input.attempts.push(attempt);
    const log = (entry: ReplayCallback) => {
      messages.push(entry);
      return entry;
    };
    let first = true;
    const recordedPrompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) {
          const text = promptText(message);
          if (first) {
            first = false;
            attempt.outbound = outboundOf({ options, prompt: text });
          }
          log({ type: "replay.input", uuid: message.uuid ?? null, text });
          yield message;
        }
      },
    };
    const handle = real({
      prompt: recordedPrompt,
      options: recordedOptions({ options, log }),
    });
    const recorded: ClaudeQueryHandle = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        for await (const message of handle) {
          messages.push(message);
          yield message;
        }
      },
      interrupt: () => {
        log({ type: "replay.interrupt" });
        return handle.interrupt();
      },
      close: () => handle.close(),
    };
    return recorded;
  };
}

function recordedOptions(input: {
  options: Options;
  log: (entry: ReplayCallback) => ReplayCallback;
}): Options {
  const { options, log } = input;
  const canUseTool = options.canUseTool;
  const onElicitation = options.onElicitation;
  const store = options.sessionStore;
  const hooks: NonNullable<Options["hooks"]> = {};
  for (const [event, matchers] of Object.entries(options.hooks ?? {}))
    hooks[event as keyof typeof hooks] = matchers.map(
      (matcher): HookCallbackMatcher => ({
        ...matcher,
        hooks: matcher.hooks.map(
          (hook) => async (hookInput, toolUseID, rest) => {
            log({
              type: "replay.hook",
              event,
              toolUseID: toolUseID ?? null,
              input: toJsonObject(hookInput),
            });
            return hook(hookInput, toolUseID, rest);
          },
        ),
      }),
    );
  for (const [server, config] of Object.entries(options.mcpServers ?? {})) {
    if (config.type !== "sdk" || !("instance" in config)) continue;
    const instance = config.instance;
    const connect = instance.connect.bind(instance);
    instance.connect = async (transport) => {
      await connect(transport);
      const receive = transport.onmessage;
      const send = transport.send.bind(transport);
      const calls = new Map<string | number, ReplayCallback>();
      transport.onmessage = (message, extra) => {
        if ("method" in message && message.method === "tools/call") {
          const params = toJsonObject(message.params);
          const entry = log({
            type: "replay.mcp_call",
            server,
            tool: typeof params.name === "string" ? params.name : "",
            arguments: toJsonObject(params.arguments),
            result: null,
          });
          if ("id" in message) calls.set(message.id, entry);
        }
        receive?.(message, extra);
      };
      transport.send = async (message, sendOptions) => {
        if ("id" in message && "result" in message) {
          const entry = calls.get(message.id);
          if (entry?.type === "replay.mcp_call")
            entry.result = toJson(message.result);
        }
        return send(message, sendOptions);
      };
    };
  }
  return {
    ...options,
    hooks,
    ...(canUseTool
      ? {
          canUseTool: async (toolName, toolInput, callOptions) => {
            const entry = log({
              type: "replay.can_use_tool",
              toolName,
              input: toJsonObject(toolInput),
              toolUseID: callOptions.toolUseID,
              result: null,
            });
            const result = await canUseTool(toolName, toolInput, callOptions);
            if (entry.type === "replay.can_use_tool")
              entry.result = toJsonObject(result);
            return result;
          },
        }
      : {}),
    ...(onElicitation
      ? {
          onElicitation: async (request, callOptions) => {
            const entry = log({
              type: "replay.elicitation",
              request: toJsonObject(request),
              requestId: callOptions.requestId,
              result: null,
            });
            const result = await onElicitation(request, callOptions);
            if (entry.type === "replay.elicitation")
              entry.result = result ? toJsonObject(result) : null;
            return result;
          },
        }
      : {}),
    ...(store ? { sessionStore: recordedStore({ store, log }) } : {}),
  };
}

function recordedStore(input: {
  store: SessionStore;
  log: (entry: ReplayCallback) => ReplayCallback;
}): SessionStore {
  const { store, log } = input;
  return {
    append: (key, entries) => {
      log({
        type: "replay.store",
        op: "append",
        sessionId: key.sessionId,
        subpath: key.subpath ?? null,
        entries: entries.map(toJson),
      });
      return store.append(key, entries);
    },
    load: async (key) => {
      const entry = log({
        type: "replay.store",
        op: "load",
        sessionId: key.sessionId,
        subpath: key.subpath ?? null,
        entries: null,
      });
      const loaded = await store.load(key);
      if (entry.type === "replay.store")
        entry.entries = loaded ? loaded.map(toJson) : null;
      return loaded;
    },
    ...(store.listSubkeys
      ? {
          listSubkeys: async (key: {
            projectKey: string;
            sessionId: string;
          }) => {
            log({
              type: "replay.store",
              op: "list_subkeys",
              sessionId: key.sessionId,
              subpath: null,
              entries: null,
            });
            return (await store.listSubkeys?.(key)) ?? [];
          },
        }
      : {}),
  };
}
