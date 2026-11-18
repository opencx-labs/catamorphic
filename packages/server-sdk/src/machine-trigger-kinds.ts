import type { JsonObject } from "@catamorphic/db";
import { z } from "zod";
import { defineTriggerKind } from "./define-trigger-kind.js";

/**
 * Machine provisioners as workflows (ADR 0327): a `workflow` machine class
 * names a project and two of its workflows, bound to `machine.create` and
 * `machine.destroy`, which the Work server's reconciler starts.
 */

/** What a create run is given: the `machineProvisioner` hook's argument. */
const createPayload = z.object({
  /** The machine's name; a later machine of the rule may reuse it. */
  name: z.string(),
  class: z.string(),
  /** The rule the machine is for. */
  rule: z.string(),
  /** The class's `options` from `WORK_MACHINES_CONFIG`, as written. */
  options: z.record(z.string(), z.unknown()).optional(),
  /** What the work waiting for this machine needs; absent for a warm one. */
  waiting: z
    .object({
      resources: z.object({
        cpuMillis: z.number().optional(),
        memoryMb: z.number().optional(),
        storageMb: z.number().optional(),
        gpu: z.boolean().optional(),
      }),
      capabilities: z.array(z.string()),
    })
    .optional(),
  /** Labels the machine's worker carries. */
  labels: z.record(z.string(), z.string()),
  enrollment: z.object({
    controlPlaneUrl: z.string(),
    /** The one-time enrollment code; never log it. */
    code: z.string(),
    /** A hash of `code` (64 hex characters): the platform's idempotency token. */
    idempotencyKey: z.string(),
    /** Cloud-init user data that installs the worker with this code. */
    cloudInit: z.string().optional(),
  }),
});

/** A machine was made (`ref`, the platform's id), or the platform refused. */
const createOutput = z.union([
  z.object({ ref: z.string() }),
  z.object({ refused: z.string() }),
]);

const destroyPayload = z.object({
  name: z.string(),
  class: z.string(),
  rule: z.string(),
  /** The ref create returned; null when none is known. */
  ref: z.string().nullable(),
  /**
   * The idempotency key its create was given, which finds a machine whose
   * launch answer was lost even after tags or the class changed.
   */
  idempotencyKey: z.string().nullable(),
  /**
   * The latest moment a launch can have been made (ISO 8601): when its
   * create run ended, else when its create was asked for, else when Work
   * first asked to destroy it. A platform that lists new machines late
   * should not call one gone this soon after.
   */
  requestedAt: z.string().nullable(),
  options: z.record(z.string(), z.unknown()).optional(),
});

/** Done once no machine with this ref or name is left. */
const destroyOutput = z.object({ done: z.boolean() });

export type MachineCreateRequest = z.output<typeof createPayload>;
export type MachineCreateResult = z.output<typeof createOutput>;
export type MachineDestroyRequest = z.output<typeof destroyPayload>;
export type MachineDestroyResult = z.output<typeof destroyOutput>;

/** Parse a create run's output; undefined when it is not one. */
export function machineCreateResult(
  value: unknown,
): MachineCreateResult | undefined {
  const parsed = createOutput.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Parse a destroy run's output; undefined when it is not one. */
export function machineDestroyResult(
  value: unknown,
): MachineDestroyResult | undefined {
  const parsed = destroyOutput.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const machineCreate = defineTriggerKind({
  name: "machine.create",
  modes: ["async"],
  // Its input carries an enrollment code and what the machine boots.
  hostOnly: true,
  display: { label: "create machine", icon: "server" },
  description:
    "Create one worker machine for a workflow machine class. input.enrollment.cloudInit is user data that installs the worker; input.enrollment.idempotencyKey is the platform's idempotency token (Work never asks twice for one key, but a retried step may). input.options is the class's options. Return { ref } with the platform's id, or { refused: reason } when the platform created nothing.",
  payload: createPayload,
  output: createOutput,
  // One create per enrollment, for all time: a create started again
  // answers with its first run, whatever its status (ADR 0325).
  deliveryKey: (payload) =>
    `machine-create:${payload.enrollment.idempotencyKey}`,
});

export const machineDestroy = defineTriggerKind({
  name: "machine.destroy",
  modes: ["async"],
  hostOnly: true,
  display: { label: "destroy machine", icon: "trash-2" },
  description:
    "Destroy the machine input.ref names, every machine named input.name, and any launched with input.idempotencyKey. Return { done: true } only once none is left; { done: false } while a destruction is under way, or while a machine requested at input.requestedAt may not be listed yet, and Work asks again.",
  payload: destroyPayload,
  output: destroyOutput,
});

/** The project event source machine lifecycle events carry (ADR 0327). */
export const MACHINE_EVENT_SOURCE = "machines";

export const MACHINE_EVENT_KINDS = [
  "machine.created",
  "machine.connected",
  "machine.lost",
  "machine.released",
  "machine.destroyed",
  "machine.disk-low",
  "machine.disk-too-small",
] as const;
export type MachineEventKind = (typeof MACHINE_EVENT_KINDS)[number];

const DESCRIPTIONS: Record<MachineEventKind, string> = {
  "machine.created":
    "A machine of a workflow class was created: its ref is recorded.",
  "machine.connected":
    "A machine's worker called the server for the first time.",
  "machine.lost":
    "A machine on demand was not seen for its rule's enrollMinutes; it is revoked and replaced.",
  "machine.released":
    "A machine serves nobody any more; it is destroyed after its retention.",
  "machine.destroyed": "A machine's destroy workflow answered that it is gone.",
  "machine.disk-low":
    "A machine has less free disk than its floor, once per episode (ADR 0335): it takes no new workspaces until there is room. input.payload.disk has its path, totalBytes, freeBytes, floorBytes and measuredAt; input.payload.options is the class's options.",
  "machine.disk-too-small":
    "A rule's machines came up short of disk soon after connecting (ADR 0335): the class's disk is too small for the rule's work, and the rule makes no new machines for an hour or until it is written again. input.payload.name and rule name the rule; input.payload.options is the class's options.",
};

/** A machine's disk report, on `machine.disk-low` (ADR 0335). */
const machineDisk = z.object({
  path: z.string(),
  totalBytes: z.number(),
  freeBytes: z.number(),
  floorBytes: z.number(),
  measuredAt: z.string(),
});

const machineEvent = z.object({
  name: z.string(),
  class: z.string(),
  rule: z.string(),
  ref: z.string().nullable(),
  disk: machineDisk.optional(),
  /**
   * `machine.disk-low` only: the class's `options` as written, which its
   * create and destroy runs are given too, so a workflow can act on it.
   */
  options: z.record(z.string(), z.unknown()).optional(),
});

const config = z.strictObject({
  /** Only machines of these classes. */
  classes: z.array(z.string()).min(1).optional(),
});

/** Machine lifecycle events, delivered to the class's project. */
export const MACHINE_EVENT_TRIGGER_KINDS = MACHINE_EVENT_KINDS.map((kind) =>
  defineTriggerKind({
    name: kind,
    modes: ["async"],
    // Recorded by the server only; a forged one would mislead bookkeeping.
    hostOnly: true,
    display: { label: kind.slice(8), icon: "server" },
    description: `${DESCRIPTIONS[kind]} input.payload has the machine's name, class, rule and ref. Config classes narrows to machines of those classes.`,
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
      !config.classes || config.classes.includes(event.payload.class),
  }),
);

/** The kinds a Work server registers for workflow machine classes. */
export const MACHINE_TRIGGER_KINDS = [
  machineCreate,
  machineDestroy,
  ...MACHINE_EVENT_TRIGGER_KINDS,
];

/**
 * The project event for one machine transition, ready for
 * `core.projectEvents.append`. A transition is recorded once per machine:
 * the external id names the kind, the machine and its ref.
 */
export function machineProjectEvent(args: {
  kind: MachineEventKind;
  name: string;
  class: string;
  rule: string;
  ref: string | null;
  occurredAt: Date;
  /**
   * `machine.disk-low` only: the report that began the episode, and when
   * it began, which makes the event one per episode.
   */
  disk?: z.output<typeof machineDisk>;
  episode?: Date;
  options?: JsonObject;
}): {
  source: typeof MACHINE_EVENT_SOURCE;
  kind: MachineEventKind;
  externalId: string;
  occurredAt: string;
  payload: JsonObject;
} {
  return {
    source: MACHINE_EVENT_SOURCE,
    kind: args.kind,
    externalId: `${args.kind}:${args.name}:${args.ref ?? "none"}${
      args.episode ? `:${args.episode.toISOString()}` : ""
    }`,
    occurredAt: args.occurredAt.toISOString(),
    payload: {
      name: args.name,
      class: args.class,
      rule: args.rule,
      ref: args.ref,
      ...(args.disk ? { disk: { ...args.disk } } : {}),
      ...(args.options ? { options: args.options } : {}),
    },
  };
}
