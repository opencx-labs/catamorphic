import { describe, expect, it } from "vitest";
import { CatamorphicError } from "./errors.js";
import {
  acquireStreamSlot,
  isPermanentFailure,
  MAX_SESSION_STREAMS,
  parseFrame,
  speaksSessionProtocol,
  streamSlotKey,
} from "./session-stream.js";

describe("session streams", () => {
  it("reads a frame's data lines and skips comments", () => {
    expect(parseFrame(": keepalive")).toBeUndefined();
    expect(
      parseFrame('id: 7\ndata: {"type":"heartbeat",\ndata: "sequence":7}'),
    ).toEqual({ type: "heartbeat", sequence: 7 });
  });

  it("keeps an origin's open streams under the browser's connection limit", () => {
    const key = streamSlotKey("http://127.0.0.1:4100/api");
    // Every API client reaching that origin shares its slots.
    expect(
      streamSlotKey("http://127.0.0.1:4100/api/desktop/projects/p/remote-api"),
    ).toBe(key);
    const held = Array.from({ length: MAX_SESSION_STREAMS }, () =>
      acquireStreamSlot(key, () => {}),
    );
    expect(held.every((slot) => slot.held)).toBe(true);
    let granted = 0;
    const waiting = acquireStreamSlot(key, () => {
      granted += 1;
    });
    expect(waiting.held).toBe(false);
    held[0]?.release();
    // The freed slot passed straight to the waiting reader.
    expect(granted).toBe(1);
    expect(waiting.held).toBe(true);
    expect(acquireStreamSlot(key, () => {}).held).toBe(false);
    // Another origin has its own slots.
    const other = acquireStreamSlot(
      streamSlotKey("https://work.example.com/api"),
      () => {},
    );
    expect(other.held).toBe(true);
    for (const slot of [...held, waiting, other]) slot.release();
  });

  it("passes on a slot handed to a reader that no longer wants it", () => {
    const key = "test:handoff";
    const held = Array.from({ length: MAX_SESSION_STREAMS }, () =>
      acquireStreamSlot(key, () => {}),
    );
    // The first waiter went away (its chat closed) as the slot reached it.
    const gone: { slot?: ReturnType<typeof acquireStreamSlot> } = {};
    gone.slot = acquireStreamSlot(key, () => gone.slot?.release());
    let granted = 0;
    const next = acquireStreamSlot(key, () => {
      granted += 1;
    });
    held[0]?.release();
    expect(gone.slot.held).toBe(false);
    expect(granted).toBe(1);
    expect(next.held).toBe(true);
    // A reader that stops waiting is not handed a slot later.
    const cancelled = acquireStreamSlot(key, () => {
      throw new Error("granted after cancel");
    });
    cancelled.release();
    held[1]?.release();
    expect(acquireStreamSlot(key, () => {}).held).toBe(true);
  });

  it("stops retrying only what will be refused again", () => {
    const failure = (status?: number) =>
      new CatamorphicError({ code: "unknown", status });
    expect(isPermanentFailure(failure(404))).toBe(true);
    expect(isPermanentFailure(failure(403))).toBe(true);
    expect(isPermanentFailure(failure(408))).toBe(false);
    expect(isPermanentFailure(failure(429))).toBe(false);
    expect(isPermanentFailure(failure(503))).toBe(false);
    expect(isPermanentFailure(failure())).toBe(false);
    expect(isPermanentFailure(new Error("network"))).toBe(false);
  });

  it("refuses a server on another session protocol", () => {
    expect(speaksSessionProtocol({ agentProtocol: { session: 1 } })).toBe(true);
    expect(speaksSessionProtocol({ agentProtocol: { session: 2 } })).toBe(
      false,
    );
    expect(speaksSessionProtocol({})).toBe(false);
  });
});
