import type { SessionStreamMessage } from "@catamorphic/agent-protocol";
import type { CatamorphicApiClient } from "@catamorphic/api-client";
import { CatamorphicError, toCatamorphicError } from "./errors.js";

/**
 * The session protocol this client speaks (ADR 0197). A server whose
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
 * Read one server-sent-event connection to a session's events (ADR 0197)
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
  onOpen,
  onMessage,
}: {
  apiClient: CatamorphicApiClient;
  projectId: string;
  sessionId: string;
  /** The last sequence the client applied. */
  after: number;
  signal: AbortSignal;
  /** The server accepted the stream: it is live before its first message. */
  onOpen?: () => void;
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
  onOpen?.();
  const reader = result.data.pipeThrough(new TextDecoderStream()).getReader();
  // Not every fetch errors a body already streaming when its signal aborts.
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || signal.aborted) break;
      buffer += value;
      for (;;) {
        const boundary = frameBoundary(buffer);
        if (!boundary || signal.aborted) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const message = parseFrame(frame);
        if (message) onMessage(message);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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
 * Whether a failed request will fail the same way when repeated: a 4xx
 * other than a timeout (408) or a rate limit (429). A deleted session or
 * revoked access is said, not retried behind "Connection lost". A refused
 * command (a 200 receipt) is not a failed request.
 */
export function isPermanentFailure(error: unknown): boolean {
  if (!(error instanceof CatamorphicError)) return false;
  const status = error.status;
  if (status === undefined || status < 400 || status >= 500) return false;
  return status !== 408 && status !== 429;
}

/**
 * How many session streams one origin keeps open at once. A browser gives
 * an HTTP/1.1 origin six connections and every open stream holds one, so
 * a host with many chats mounted would starve its own requests. Readers
 * past the limit poll instead until a slot frees.
 */
export const MAX_SESSION_STREAMS = 4;

/**
 * What stream slots are counted by: the origin of an API base URL, since
 * the browser's connection limit is per origin however many API clients
 * (one per project, one per dock) reach it.
 */
export function streamSlotKey(baseUrl: string): string {
  try {
    const origin = new URL(baseUrl, globalThis.location?.href).origin;
    return origin === "null" ? baseUrl : origin;
  } catch {
    return baseUrl;
  }
}

/** One reader's claim on a stream slot. */
export interface StreamSlot {
  /** The slot is this reader's now; false while it waits for one. */
  readonly held: boolean;
  /**
   * Give the slot up, or stop waiting for one. A held slot passes to the
   * reader that has waited longest. Safe to call more than once.
   */
  release: () => void;
}

interface StreamSlots {
  used: number;
  waiting: Array<() => void>;
}

const streamSlots = new Map<string, StreamSlots>();

/**
 * Take one of `key`'s stream slots (see {@link streamSlotKey}). When all
 * are taken the reader waits: a freed slot passes straight to the reader
 * that has waited longest, and `onGranted` tells it. A reader handed a
 * slot it no longer needs releases it, so it passes on again and no
 * waiting reader is left polling beside a free slot.
 */
export function acquireStreamSlot(
  key: string,
  onGranted: () => void,
): StreamSlot {
  let slots = streamSlots.get(key);
  if (!slots) {
    slots = { used: 0, waiting: [] };
    streamSlots.set(key, slots);
  }
  const owned = slots;
  let held = false;
  let done = false;
  const grant = () => {
    held = true;
    onGranted();
  };
  if (owned.used < MAX_SESSION_STREAMS) {
    owned.used += 1;
    held = true;
  } else owned.waiting.push(grant);
  return {
    get held() {
      return held && !done;
    },
    release: () => {
      if (done) return;
      done = true;
      if (!held) {
        owned.waiting = owned.waiting.filter((entry) => entry !== grant);
        return;
      }
      const next = owned.waiting.shift();
      if (next) {
        next();
        return;
      }
      owned.used -= 1;
      if (owned.used === 0) streamSlots.delete(key);
    },
  };
}
