import { describe, expect, it } from "vitest";
import {
  MACHINE_TRIGGER_KINDS,
  machineProjectEvent,
} from "./machine-trigger-kinds.js";

const machine = {
  name: "review-pr-7",
  ref: "i-0abc",
  managed: true,
  labels: { pool: "review" },
  for: [{ project: "7e0f7c3e-9a55-4d0b-8a35-0c0f4b1f2a10", key: "pr-7" }],
  options: { instanceType: "r7i.2xlarge" },
  reason: "Pull request 7 is open",
};

describe("machine event kinds (ADR 0349)", () => {
  it("registers lifecycle events only: no kind makes or removes a machine", () => {
    expect(MACHINE_TRIGGER_KINDS.map((kind) => kind.name)).toEqual([
      "machine.created",
      "machine.connected",
      "machine.lost",
      "machine.stopped",
      "machine.started",
      "machine.released",
      "machine.destroyed",
      "machine.disk-low",
    ]);
    for (const kind of MACHINE_TRIGGER_KINDS) expect(kind.hostOnly).toBe(true);
  });

  it("records each transition with the machine as the plan described it, and narrows by labels", () => {
    const event = machineProjectEvent({
      kind: "machine.released",
      at: "2026-11-20T10:00:00.000Z",
      machine,
    });
    expect(event).toEqual({
      source: "machines",
      kind: "machine.released",
      externalId:
        "machine.released:review-pr-7:i-0abc:2026-11-20T10:00:00.000Z",
      occurredAt: "2026-11-20T10:00:00.000Z",
      payload: machine,
    });
    const released = MACHINE_TRIGGER_KINDS.find(
      (kind) => kind.name === "machine.released",
    );
    const envelope = {
      id: "e1",
      sequence: 1,
      projectId: "p",
      receivedAt: event.occurredAt,
      ...event,
    };
    expect(released?.validatePayload(envelope)).toEqual({ ok: true });
    expect(
      released?.matches?.({
        config: { labels: { pool: "review" } },
        payload: envelope,
      }),
    ).toBe(true);
    expect(
      released?.matches?.({
        config: { labels: { pool: "desk" } },
        payload: envelope,
      }),
    ).toBe(false);
    expect(released?.matches?.({ config: {}, payload: envelope })).toBe(true);
  });

  it("records a machine short of disk once per episode, with its report (ADR 0336)", () => {
    const disk = {
      path: "/var/lib/docker",
      totalBytes: 100e9,
      freeBytes: 4e9,
      floorBytes: 10e9,
      measuredAt: "2026-11-18T10:00:00.000Z",
    };
    const event = (episode: string) =>
      machineProjectEvent({
        kind: "machine.disk-low",
        at: episode,
        machine: { ...machine, disk },
      });
    const first = event("2026-11-18T10:00:00.000Z");
    expect(first.externalId).toBe(
      "machine.disk-low:review-pr-7:i-0abc:2026-11-18T10:00:00.000Z",
    );
    expect(event("2026-11-18T12:00:00.000Z").externalId).not.toBe(
      first.externalId,
    );
    const kind = MACHINE_TRIGGER_KINDS.find(
      (entry) => entry.name === "machine.disk-low",
    );
    expect(
      kind?.validatePayload({
        id: "e2",
        sequence: 2,
        projectId: "p",
        receivedAt: first.occurredAt,
        ...first,
      }),
    ).toEqual({ ok: true });
    expect(first.payload).toMatchObject({ disk });
  });
});
