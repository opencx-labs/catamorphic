import type { ServerResponse } from "node:http";
import type { SessionStreamMessage } from "@catamorphic/agent-protocol";

/** How often an idle stream says it is still there. */
export const SESSION_STREAM_HEARTBEAT_MS = 15_000;

/**
 * One session's event stream as server-sent events (ADR 0197). Each
 * {@link SessionStreamMessage} is one SSE message, `data: <JSON>`, whose
 * `id:` is the stream's sequence after it, so a reconnecting EventSource
 * resumes from `Last-Event-ID`.
 *
 * The core subscription starts sending (the gap after the cursor) before
 * the route knows the caller may read the session, so frames wait here
 * until {@link open} writes the response head; a refusal is then still an
 * ordinary HTTP error.
 */
export class SessionEventStream {
  private readonly raw: ServerResponse;
  private readonly heartbeatMs: number;
  private sequence: number;
  /** Frames sent before the response opened; null once it has. */
  private buffered: string[] | null = [];
  private unsubscribe: (() => void) | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private ended = false;

  constructor(input: {
    raw: ServerResponse;
    /** The cursor the stream starts after. */
    sequence: number;
    heartbeatMs?: number;
  }) {
    this.raw = input.raw;
    this.sequence = input.sequence;
    this.heartbeatMs = input.heartbeatMs ?? SESSION_STREAM_HEARTBEAT_MS;
    // The response closes when the client goes away or the stream ends.
    this.raw.on("close", () => this.end());
  }

  /** Hold the core subscription; a stream that already ended releases it. */
  attach(unsubscribe: () => void): void {
    if (this.ended) unsubscribe();
    else this.unsubscribe = unsubscribe;
  }

  /**
   * Write one message. False when the socket is buffering: the core
   * subscription counts what waits and closes a reader that falls too far
   * behind (it resumes from its cursor).
   */
  send(message: SessionStreamMessage): boolean {
    if (this.ended) return true;
    const frame = this.frame(message);
    if (this.buffered) {
      this.buffered.push(frame);
      return true;
    }
    return this.raw.write(frame);
  }

  /** Write the response head (with the reply's own headers) and what waited. */
  open(headers: Record<string, string | number | string[] | undefined>): void {
    const frames = this.buffered ?? [];
    this.buffered = null;
    if (this.raw.destroyed) {
      this.end();
      return;
    }
    const own: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers))
      if (value !== undefined)
        own[name] = typeof value === "number" ? String(value) : value;
    this.raw.writeHead(200, {
      ...own,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Proxies that buffer responses (nginx) would hold the stream back.
      "x-accel-buffering": "no",
    });
    // The client learns the stream is open before the first event.
    this.raw.flushHeaders();
    for (const frame of frames) this.raw.write(frame);
    if (this.ended) {
      this.raw.end();
      return;
    }
    this.heartbeat = setInterval(() => {
      this.send({ type: "heartbeat", sequence: this.sequence });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** End the stream: release the subscription and close the response. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // Before it opened, `open` ends the response after flushing.
    if (!this.buffered && !this.raw.writableEnded) this.raw.end();
  }

  private frame(message: SessionStreamMessage): string {
    const sequence =
      message.type === "events"
        ? message.events.at(-1)?.sequence
        : message.type === "reset"
          ? message.snapshot.sequence
          : undefined;
    if (sequence === undefined) return `data: ${JSON.stringify(message)}\n\n`;
    this.sequence = sequence;
    return `id: ${sequence}\ndata: ${JSON.stringify(message)}\n\n`;
  }
}
