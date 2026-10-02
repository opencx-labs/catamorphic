import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { StoredSessionEvent } from "@catamorphic/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventStream } from "../session-event-stream.js";

/** The parts of a ServerResponse the stream uses, recorded. */
class FakeResponse extends EventEmitter {
  head: { status: number; headers: Record<string, unknown> } | undefined;
  readonly chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  /** What `write` answers: false while the socket is buffering. */
  writable = true;

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.head = { status, headers };
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.writable;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}

function event(sequence: number): StoredSessionEvent {
  return {
    sessionId: "s1",
    sequence,
    at: "2026-10-02T00:00:00.000Z",
    commandId: null,
    event: { type: "session.changed", session: { title: `t${sequence}` } },
  };
}

function stream(raw: FakeResponse, sequence = 0) {
  return new SessionEventStream({
    raw: raw as unknown as ServerResponse,
    sequence,
    heartbeatMs: 1_000,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionEventStream", () => {
  it("holds frames until the response opens, then writes them with ids", () => {
    const raw = new FakeResponse();
    const sse = stream(raw);
    expect(sse.send({ type: "events", events: [event(1), event(2)] })).toBe(
      true,
    );
    expect(raw.chunks).toEqual([]);
    sse.open({ "access-control-allow-origin": "*", "content-length": 3 });
    expect(raw.head?.status).toBe(200);
    expect(raw.head?.headers).toMatchObject({
      "access-control-allow-origin": "*",
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    });
    expect(raw.chunks).toEqual([
      `id: 2\ndata: ${JSON.stringify({ type: "events", events: [event(1), event(2)] })}\n\n`,
    ]);
    sse.end();
  });

  it("says it is open at once when nothing waited", () => {
    const raw = new FakeResponse();
    const sse = stream(raw, 7);
    sse.open({});
    expect(raw.chunks).toEqual([
      `data: ${JSON.stringify({ type: "heartbeat", sequence: 7 })}\n\n`,
    ]);
    sse.end();
  });

  it("reports a buffering socket so slow readers are closed", () => {
    const raw = new FakeResponse();
    const sse = stream(raw);
    sse.open({});
    raw.writable = false;
    expect(sse.send({ type: "events", events: [event(1)] })).toBe(false);
    sse.end();
    expect(raw.writableEnded).toBe(true);
  });

  it("sends a heartbeat with the stream's sequence while idle", () => {
    vi.useFakeTimers();
    const raw = new FakeResponse();
    const sse = stream(raw, 4);
    sse.open({});
    sse.send({ type: "events", events: [event(5)] });
    vi.advanceTimersByTime(1_000);
    expect(raw.chunks.at(-1)).toBe(
      `data: ${JSON.stringify({ type: "heartbeat", sequence: 5 })}\n\n`,
    );
    sse.end();
    vi.advanceTimersByTime(5_000);
    // The heartbeat on opening, the event, the interval's heartbeat.
    expect(raw.chunks).toHaveLength(3);
  });

  it("releases the subscription when the client goes away", () => {
    const raw = new FakeResponse();
    const sse = stream(raw);
    const unsubscribe = vi.fn();
    sse.attach(unsubscribe);
    sse.open({});
    raw.destroyed = true;
    raw.emit("close");
    expect(unsubscribe).toHaveBeenCalledOnce();
    // A subscription that arrives after the stream ended is released at once.
    const late = vi.fn();
    sse.attach(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("flushes and ends a stream the core closed before it opened", () => {
    const raw = new FakeResponse();
    const sse = stream(raw);
    sse.send({ type: "events", events: [event(1)] });
    sse.end();
    expect(raw.writableEnded).toBe(false);
    sse.open({});
    expect(raw.chunks).toHaveLength(1);
    expect(raw.writableEnded).toBe(true);
  });
});
