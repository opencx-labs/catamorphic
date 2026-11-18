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

  it("keeps the newest whole lines of a burst, never part of one", () => {
    vi.useFakeTimers();
    const events: Array<{ message: string }> = [];
    const log = diagnosticStream({
      emit: (event) => events.push(event),
      maxBytes: 40,
    });
    for (let line = 0; line < 500; line++) log.write(`line ${line}\n`);
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(1);
    const lines = events[0]?.message.split("\n") ?? [];
    expect(lines[0]).toMatch(/^\[\d+ earlier lines were left out\]$/);
    expect(lines.at(-1)).toBe("line 499");
    for (const line of lines.slice(1)) expect(line).toMatch(/^line \d+$/);
  });

  it("leaves a line too long to keep out whole, so no cut keeps part of a secret", () => {
    vi.useFakeTimers();
    const events: Array<{ message: string }> = [];
    const log = diagnosticStream({
      emit: (event) => events.push(event),
      maxLineChars: 50,
    });
    const secret = "sk-live-0123456789abcdef";
    // A line that ends past the limit, and one written in pieces.
    log.write(`${"x".repeat(40)} token=${secret}\n`);
    log.write(`${"y".repeat(45)} tok`);
    log.write(`en=${secret}`);
    log.write(" still going\nshort line\n");
    log.flush();
    const all = events.map((event) => event.message).join("\n");
    expect(all).not.toContain("sk-live");
    expect(all).not.toContain("0123");
    expect(all).toContain("[a 71-character line was left out]");
    expect(all).toContain("[a 88-character line was left out]");
    expect(all).toContain("short line");
  });
});
