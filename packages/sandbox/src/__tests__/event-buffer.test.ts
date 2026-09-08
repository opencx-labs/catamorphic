import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { AgentEventBuffer } from "../coding-agent/event-buffer.js";
import type { AgentRuntimeEvent } from "../coding-agent/runtime-types.js";

const event = (sequence: number, message = "test"): AgentRuntimeEvent => ({
  type: "diagnostic",
  eventId: String(sequence),
  sequence,
  sessionId: "session",
  occurredAt: "2026-09-08T00:00:00Z",
  diagnostic: { level: "info", message },
});

describe("agent event retention", () => {
  it("expires stale cursors explicitly instead of silently dropping events", async () => {
    const events = new AgentEventBuffer({ maxEvents: 2 });
    for (let sequence = 1; sequence <= 100; sequence++)
      events.push(event(sequence));
    await expect(
      events.subscribe({ sessionId: "session" }).next(),
    ).rejects.toThrow("cursor 0 expired");
    const stream = events.subscribe({
      sessionId: "session",
      after: { sequence: 98 },
    });
    expect((await stream.next()).value?.sequence).toBe(99);
    expect((await stream.next()).value?.sequence).toBe(100);
    await stream.return?.();
  });

  it("bounds bytes as well as count, including slow subscribers", async () => {
    const events = new AgentEventBuffer({ maxBytes: 400 });
    events.push(event(1));
    const stream = events.subscribe({ sessionId: "session" });
    expect((await stream.next()).value?.sequence).toBe(1);
    events.push(event(2, "x".repeat(500)));
    events.push(event(3));
    await expect(stream.next()).rejects.toThrow("expired");
  });

  it("return and abort wake pending next calls without stopping the session", async () => {
    const events = new AgentEventBuffer();
    const controller = new AbortController();
    const stream = events.subscribe({
      sessionId: "session",
      signal: controller.signal,
    });
    const pending = stream.next();
    await stream.return?.();
    expect((await pending).done).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const aborted = events.subscribe({
      sessionId: "session",
      signal: controller.signal,
    });
    const waiting = aborted.next();
    controller.abort();
    expect((await waiting).done).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    events.push(event(1));
    events.close();
    const collected = [];
    for await (const item of events.subscribe({ sessionId: "session" }))
      collected.push(item.sequence);
    expect(collected).toEqual([1]);
  });
});
