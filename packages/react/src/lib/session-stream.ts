import type { SessionStreamMessage } from "@catamorphic/agent-protocol";
import type { CatamorphicApiClient } from "@catamorphic/api-client";
import { CatamorphicError, toCatamorphicError } from "./errors.js";

/**
 * The session protocol this client speaks (ADR 0196). A server whose
 * `GET /me` reports another `agentProtocol.session` cannot be talked to.
 */
export const AGENT_SESSION_PROTOCOL = 1;

/** Whether a server's `/me` speaks this client's session protocol. */
export function speaksSessionProtocol(me: {
  agentProtocol?: { session?: number } | null;
}): boolean {
  return me.agentProtocol?.session === AGENT_SESSION_PROTOCOL;
}

/** What people read when a server speaks another session protocol. */
export const SESSION_PROTOCOL_MISMATCH_MESSAGE =
  "This server runs a different version of Work. Update Work to continue.";

/**
 * Read one server-sent-event connection to a session's events (ADR 0196)
 * until it ends, handing each `data:` message to `onMessage` in order.
 * Resolves when the server closes the stream; rejects on a transport or
 * HTTP failure. Goes through the provider's API client, so hosts that
 * authenticate with a custom fetch authenticate the stream too.
 */
export async function readSessionStream({
  apiClient,
  projectId,
  sessionId,
  after,
  signal,
  onMessage,
}: {
  apiClient: CatamorphicApiClient;
  projectId: string;
  sessionId: string;
  /** The last sequence the client applied. */
  after: number;
  signal: AbortSignal;
  onMessage: (message: SessionStreamMessage) => void;
}): Promise<void> {
  const result = await apiClient.GET(
    "/api/projects/{projectId}/agent/sessions/{sessionId}/events",
    {
      params: { path: { projectId, sessionId }, query: { after } },
      headers: { accept: "text/event-stream" },
      parseAs: "stream",
      signal,
    },
  );
  if (!result.response.ok || !result.data) {
    throw toCatamorphicError({
      response: result.response,
      body: result.error,
      fallbackMessage: "The session stream could not be opened",
    });
  }
  const reader = result.data.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (;;) {
        const boundary = frameBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const message = parseFrame(frame);
        if (message) onMessage(message);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** The end of the first complete frame: a blank line, in any line ending. */
function frameBoundary(
  buffer: string,
): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

/** One SSE frame's `data:` lines as a stream message; comments are skipped. */
export function parseFrame(frame: string): SessionStreamMessage | undefined {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return undefined;
  try {
    const parsed: SessionStreamMessage = JSON.parse(data.join("\n"));
    return parsed;
  } catch (cause) {
    throw new CatamorphicError({
      code: "unknown",
      message: "The session stream sent something unreadable",
      cause,
    });
  }
}

/**
 * How many session streams one API client keeps open at once. A browser
 * gives an HTTP/1.1 origin six connections and every open stream holds
 * one, so a host with many chats mounted would starve its own requests.
 * Readers past the limit poll instead until a slot frees.
 */
export const MAX_SESSION_STREAMS = 4;

interface StreamSlots {
  used: number;
  waiting: Set<() => void>;
}

const streamSlots = new WeakMap<object, StreamSlots>();

/**
 * Take one of `client`'s stream slots. Returns its release, or null when
 * all are taken: `onFree` then runs once one frees, to try again, unless
 * `cancel` ran first.
 */
export function acquireStreamSlot(
  client: object,
  onFree: () => void,
): { release: (() => void) | null; cancel: () => void } {
  let slots = streamSlots.get(client);
  if (!slots) {
    slots = { used: 0, waiting: new Set() };
    streamSlots.set(client, slots);
  }
  const owned = slots;
  if (owned.used >= MAX_SESSION_STREAMS) {
    owned.waiting.add(onFree);
    return { release: null, cancel: () => owned.waiting.delete(onFree) };
  }
  owned.used += 1;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      owned.used -= 1;
      const [next] = owned.waiting;
      if (next) {
        owned.waiting.delete(next);
        next();
      }
    },
    cancel: () => {},
  };
}
