import { z } from "zod";

/*
 * The machines hook (ADR 0349): the one object a host passes as
 * `hooks.machines`. The host's code decides which machines should exist
 * (`plan`) and makes the calls that touch its cloud (`create`, `destroy`,
 * `stop`, `start`, `describe`). Work sequences those calls (it records its
 * intent before each, repeats it until done, and never makes one machine
 * twice across replicas), enforces safety (nothing holding live work is
 * stopped or destroyed unless it is lost) and owns liveness, enrollment and
 * capacity. Everything here is plain data, so a plan can be tested without
 * a server.
 */

/**
 * Who may place work on a machine: one user (their account id), one
 * project's own work (project chats and automations), or one chat of a
 * project by its chat key.
 */
export type MachinePrincipal =
  | { user: string }
  | { project: string }
  | { project: string; key: string };

export const MachinePrincipalSchema: z.ZodType<
  MachinePrincipal,
  MachinePrincipal
> = z.union([
  z.strictObject({ user: z.string().min(1).max(255) }),
  z.strictObject({
    project: z.uuid(),
    key: z.string().min(1).max(255),
  }),
  z.strictObject({ project: z.uuid() }),
]);

/** Labels the Work server sets on every node itself (ADR 0167). */
export const RESERVED_LABELS = ["node", "plane"] as const;

export const MachineLabelsSchema = z
  .record(
    z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9._-]{0,62}$/,
        "Label names are lowercase letters, digits, dots, dashes",
      ),
    z.string().min(1).max(128),
  )
  .refine(
    (labels) => RESERVED_LABELS.every((key) => !(key in labels)),
    `The server sets ${RESERVED_LABELS.join(" and ")} itself`,
  );

/** A machine's name: it becomes a worker name, a host name and a cloud tag. */
export const MachineNameSchema = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "Use lowercase letters, digits, and dashes between them, at most 63 characters",
  );

/** Minutes a machine that was serving may go unseen before it is lost. */
export const DEFAULT_LOST_AFTER_MINUTES = 5;

/** One machine the host wants to exist. */
export interface DesiredMachine {
  /** Stable name chosen by the host; Work matches machines by it. */
  name: string;
  /**
   * Who may place work here: users, projects, chat keys. Omitted: anyone
   * whose role and Environment allow it. An empty list: nobody (a spare).
   */
  for?: readonly MachinePrincipal[];
  /** Labels an Environment's `pool` selects on. */
  labels?: Readonly<Record<string, string>>;
  /** Default "running". "stopped" keeps the disk. */
  state?: "running" | "stopped";
  /**
   * Opaque to Work; handed to the hook's verbs. Not applied to an existing
   * machine: a new shape is a new name.
   */
  options?: Readonly<Record<string, unknown>>;
  /** The people it serves trust each other, so process isolation is enough. */
  trusted?: boolean;
  /** Minutes unreachable before Work calls it lost; the server's default is 5. */
  lostAfterMinutes?: number;
  /** Shown beside the machine, so a person can see why it exists or was stopped. */
  reason?: string;
}

export const DesiredMachineSchema = z.strictObject({
  name: MachineNameSchema,
  for: z.array(MachinePrincipalSchema).max(500).optional(),
  labels: MachineLabelsSchema.optional(),
  state: z.enum(["running", "stopped"]).optional(),
  options: z.record(z.string(), z.json()).optional(),
  trusted: z.boolean().optional(),
  lostAfterMinutes: z
    .number()
    .int()
    .min(2)
    .max(24 * 60)
    .optional(),
  reason: z.string().max(500).optional(),
});

/** What a plan may return: at most this many machines, each name once. */
export const MAX_PLANNED_MACHINES = 1_000;

export const MachinePlanSchema = z
  .array(DesiredMachineSchema)
  .max(MAX_PLANNED_MACHINES)
  .superRefine((machines, context) => {
    const seen = new Set<string>();
    for (const [index, machine] of machines.entries()) {
      if (seen.has(machine.name))
        context.addIssue({
          code: "custom",
          message: `The plan names '${machine.name}' twice; each machine has one entry`,
          path: [index, "name"],
        });
      seen.add(machine.name);
    }
  });

/**
 * Where a machine stands:
 *
 * - `starting`: Work is making it (its create may not have answered yet),
 *   or it has not connected for the first time.
 * - `serving`: connected and taking work.
 * - `draining`: the plan no longer names it; it takes no new work and is
 *   destroyed once it holds none.
 * - `stopping`, `stopped`, `resuming`: its disk is kept; it offers no
 *   capacity until it serves again.
 * - `unreachable`: it was serving and has not called since its lease lapsed.
 * - `lost`: unreachable for its limit; its work is retired.
 * - `disabled`: an operator disabled it; its work waits and it is never lost.
 * - `destroying`: Work is asking the hook to destroy it.
 */
export type MachineState =
  | "starting"
  | "serving"
  | "draining"
  | "stopping"
  | "stopped"
  | "resuming"
  | "unreachable"
  | "lost"
  | "disabled"
  | "destroying";

/** One machine Work knows, as the plan reads it. */
export interface MachineFacts {
  name: string;
  /** The platform's id from `create`; null until it answered, or for a machine enrolled by hand. */
  ref: string | null;
  /** Made through this hook. False: an operator enrolled it by hand, and Work never creates, stops or destroys it. */
  managed: boolean;
  state: MachineState;
  /** Since when it is in `state` (ISO 8601). */
  since: string;
  labels: Readonly<Record<string, string>>;
  /** Who may place work here; null for anyone. */
  for: readonly MachinePrincipal[] | null;
  trusted: boolean;
  /** The options it was created with. */
  options: Readonly<Record<string, unknown>>;
  reason: string | null;
  /** Live workspaces on it, and whose they are. */
  holding: { workspaces: number; for: readonly MachinePrincipal[] };
  /** Since when it has held no workspace while serving; null while it holds one or is not serving. */
  idleSince: string | null;
  /** When its worker last called; null before its first call. */
  lastSeenAt: string | null;
  /** What it offers, from its worker's own report; null before it first connected. */
  capacity: {
    workspaces: number;
    cpuMillis?: number;
    memoryMb?: number;
  } | null;
  /** What its workspaces reserve now. */
  usage: {
    workspaces: number;
    cpuMillis: number;
    memoryMb: number;
    storageMb: number;
  } | null;
  /** Its latest disk report; `low` once it is under its floor and takes no new work. */
  disk: {
    totalBytes: number;
    freeBytes: number;
    floorBytes: number;
    low: boolean;
  } | null;
  /** How it isolates agents; null before it first connected. */
  isolation: "process" | "sandbox" | null;
  /** Users signed in to a harness on it. */
  signedIn: readonly string[];
  /** Why Work cannot do what the plan asks yet (it holds live work, the hook has no `stop`). */
  notice: string | null;
  /** The latest failure of a verb for it, cleared when that verb next succeeds. */
  lastError: { verb: MachineVerb; message: string; at: string } | null;
}

export type MachineVerb = "create" | "destroy" | "stop" | "start" | "describe";

/** Work that has no machine yet. */
export interface WaitingWork {
  /** The chat's or run's id. */
  id: string;
  /** A chat, a workflow run, or a cache fill. */
  kind: "chat" | "run" | "fill";
  project: string;
  /** The member whose work it is; null for the project's own. */
  user: string | null;
  /** The chat key of a project's own chat, if it has one. */
  key: string | null;
  environment: string;
  /** The Environment's pool: labels a machine must carry. */
  pool: Readonly<Record<string, string>>;
  requirements: {
    resources: {
      cpuMillis?: number;
      memoryMb?: number;
      storageMb?: number;
      gpu?: boolean;
    };
    capabilities: readonly string[];
    isolation?: "none" | "process" | "sandbox";
  };
  /** No machine open to it had room (`capacity`), or none was online (`unavailable`). */
  reason: "capacity" | "unavailable";
  /** ISO 8601. */
  waitingSince: string;
}

/** One account of the server, so "everyone with role X" needs no directory. */
export interface PersonFacts {
  /** The account id: what `{ user }` names. */
  id: string;
  email: string | null;
  name: string | null;
  /** False once the account is disabled. */
  active: boolean;
  administrator: boolean;
  /** Role names by project id. */
  roles: Readonly<Record<string, readonly string[]>>;
}

/** What `plan` is given. */
export interface MachinePlanFacts {
  /** ISO 8601, by the server's database clock. */
  now: string;
  /** Work that has no machine yet. */
  work: readonly WaitingWork[];
  /** Every machine Work knows, managed by this hook or enrolled by hand. */
  machines: readonly MachineFacts[];
  /** The server's accounts with their project roles. */
  people: readonly PersonFacts[];
}

/** The machine a verb acts on. */
export interface MachineTarget {
  name: string;
  /** The ref `create` answered; null when it never did. */
  ref: string | null;
  /**
   * The idempotency key its `create` was given, which finds a machine whose
   * create answer was lost. Null for none.
   */
  idempotencyKey: string | null;
  /** The options it was created with. */
  options: Readonly<Record<string, unknown>>;
  labels: Readonly<Record<string, string>>;
}

export interface MachineCreateRequest {
  name: string;
  options: Readonly<Record<string, unknown>>;
  labels: Readonly<Record<string, string>>;
  /**
   * What the new machine starts its worker with: `WORK_CONTROL_PLANE_URL`
   * and `WORK_WORKER_ENROLLMENT`. The code is a secret: never log it.
   */
  enrollment: {
    controlPlaneUrl: string;
    code: string;
    /** The platform's idempotency token for this create: 64 hex characters. */
    idempotencyKey: string;
  };
}

/**
 * `ref`: the machine exists (or already did, for this key). `pending`: not
 * yet; Work asks again with the same request. `refused`: the platform made
 * nothing and would refuse again; Work withdraws the code, shows the
 * reason, and asks again later with a new enrollment.
 */
export type MachineCreateResult =
  | { ref: string }
  | { pending: true }
  | { refused: string };

export const MachineCreateResultSchema: z.ZodType<
  MachineCreateResult,
  MachineCreateResult
> = z.union([
  z.strictObject({ ref: z.string().min(1).max(500) }),
  z.strictObject({ pending: z.literal(true) }),
  z.strictObject({ refused: z.string().min(1).max(2_000) }),
]);

const DoneSchema = z.strictObject({ done: z.boolean() });
export const MachineDestroyResultSchema = DoneSchema;
export const MachineStopResultSchema = DoneSchema;
export const MachineStartResultSchema = z.union([
  DoneSchema,
  z.strictObject({ gone: z.literal(true) }),
]);
export const MachineDescribeResultSchema = z.strictObject({
  state: z.enum(["running", "stopped", "gone", "unknown"]),
});

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

/** Something that happened to a machine. Nothing Work needs depends on it. */
export interface MachineEvent {
  kind: MachineEventKind;
  /** ISO 8601. */
  at: string;
  machine: {
    name: string;
    ref: string | null;
    managed: boolean;
    labels: Readonly<Record<string, string>>;
    for: readonly MachinePrincipal[] | null;
    options: Readonly<Record<string, unknown>>;
    reason: string | null;
  };
  /** `machine.disk-low` only: the report that began the episode. */
  disk?: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    floorBytes: number;
    measuredAt: string;
  };
}

/**
 * The host's machines: `plan` decides, the verbs act. One provisioner per
 * hook; a host with two clouds dispatches inside its own verbs (by an
 * option or a label).
 */
export interface MachinesHook {
  /**
   * Decide: given the facts, the set of machines that should exist. It
   * changes nothing in Work; it may read the host's own config or
   * directory. Return the same names for the same facts: Work works out
   * the difference. A plan that throws, takes too long or returns
   * something invalid changes nothing, and its error is shown.
   */
  plan(args: MachinePlanFacts): Promise<readonly DesiredMachine[]>;
  /**
   * Make one machine that starts the Work worker with `enrollment`. Work
   * recorded its intent first and repeats this call with the same
   * `idempotencyKey` until it answers `ref`: hand the key to the platform
   * as its idempotency token, so a repeat returns the same machine.
   */
  create(args: MachineCreateRequest): Promise<MachineCreateResult>;
  /**
   * Remove the machine: the one `ref` names, and any made with
   * `idempotencyKey` or carrying `name` whose create answer was lost.
   * `requestedAt` is when Work first asked. Answer `done: false` while it is
   * still going, or while a machine just created may not be listed yet;
   * Work asks again.
   */
  destroy(args: MachineTarget & { requestedAt: string }): Promise<{
    done: boolean;
  }>;
  /**
   * Stop the machine and keep its disk. `requestedAt` is stable for this
   * stop request. Without a stop verb, no machine is stopped.
   */
  stop?(
    args: MachineTarget & { requestedAt: string },
  ): Promise<{ done: boolean }>;
  /**
   * Start a stopped machine; its worker connects again by itself. `gone`
   * when it no longer exists: Work treats it as lost and makes it again.
   * `requestedAt` is stable for this start request.
   */
  start?(
    args: MachineTarget & { requestedAt: string },
  ): Promise<{ done: boolean } | { gone: true }>;
  /** Lets Work confirm a loss at once instead of waiting out the limit. */
  describe?(args: MachineTarget): Promise<{
    state: "running" | "stopped" | "gone" | "unknown";
  }>;
  /**
   * Hear every machine event, to route it wherever the host likes. Work
   * also records each for the projects named in the machine's `for`.
   */
  onEvent?(event: MachineEvent): Promise<void> | void;
}

/** Whether two principals name the same thing. */
export function samePrincipal(
  left: MachinePrincipal,
  right: MachinePrincipal,
): boolean {
  if ("user" in left) return "user" in right && left.user === right.user;
  if ("user" in right) return false;
  const leftKey = "key" in left ? left.key : undefined;
  const rightKey = "key" in right ? right.key : undefined;
  return left.project === right.project && leftKey === rightKey;
}

/**
 * Whether `principal` could already place work on a machine for `list`: it
 * is named there, or it is one chat key of a project the list names.
 */
function covered(
  list: readonly MachinePrincipal[],
  principal: MachinePrincipal,
): boolean {
  return list.some(
    (entry) =>
      samePrincipal(entry, principal) ||
      ("project" in entry &&
        !("key" in entry) &&
        "project" in principal &&
        entry.project === principal.project),
  );
}

/**
 * Whether changing whom a machine is for lets someone new reach what the
 * previous owners left on it (sandboxes, volumes, sign-ins), so it must be
 * reset first. Narrowing never does; opening a machine to anyone, or to a
 * principal that could not use it before, does.
 */
export function principalsChangeNeedsReset(args: {
  from: readonly MachinePrincipal[] | null;
  to: readonly MachinePrincipal[] | null;
}): boolean {
  if (args.from === null) return false;
  if (args.to === null) return true;
  const from = args.from;
  return args.to.some((principal) => !covered(from, principal));
}

/** Principals in a stable order with duplicates removed, to compare and store. */
export function normalizePrincipals(
  principals: readonly MachinePrincipal[],
): MachinePrincipal[] {
  const key = (principal: MachinePrincipal) =>
    "user" in principal
      ? `user\0${principal.user}`
      : `project\0${principal.project}\0${"key" in principal ? principal.key : ""}`;
  const byKey = new Map(
    principals.map((principal) => [key(principal), principal]),
  );
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, principal]) => principal);
}

/** Whether two principal lists (or "anyone") are the same. */
export function samePrincipals(
  left: readonly MachinePrincipal[] | null,
  right: readonly MachinePrincipal[] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    JSON.stringify(normalizePrincipals(left)) ===
    JSON.stringify(normalizePrincipals(right))
  );
}

/**
 * One principal and nobody else: no one else's work lands on the machine,
 * so process isolation is enough and it may hold that owner's sign-ins.
 */
export function servesOneOwner(
  principals: readonly MachinePrincipal[] | null,
): boolean {
  return principals !== null && normalizePrincipals(principals).length === 1;
}

/** A machine taking no one's work: any isolation is enough. */
export function servesNobody(
  principals: readonly MachinePrincipal[] | null,
): boolean {
  return principals !== null && principals.length === 0;
}

/** Whether a machine for `principals` takes this waiting work. */
export function principalsTake(args: {
  for: readonly MachinePrincipal[] | null;
  work: Pick<WaitingWork, "project" | "user" | "key">;
}): boolean {
  if (args.for === null) return true;
  const { work } = args;
  return args.for.some((principal) => {
    if ("user" in principal) return work.user === principal.user;
    if (work.user !== null || principal.project !== work.project) return false;
    return !("key" in principal) || principal.key === work.key;
  });
}
