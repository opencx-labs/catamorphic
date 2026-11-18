import { describe, expect, it } from "vitest";
import {
  MACHINE_TRIGGER_KINDS,
  machineCreate,
  machineCreateResult,
  machineDestroyResult,
  machineProjectEvent,
} from "./machine-trigger-kinds.js";

describe("machine trigger kinds (ADR 0327)", () => {
  it("registers create, destroy and the five lifecycle events", () => {
    expect(MACHINE_TRIGGER_KINDS.map((kind) => kind.name)).toEqual([
      "machine.create",
      "machine.destroy",
      "machine.created",
      "machine.connected",
      "machine.lost",
      "machine.released",
      "machine.destroyed",
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
});
