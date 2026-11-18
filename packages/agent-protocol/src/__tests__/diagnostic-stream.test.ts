import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticStream } from "../runner.js";

describe("diagnosticStream (ADR 0333)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a harness's log lines at most once a second, as diagnostic events", () => {
    vi.useFakeTimers();
    const events: Array<{ level: string; message: string }> = [];
    const log = diagnosticStream({
      emit: (event) => events.push(event),
      prefix: "opencode: ",
    });
    log.write("starting\nconnecting to ");
    log.write("github\n\n");
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([
      {
        type: "diagnostic",
        level: "info",
        message: "opencode: starting\nopencode: connecting to github",
      },
    ]);
    // A partial line goes out when the attempt ends.
    log.write("stuck on a tool call");
    log.flush();
    expect(events.at(-1)?.message).toBe("opencode: stuck on a tool call");
  });

  it("keeps the newest of a burst", () => {
    vi.useFakeTimers();
    const events: Array<{ message: string }> = [];
    const log = diagnosticStream({
      emit: (event) => events.push(event),
      maxBytes: 40,
    });
    for (let line = 0; line < 500; line++) log.write(`line ${line}\n`);
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.message.endsWith("line 499")).toBe(true);
    expect(events[0]?.message.length).toBeLessThanOrEqual(41);
  });
});
