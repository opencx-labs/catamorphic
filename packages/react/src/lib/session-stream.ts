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
