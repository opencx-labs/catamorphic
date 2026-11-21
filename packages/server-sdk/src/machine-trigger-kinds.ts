import type { JsonObject } from "@catamorphic/db";
import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

/**
 * Machine lifecycle events (ADR 0347): what happened to a Work server's
 * machines, for a project's own workflows (bookkeeping, alerts). Nothing
 * Work needs depends on them: machines are decided and made by the host's
 * `machines` hook, never by a workflow Work starts and reads later.
 */

/** The project event source machine lifecycle events carry. */
export const MACHINE_EVENT_SOURCE = "machines";

export const MACHINE_EVENT_KINDS = [
  "machine.created",
  "machine.connected",
  "machine.lost",
  "machine.stopped",
  "machine.started",
  "machine.released",
  "machine.destroyed",
  "machine.disk-low",
] as const;
export type MachineEventKind = (typeof MACHINE_EVENT_KINDS)[number];

const DESCRIPTIONS: Record<MachineEventKind, string> = {
  "machine.created":
    "The host's machines hook created a machine: its ref is recorded.",
  "machine.connected":
    "A machine's worker called the server for the first time.",
  "machine.lost":
    "A machine was unseen for its loss limit: its work is retired, and its chats continue from their last save. One the plan still names is made again.",
  "machine.stopped": "A machine was stopped; its disk is kept.",
  "machine.started":
    "A stopped machine was started again and its worker reconnected.",
  "machine.released":
    "The plan no longer names a machine: it takes no new work, and is destroyed once it holds none.",
  "machine.destroyed": "The machines hook confirmed a machine is gone.",
  "machine.disk-low":
    "A machine has less free disk than its floor, once per episode (ADR 0336): it takes no new workspaces until there is room. input.payload.disk has its path, totalBytes, freeBytes, floorBytes and measuredAt.",
};

/** A machine's disk report, on `machine.disk-low` (ADR 0336). */
const machineDisk = z.object({
  path: z.string(),
  totalBytes: z.number(),
  freeBytes: z.number(),
  floorBytes: z.number(),
  measuredAt: z.string(),
});

const machinePrincipal = z.union([
  z.object({ user: z.string() }),
  z.object({ project: z.string(), key: z.string() }),
  z.object({ project: z.string() }),
]);

const machineEvent = z.object({
  name: z.string(),
  ref: z.string().nullable(),
  /** Made by the machines hook; false for one enrolled by hand. */
  managed: z.boolean(),
  labels: z.record(z.string(), z.string()),
  /** Whom it is for; null for anyone. */
  for: z.array(machinePrincipal).nullable(),
  /** The options it was created with. */
  options: z.record(z.string(), z.unknown()),
  reason: z.string().nullable(),
  disk: machineDisk.optional(),
});

const config = z.strictObject({
  /** Only machines carrying all of these labels. */
  labels: z.record(z.string(), z.string()).optional(),
});

/**
 * Machine lifecycle events, delivered to the projects a machine is for.
 * The kinds a Work server registers.
 */
export const MACHINE_TRIGGER_KINDS = MACHINE_EVENT_KINDS.map((kind) =>
  defineTriggerKind({
    name: kind,
    modes: ["async"],
    // Recorded by the server only; a forged one would mislead bookkeeping.
    hostOnly: true,
    display: { label: kind.slice(8), icon: "server" },
    description: `${DESCRIPTIONS[kind]} input.payload has the machine's name, ref, labels, for, options and reason. Config labels narrows to machines carrying those labels.`,
    payload: z.object({
      id: z.string(),
      sequence: z.number(),
      projectId: z.string(),
      source: z.literal(MACHINE_EVENT_SOURCE),
      kind: z.literal(kind),
      externalId: z.string(),
      occurredAt: z.string(),
      receivedAt: z.string(),
      payload: machineEvent,
    }),
    config,
    deliveryKey: (event) => event.id,
    matches: ({ config, payload: event }) =>
      Object.entries(config.labels ?? {}).every(
        ([key, value]) => event.payload.labels[key] === value,
      ),
  }),
);

/**
 * The project event for one machine transition, ready for
 * `core.projectEvents.append`. A transition is recorded once per machine
 * and moment: the external id names the kind, the machine, its ref and
 * when it happened.
 */
export function machineProjectEvent(args: {
  kind: MachineEventKind;
  /** ISO 8601. */
  at: string;
  machine: z.input<typeof machineEvent>;
}): {
  source: typeof MACHINE_EVENT_SOURCE;
  kind: MachineEventKind;
  externalId: string;
  occurredAt: string;
  payload: JsonObject;
} {
  const payload: JsonObject = JSON.parse(
    JSON.stringify(machineEvent.parse(args.machine)),
  );
  return {
    source: MACHINE_EVENT_SOURCE,
    kind: args.kind,
    externalId: `${args.kind}:${args.machine.name}:${args.machine.ref ?? "none"}:${args.at}`,
    occurredAt: args.at,
    payload,
  };
}
