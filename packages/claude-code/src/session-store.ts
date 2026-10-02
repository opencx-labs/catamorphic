import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "@catamorphic/agent-protocol";
import type { AttemptHost } from "@catamorphic/agent-protocol/runner";

function isStoreEntry(value: unknown): value is SessionStoreEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "type") === "string"
  );
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}

/**
 * Claude Code's transcript stored with Work (ADR 0198): the Agent SDK's
 * `SessionStore`, answered through the runner's native state host calls,
 * so a thread resumes in any sandbox or on any machine. The SDK's project
 * key (derived from the working directory) is ignored: a thread is Work's
 * provider thread wherever it runs. `threadFor` names the native thread a
 * session id belongs to when it is not the attempt's own (a fork reading
 * its source).
 *
 * Appends are applied in call order, as the SDK requires.
 */
export function hostSessionStore(input: {
  nativeState: AttemptHost["nativeState"];
  threadFor: (sessionId: string) => string | undefined;
}): SessionStore {
  let chain: Promise<void> = Promise.resolve();
  const address = (key: { sessionId: string; subpath?: string }) => {
    const thread = input.threadFor(key.sessionId);
    return {
      ...(thread ? { thread } : {}),
      ...(key.subpath ? { subpath: key.subpath } : {}),
    };
  };
  return {
    append: (key: SessionKey, entries: SessionStoreEntry[]) => {
      const json = entries.map(toJson);
      // The runner sends a large append as several bounded calls.
      const next = chain.then(() =>
        input.nativeState.append({ ...address(key), entries: json }),
      );
      chain = next.catch(() => {});
      return next;
    },
    load: async (key: SessionKey) => {
      await chain;
      const entries = await input.nativeState.load(address(key));
      return entries
        ? entries.flatMap((entry) => (isStoreEntry(entry) ? [entry] : []))
        : null;
    },
    listSubkeys: async (key: { projectKey: string; sessionId: string }) => {
      const thread = input.threadFor(key.sessionId);
      return input.nativeState.subpaths(thread ? { thread } : undefined);
    },
  };
}
