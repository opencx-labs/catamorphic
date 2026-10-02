import { describe, expect, it } from "vitest";
import {
  acquireStreamSlot,
  MAX_SESSION_STREAMS,
  parseFrame,
  speaksSessionProtocol,
} from "./session-stream.js";

describe("session streams", () => {
  it("reads a frame's data lines and skips comments", () => {
    expect(parseFrame(": keepalive")).toBeUndefined();
    expect(
      parseFrame('id: 7\ndata: {"type":"heartbeat",\ndata: "sequence":7}'),
    ).toEqual({ type: "heartbeat", sequence: 7 });
  });

  it("keeps a client's open streams under the browser's connection limit", () => {
    const client = {};
    const held = Array.from({ length: MAX_SESSION_STREAMS }, () =>
      acquireStreamSlot(client, () => {}),
    );
    expect(held.every((slot) => slot.release)).toBe(true);
    let freed = 0;
    const waiting = acquireStreamSlot(client, () => {
      freed += 1;
    });
    expect(waiting.release).toBeNull();
    held[0]?.release?.();
    expect(freed).toBe(1);
    expect(acquireStreamSlot(client, () => {}).release).not.toBeNull();
    // Another client has its own slots.
    expect(acquireStreamSlot({}, () => {}).release).not.toBeNull();
  });

  it("refuses a server on another session protocol", () => {
    expect(speaksSessionProtocol({ agentProtocol: { session: 1 } })).toBe(true);
    expect(speaksSessionProtocol({ agentProtocol: { session: 2 } })).toBe(
      false,
    );
    expect(speaksSessionProtocol({})).toBe(false);
  });
});
