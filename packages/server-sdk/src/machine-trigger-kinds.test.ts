import { describe, expect, it } from "vitest";
import {
  MACHINE_TRIGGER_KINDS,
  machineCreate,
  machineCreateResult,
  machineDestroyResult,
  machineProjectEvent,
} from "./machine-trigger-kinds.js";

describe("machine trigger kinds (ADR 0327)", () => {
  it("registers create, destroy and the seven lifecycle events", () => {
    expect(MACHINE_TRIGGER_KINDS.map((kind) => kind.name)).toEqual([
      "machine.create",
      "machine.destroy",
      "machine.created",
      "machine.connected",
      "machine.lost",
      "machine.released",
      "machine.destroyed",
      "machine.disk-low",
      "machine.disk-too-small",
    ]);
    expect(machineCreate.outputJsonSchema).toBeDefined();
  });

  it("reads a create answer as a ref or a refusal, and nothing else", () => {
    expect(machineCreateResult({ ref: "i-0abc" })).toEqual({ ref: "i-0abc" });
    expect(machineCreateResult({ refused: "no capacity" })).toEqual({
      refused: "no capacity",
    });
    for (const output of [null, {}, { ref: 7 }, "i-0abc"])
      expect(machineCreateResult(output)).toBeUndefined();
    expect(machineDestroyResult({ done: true })).toEqual({ done: true });
    expect(machineDestroyResult({ done: "yes" })).toBeUndefined();
  });

  it("records each transition once per machine, and narrows by class", () => {
    const event = machineProjectEvent({
      kind: "machine.released",
      name: "review-1",
      class: "review",
      rule: "review",
      ref: "i-0abc",
      occurredAt: new Date("2026-11-17T10:00:00Z"),
    });
    expect(event).toEqual({
      source: "machines",
      kind: "machine.released",
      externalId: "machine.released:review-1:i-0abc",
      occurredAt: "2026-11-17T10:00:00.000Z",
      payload: {
        name: "review-1",
        class: "review",
        rule: "review",
        ref: "i-0abc",
      },
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
        config: { classes: ["review"] },
        payload: envelope,
      }),
    ).toBe(true);
    expect(
      released?.matches?.({ config: { classes: ["desk"] }, payload: envelope }),
    ).toBe(false);
  });

  it("records a machine short of disk once per episode, with its report (ADR 0335)", () => {
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
        name: "review-1",
        class: "review",
        rule: "review",
        ref: "i-0abc",
        occurredAt: new Date(episode),
        disk,
        episode: new Date(episode),
      });
    const first = event("2026-11-18T10:00:00Z");
    expect(first.externalId).toBe(
      "machine.disk-low:review-1:i-0abc:2026-11-18T10:00:00.000Z",
    );
    expect(event("2026-11-18T12:00:00Z").externalId).not.toBe(first.externalId);
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
