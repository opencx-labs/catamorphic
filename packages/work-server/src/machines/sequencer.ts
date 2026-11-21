import type { z } from "zod";
import {
  DEFAULT_LOST_AFTER_MINUTES,
  type DesiredMachine,
  MachineCreateResultSchema,
  MachineDescribeResultSchema,
  MachineDestroyResultSchema,
  type MachineEvent,
  type MachineEventKind,
  type MachineFacts,
  MachinePlanSchema,
  type MachinePrincipal,
  MachineStartResultSchema,
  type MachineState,
  MachineStopResultSchema,
  type MachinesHook,
  type MachineTarget,
  type MachineVerb,
  normalizePrincipals,
  type PersonFacts,
  principalsChangeNeedsReset,
  principalsTake,
  samePrincipals,
  servesNobody,
  servesOneOwner,
  type WaitingWork,
} from "./contract.js";

/*
 * What Work does with a plan (ADR 0347). One pass reads the facts, asks the
 * host's `plan` for the machines that should exist, and works out the
 * difference: it records its intent before every call into host code,
 * repeats each call until it is done, and never stops or destroys a
 * machine that holds live work unless it is lost. Everything it knows and
 * changes goes through a {@link MachineWorld}: the Work server's is
 * Postgres; the contract kit's is a simulation with a clock a test moves.
 */

/** Where Work stands with a machine; what it stores. */
export type MachinePhase =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "resuming"
  | "destroying";

/**
 * Minutes a resumed machine has to connect again, beyond its loss limit,
 * before it is lost: a stopped machine boots before its worker calls.
 */
export const RESUME_GRACE_MINUTES = 10;

/** A machine as the sequencer reads it: its facts and what Work keeps beside them. */
export interface MachineRecord {
  facts: MachineFacts;
  phase: MachinePhase;
  phaseSince: string;
  /** The key its create is asked with; null once refused, or for a machine enrolled by hand. */
  idempotencyKey: string | null;
  /** The plan no longer names it: it takes no new work. */
  dropped: boolean;
  /** Creates its platform refused in a row, and when the latest was (ISO 8601). */
  refused: { count: number; at: string } | null;
  /** Whom it is for once it is reset; it takes no new work until then. */
  reset: { for: readonly MachinePrincipal[] | null } | null;
  /** Resuming: its `start` answered done, and Work waits for its worker. */
  startAsked: boolean;
  /** When Work first asked to destroy it (ISO 8601). */
  destroyRequestedAt: string | null;
  /** The loss limit the plan gave it, if any. */
  lostAfterMinutes: number | null;
  /** An operator revoked its worker. */
  revoked: boolean;
}

/** A desired machine with every default filled in. */
export interface PlannedMachine {
  name: string;
  for: readonly MachinePrincipal[] | null;
  labels: Readonly<Record<string, string>>;
  state: "running" | "stopped";
  options: Readonly<Record<string, unknown>>;
  trusted: boolean;
  lostAfterMinutes: number | null;
  reason: string | null;
}

/** What the sequencer reads and changes. Every change is one small step. */
export interface MachineWorld {
  /** Where a new machine's worker reaches the server. */
  controlPlaneUrl: string;
  /** The clock every time here is read from (ISO 8601). */
  now(): Promise<string>;
  records(): Promise<MachineRecord[]>;
  work(): Promise<WaitingWork[]>;
  people(): Promise<PersonFacts[]>;
  /**
   * Record the intent to make a machine: its row and a new enrollment.
   * False when the name is already known (another replica was first).
   */
  intend(args: { machine: PlannedMachine }): Promise<boolean>;
  /**
   * The enrollment its create is asked with, the same on every pass and
   * replica until it is refused; null when it has none (refused).
   */
  enrollment(args: {
    name: string;
  }): Promise<{ code: string; idempotencyKey: string } | null>;
  /** A new enrollment, and so a new idempotency key, after a refusal. */
  reissue(args: { name: string }): Promise<void>;
  created(args: { name: string; ref: string }): Promise<void>;
  /** The platform made nothing: the code is withdrawn. */
  refused(args: { name: string; reason: string }): Promise<void>;
  /** Settings that never need a reset. */
  configure(args: {
    name: string;
    labels: Readonly<Record<string, string>>;
    trusted: boolean;
    reason: string | null;
    lostAfterMinutes: number | null;
  }): Promise<void>;
  /** Whom it is for from now on; also ends a reset that is no longer wanted. */
  setFor(args: {
    name: string;
    for: readonly MachinePrincipal[] | null;
  }): Promise<void>;
  /** It takes no new work, and is for `for` once {@link reset} is done. */
  beginReset(args: {
    name: string;
    for: readonly MachinePrincipal[] | null;
  }): Promise<void>;
  /**
   * Reset it through its worker (sandboxes, volumes, members' sign-ins)
   * and apply whom it is for. `busy` while it holds live workspaces,
   * `offline` while it is not connected.
   */
  reset(args: { name: string }): Promise<"done" | "busy" | "offline">;
  drop(args: { name: string }): Promise<void>;
  undrop(args: { name: string }): Promise<void>;
  /**
   * Take it out of service for good, under its lock: only while it holds
   * nothing (or its worker was revoked, or it never enrolled). True once
   * it is `destroying`.
   */
  retire(args: { name: string }): Promise<boolean>;
  /**
   * It is lost: take it out of service and retire what it held, only
   * while it is still unseen for `unseenForMs`. True once it is
   * `destroying`; false when it called again meanwhile.
   */
  declareLost(args: { name: string; unseenForMs: number }): Promise<boolean>;
  /**
   * Take no new work and become `stopping`, under its lock: only while it
   * holds nothing. False when it holds something.
   */
  beginStop(args: { name: string; at: string }): Promise<boolean>;
  stopped(args: { name: string }): Promise<void>;
  /** Become `resuming`: its worker may connect again. */
  beginResume(args: { name: string; at: string }): Promise<boolean>;
  /** Its `start` answered done. */
  startAsked(args: { name: string }): Promise<void>;
  /** Its platform confirmed it gone: Work knows it no more. */
  forget(args: { name: string }): Promise<void>;
  /** Why Work cannot do what the plan asks yet, or null. */
  note(args: { name: string; notice: string | null }): Promise<void>;
  failed(args: {
    name: string;
    verb: MachineVerb;
    message: string;
  }): Promise<void>;
  succeeded(args: { name: string; verb: MachineVerb }): Promise<void>;
  /** Something happened to a machine; delivery never fails a pass. */
  event(args: MachineEvent): Promise<void>;
  /** The plan answered (null) or failed with this error. */
  planned(args: { error: string | null }): Promise<void>;
  /** Which machine is being started or resumed for each piece of waiting work. */
  waiting(args: {
    machines: ReadonlyMap<
      string,
      { name: string; state: "starting" | "resuming" }
    >;
  }): Promise<void>;
}

/** What one pass changed. */
export interface MachinePassSummary {
  /** Machines whose create answered a ref. */
  created: string[];
  /** Machines whose labels, principals or settings changed. */
  updated: string[];
  /** Machines reset before their principals changed. */
  reset: string[];
  /** Machines the plan dropped: they take no new work. */
  released: string[];
  /** Machines called lost: their work is retired. */
  lost: string[];
  stopped: string[];
  /** Machines whose start answered done. */
  resumed: string[];
  /** Machines whose destruction is under way. */
  destroying: string[];
  destroyed: string[];
  /** What went wrong, by machine and verb. */
  failed: Array<{ name: string; verb?: MachineVerb; error: string }>;
  /** The plan threw, timed out or answered something invalid: nothing changed. */
  planError?: string;
  /** Another replica was sequencing; its pass covers this one. */
  busy?: true;
}

export function emptySummary(): MachinePassSummary {
  return {
    created: [],
    updated: [],
    reset: [],
    released: [],
    lost: [],
    stopped: [],
    resumed: [],
    destroying: [],
    destroyed: [],
    failed: [],
  };
}

/** The claim moved to another replica: this pass stops before changing more. */
export class MachinePassFencedError extends Error {
  constructor() {
    super("The machine sequencer's claim moved to another replica");
    this.name = "MachinePassFencedError";
  }
}

/** A machine's state, from what Work stores and its worker's lease. */
export function machineStateOf(args: {
  phase: MachinePhase;
  dropped: boolean;
  disabled: boolean;
  /** Its worker's lease is live. */
  live: boolean;
  /** Since its worker last called, in milliseconds. */
  unseenForMs: number;
  lostAfterMs: number;
  /** Resuming: since its `start` answered done, in milliseconds; null before. */
  startAskedForMs: number | null;
}): MachineState {
  if (args.phase === "destroying") return "destroying";
  if (args.phase === "stopping") return "stopping";
  if (args.phase === "stopped") return "stopped";
  if (args.phase === "starting") return "starting";
  if (args.phase === "resuming")
    return args.startAskedForMs !== null &&
      args.startAskedForMs >= args.lostAfterMs + RESUME_GRACE_MINUTES * 60_000
      ? "lost"
      : "resuming";
  if (args.disabled) return "disabled";
  if (args.live) return args.dropped ? "draining" : "serving";
  return args.unseenForMs >= args.lostAfterMs ? "lost" : "unreachable";
}

/** Milliseconds unseen that make a machine lost. */
export function lostAfterMsOf(args: {
  lostAfterMinutes: number | null;
  defaultMinutes?: number;
}): number {
  return (
    (args.lostAfterMinutes ??
      args.defaultMinutes ??
      DEFAULT_LOST_AFTER_MINUTES) * 60_000
  );
}

/** Minutes before a refused create is asked again: 1, 2, 4 ... 30. */
export function refusalBackoffMs(count: number): number {
  return Math.min(30, 2 ** Math.max(0, count - 1)) * 60_000;
}

/** A desired machine with its defaults. */
export function plannedMachine(desired: DesiredMachine): PlannedMachine {
  return {
    name: desired.name,
    for: desired.for === undefined ? null : normalizePrincipals(desired.for),
    labels: desired.labels ?? {},
    state: desired.state ?? "running",
    options: desired.options ?? {},
    trusted: desired.trusted ?? false,
    lostAfterMinutes: desired.lostAfterMinutes ?? null,
    reason: desired.reason ?? null,
  };
}

interface PassContext {
  hook: MachinesHook;
  world: MachineWorld;
  fence: () => Promise<void>;
  summary: MachinePassSummary;
  verbTimeoutMs: number;
  now: string;
  defaultLostAfterMinutes: number | undefined;
}

/**
 * One pass. `fence` throws {@link MachinePassFencedError} once another
 * replica holds the claim; the pass then ends with what it did so far.
 */
export async function runMachinePass(args: {
  hook: MachinesHook;
  world: MachineWorld;
  fence?: () => Promise<void>;
  /** How long `plan` may take (default 30 seconds). */
  planTimeoutMs?: number;
  /** How long one verb may take (default 2 minutes). */
  verbTimeoutMs?: number;
  /** The loss limit of a machine whose plan gives none. */
  defaultLostAfterMinutes?: number;
  log?: (line: string) => void;
}): Promise<MachinePassSummary> {
  const { hook, world } = args;
  const summary = emptySummary();
  const [records, work, people, now] = await Promise.all([
    world.records(),
    world.work(),
    world.people(),
    world.now(),
  ]);
  const planned = await readPlan({
    hook,
    facts: { now, work, people, machines: records.map((entry) => entry.facts) },
    timeoutMs: args.planTimeoutMs ?? 30_000,
  });
  if ("error" in planned) {
    // Nothing changes: the machines Work has keep running as they are.
    summary.planError = planned.error;
    await world.planned({ error: planned.error });
    args.log?.(
      `Machines: the plan failed and nothing changed: ${planned.error}`,
    );
    return summary;
  }
  const context: PassContext = {
    hook,
    world,
    fence: args.fence ?? (async () => {}),
    summary,
    verbTimeoutMs: args.verbTimeoutMs ?? 120_000,
    now,
    defaultLostAfterMinutes: args.defaultLostAfterMinutes,
  };
  const desired = new Map(
    planned.machines.map((machine) => [machine.name, machine]),
  );
  /** Names free to make: never known, or gone in this pass. */
  const free = new Set(desired.keys());
  for (const record of records) {
    const name = record.facts.name;
    const wanted = desired.get(name);
    const outcome = await guarded(context, name, () =>
      record.facts.managed
        ? stepManaged(context, record, wanted)
        : stepEnrolledByHand(context, record, wanted),
    );
    if (outcome !== "gone") free.delete(name);
  }
  for (const name of free) {
    const machine = desired.get(name);
    if (!machine) continue;
    await guarded(context, name, async () => {
      await context.fence();
      // Intent first: from here every pass and replica asks with one key.
      if (!(await world.intend({ machine }))) return "kept";
      await createStep(context, {
        name,
        options: machine.options,
        labels: machine.labels,
        for: machine.for,
        reason: machine.reason,
        refused: null,
        failedBefore: false,
      });
      return "kept";
    });
  }
  await annotateWaits({ world, work, fence: context.fence });
  await world.planned({ error: null });
  return summary;
}

/** Ask the plan, within its time, and check what it answered. */
async function readPlan(args: {
  hook: MachinesHook;
  facts: Parameters<MachinesHook["plan"]>[0];
  timeoutMs: number;
}): Promise<{ machines: PlannedMachine[] } | { error: string }> {
  let answered: unknown;
  try {
    answered = await withTimeout({
      work: args.hook.plan(args.facts),
      timeoutMs: args.timeoutMs,
      message: `plan did not answer within ${Math.round(args.timeoutMs / 1000)} seconds`,
    });
  } catch (error) {
    return { error: `plan threw: ${messageOf(error)}` };
  }
  const parsed = MachinePlanSchema.safeParse(answered);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: `plan returned something invalid${
        issue ? ` (${issue.path.join(".") || "result"}: ${issue.message})` : ""
      }; return an array of { name, for?, labels?, state?, options?, trusted?, lostAfterMinutes?, reason? }`,
    };
  }
  return { machines: parsed.data.map((machine) => plannedMachine(machine)) };
}

/** Run one machine's step; its failure is recorded and the pass goes on. */
async function guarded(
  context: PassContext,
  name: string,
  run: () => Promise<"gone" | "kept">,
): Promise<"gone" | "kept"> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MachinePassFencedError) throw error;
    context.summary.failed.push({ name, error: messageOf(error) });
    return "kept";
  }
}

/** A machine this hook made: follow the plan, within what is safe. */
async function stepManaged(
  context: PassContext,
  record: MachineRecord,
  wanted: PlannedMachine | undefined,
): Promise<"gone" | "kept"> {
  const { world, summary, hook } = context;
  const { name } = record.facts;
  const target = targetOf(record);
  let phase = record.phase;
  let phaseSince = record.phaseSince;
  let notice: string | null = null;
  const lost = async (unseenForMs: number): Promise<boolean> => {
    await context.fence();
    if (!(await world.declareLost({ name, unseenForMs }))) return false;
    summary.lost.push(name);
    await emit(context, "machine.lost", record);
    return true;
  };

  if (phase !== "destroying") {
    if (record.facts.state === "lost") {
      // Its work is retired, so its chats continue from their last save.
      // It called again meanwhile: it is kept as it is.
      if (
        !(await lost(
          lostAfterMsOf({
            lostAfterMinutes: record.lostAfterMinutes,
            defaultMinutes: context.defaultLostAfterMinutes,
          }),
        ))
      )
        return "kept";
      phase = "destroying";
    } else if (record.facts.state === "unreachable" && hook.describe) {
      const describe = hook.describe;
      const described = await verb(context, {
        record,
        verb: "describe",
        schema: MachineDescribeResultSchema,
        expected: '{ state: "running" | "stopped" | "gone" | "unknown" }',
        call: () => describe(target),
      });
      // The platform says it no longer exists: no need to wait out the limit.
      if (described?.state === "gone" && (await lost(0))) phase = "destroying";
    }
  }
  if (phase !== "destroying" && !wanted) {
    if (!record.dropped) {
      await context.fence();
      await world.drop({ name });
      summary.released.push(name);
      await emit(context, "machine.released", record);
    }
    await context.fence();
    if (await world.retire({ name })) phase = "destroying";
    else
      notice = `The plan no longer names it. It takes no new work and is destroyed once its ${workspaces(record)} given back.`;
  }
  if (phase === "destroying") return destroyStep(context, record);
  if (!wanted) {
    await setNotice(context, record, notice);
    return "kept";
  }

  if (record.dropped) {
    await context.fence();
    await world.undrop({ name });
  }
  // Changing launch parameters while its create is uncertain can turn
  // the same idempotency key into a different cloud request.
  const settings =
    record.facts.ref === null
      ? { ...wanted, labels: record.facts.labels }
      : wanted;
  notice = (await applySettings(context, record, settings)) ?? notice;
  if (
    record.facts.ref === null &&
    (phase === "starting" || phase === "running")
  )
    notice =
      (await createStep(context, {
        name,
        options: record.facts.options,
        labels: record.facts.labels,
        for: record.facts.for,
        reason: record.facts.reason,
        refused: record.refused,
        failedBefore: record.facts.lastError?.verb === "create",
      })) ?? notice;

  if (phase === "running" && wanted.state === "stopped") {
    if (!hook.stop)
      notice =
        "The plan wants it stopped, but the machines hook has no stop: it keeps running.";
    else if (record.facts.state === "serving") {
      await context.fence();
      if (await world.beginStop({ name, at: context.now })) {
        phase = "stopping";
        phaseSince = context.now;
      } else
        notice = `The plan wants it stopped. It stops once its ${workspaces(record)} given back.`;
    }
  }
  if (phase === "stopping") {
    const stop = hook.stop;
    if (!stop)
      notice =
        "It is stopping, but the machines hook has no stop any more: add it back.";
    else {
      const answer = await verb(context, {
        record,
        verb: "stop",
        schema: MachineStopResultSchema,
        expected: "{ done: boolean }",
        call: () => stop({ ...target, requestedAt: phaseSince }),
      });
      if (answer?.done) {
        await context.fence();
        await world.stopped({ name });
        summary.stopped.push(name);
        await emit(context, "machine.stopped", record);
        phase = "stopped";
      }
    }
  }
  let startAsked = record.startAsked;
  if (phase === "stopped" && wanted.state === "running") {
    if (!hook.start)
      notice =
        "The plan wants it running, but the machines hook has no start: it stays stopped.";
    else {
      await context.fence();
      if (await world.beginResume({ name, at: context.now })) {
        phase = "resuming";
        phaseSince = context.now;
        startAsked = false;
      }
    }
  }
  if (phase === "resuming" && !startAsked) {
    const start = hook.start;
    if (!start)
      notice =
        "It is resuming, but the machines hook has no start any more: add it back.";
    else {
      const answer = await verb(context, {
        record,
        verb: "start",
        schema: MachineStartResultSchema,
        expected: "{ done: boolean } or { gone: true }",
        call: () => start({ ...target, requestedAt: phaseSince }),
      });
      if (answer && "gone" in answer) {
        // Nothing is left to resume: it is lost, and made again.
        if (await lost(0)) return destroyStep(context, record);
      } else if (answer?.done) {
        await context.fence();
        await world.startAsked({ name });
        summary.resumed.push(name);
      }
    }
  }
  await setNotice(context, record, notice ?? isolationNotice(record, wanted));
  return "kept";
}

/**
 * A machine an operator enrolled by hand: the plan may say whom it is for,
 * its labels and why, never create, stop or destroy it.
 */
async function stepEnrolledByHand(
  context: PassContext,
  record: MachineRecord,
  wanted: PlannedMachine | undefined,
): Promise<"kept"> {
  if (!wanted) return "kept";
  let notice = await applySettings(context, record, wanted);
  if (wanted.state === "stopped")
    notice =
      "An operator enrolled this machine by hand: the plan may change whom it is for, its labels and its reason, but Work never stops it.";
  await setNotice(context, record, notice ?? isolationNotice(record, wanted));
  return "kept";
}

/** Labels, trust, reason, loss limit and principals; resets where needed. */
async function applySettings(
  context: PassContext,
  record: MachineRecord,
  wanted: PlannedMachine,
): Promise<string | null> {
  const { world, summary } = context;
  const { facts } = record;
  const { name } = facts;
  let changed = false;
  if (
    canonical(facts.labels) !== canonical(wanted.labels) ||
    facts.trusted !== wanted.trusted ||
    facts.reason !== wanted.reason ||
    record.lostAfterMinutes !== wanted.lostAfterMinutes
  ) {
    await context.fence();
    await world.configure({
      name,
      labels: wanted.labels,
      trusted: wanted.trusted,
      reason: wanted.reason,
      lostAfterMinutes: wanted.lostAfterMinutes,
    });
    changed = true;
  }
  let resetting = record.reset !== null;
  const target = record.reset ? record.reset.for : facts.for;
  if (!samePrincipals(target, wanted.for)) {
    await context.fence();
    // Nothing of anyone's is on a machine that never connected.
    const needsReset =
      record.phase !== "starting" &&
      principalsChangeNeedsReset({ from: facts.for, to: wanted.for });
    if (needsReset || resetting) {
      await world.beginReset({ name, for: wanted.for });
      resetting = true;
    } else {
      await world.setFor({ name, for: wanted.for });
      resetting = false;
    }
    changed = true;
  }
  if (changed) summary.updated.push(name);
  if (!resetting) return null;
  await context.fence();
  const outcome = await world.reset({ name });
  if (outcome === "done") {
    summary.reset.push(name);
    return null;
  }
  return outcome === "busy"
    ? `Whom it is for changes once it is reset. It takes no new work, and is reset once its ${workspaces(record)} given back.`
    : "Whom it is for changes once it is reset. It takes no new work, and is reset once it is connected.";
}

/** Ask the hook to create a machine until it answers a ref. */
async function createStep(
  context: PassContext,
  machine: {
    name: string;
    options: Readonly<Record<string, unknown>>;
    labels: Readonly<Record<string, string>>;
    for: readonly MachinePrincipal[] | null;
    reason: string | null;
    refused: MachineRecord["refused"];
    failedBefore: boolean;
  },
): Promise<string | null> {
  const { world, hook, summary } = context;
  const { name } = machine;
  let enrollment = await world.enrollment({ name });
  if (!enrollment) {
    if (machine.refused) {
      const waitMs =
        refusalBackoffMs(machine.refused.count) -
        (Date.parse(context.now) - Date.parse(machine.refused.at));
      if (waitMs > 0)
        return `Its platform refused to create it ${machine.refused.count} time(s) in a row. Work asks again in ${Math.ceil(waitMs / 60_000)} minute(s).`;
    }
    await context.fence();
    await world.reissue({ name });
    enrollment = await world.enrollment({ name });
    if (!enrollment) return null;
  }
  const request = {
    name,
    options: machine.options,
    labels: machine.labels,
    enrollment: {
      controlPlaneUrl: world.controlPlaneUrl,
      code: enrollment.code,
      idempotencyKey: enrollment.idempotencyKey,
    },
  };
  const answer = await callHook(context, {
    name,
    verb: "create",
    secret: enrollment.code,
    failedBefore: machine.failedBefore,
    schema: MachineCreateResultSchema,
    expected: "{ ref } | { pending: true } | { refused: reason }",
    call: () => hook.create(request),
  });
  if (!answer || "pending" in answer) return null;
  await context.fence();
  if ("refused" in answer) {
    const reason = answer.refused.replaceAll(
      enrollment.code,
      "[enrollment code]",
    );
    await world.refused({ name, reason });
    summary.failed.push({
      name,
      verb: "create",
      error: `Its platform refused: ${reason}`,
    });
    return null;
  }
  await world.created({ name, ref: answer.ref });
  summary.created.push(name);
  await context.world.event({
    kind: "machine.created",
    at: context.now,
    machine: {
      name,
      ref: answer.ref,
      managed: true,
      labels: machine.labels,
      for: machine.for,
      options: machine.options,
      reason: machine.reason,
    },
  });
  return null;
}

/** Ask the hook to destroy a machine until it is gone, then forget it. */
async function destroyStep(
  context: PassContext,
  record: MachineRecord,
): Promise<"gone" | "kept"> {
  const { world, summary, hook } = context;
  const { name } = record.facts;
  const answer = await verb(context, {
    record,
    verb: "destroy",
    schema: MachineDestroyResultSchema,
    expected: "{ done: boolean }",
    call: () =>
      hook.destroy({
        ...targetOf(record),
        requestedAt: record.destroyRequestedAt ?? context.now,
      }),
  });
  if (!answer?.done) {
    summary.destroying.push(name);
    return "kept";
  }
  await context.fence();
  await world.forget({ name });
  summary.destroyed.push(name);
  await emit(context, "machine.destroyed", record);
  return "gone";
}

/** Call a verb for a known machine. */
function verb<T>(
  context: PassContext,
  args: {
    record: MachineRecord;
    verb: MachineVerb;
    schema: z.ZodType<T>;
    expected: string;
    call: () => Promise<unknown>;
  },
): Promise<T | undefined> {
  return callHook(context, {
    name: args.record.facts.name,
    verb: args.verb,
    failedBefore: args.record.facts.lastError?.verb === args.verb,
    schema: args.schema,
    expected: args.expected,
    call: args.call,
  });
}

/**
 * One call into host code: within its time, its answer checked. A failure
 * is recorded for the machine and the call is made again on a later pass.
 */
async function callHook<T>(
  context: PassContext,
  args: {
    name: string;
    verb: MachineVerb;
    failedBefore: boolean;
    secret?: string;
    schema: z.ZodType<T>;
    expected: string;
    call: () => Promise<unknown>;
  },
): Promise<T | undefined> {
  await context.fence();
  let message: string;
  try {
    const raw = await withTimeout({
      work: args.call(),
      timeoutMs: context.verbTimeoutMs,
      message: `${args.verb} did not answer within ${Math.round(context.verbTimeoutMs / 1000)} seconds`,
    });
    const parsed = args.schema.safeParse(raw);
    if (parsed.success) {
      if (args.failedBefore) {
        await context.fence();
        await context.world.succeeded({ name: args.name, verb: args.verb });
      }
      return parsed.data;
    }
    message = `${args.verb} returned ${preview(raw)}; return ${args.expected}`;
  } catch (error) {
    message = `${args.verb} threw: ${messageOf(error)}`;
  }
  if (args.secret)
    message = message.replaceAll(args.secret, "[enrollment code]");
  await context.fence();
  context.summary.failed.push({
    name: args.name,
    verb: args.verb,
    error: message,
  });
  await context.world.failed({ name: args.name, verb: args.verb, message });
  return undefined;
}

/** Say which machine is being started or resumed for each piece of waiting work. */
async function annotateWaits(args: {
  world: MachineWorld;
  work: readonly WaitingWork[];
  fence: () => Promise<void>;
}): Promise<void> {
  const coming = (await args.world.records()).filter(
    (record) =>
      !record.dropped &&
      (record.facts.state === "starting" || record.facts.state === "resuming"),
  );
  const machines = new Map<
    string,
    { name: string; state: "starting" | "resuming" }
  >();
  for (const work of args.work) {
    const machine = coming.find((record) => machineTakes(record.facts, work));
    if (machine)
      machines.set(work.id, {
        name: machine.facts.name,
        state: machine.facts.state === "resuming" ? "resuming" : "starting",
      });
  }
  await args.fence();
  await args.world.waiting({ machines });
}

/**
 * Whether a machine would take a piece of waiting work once it serves: its
 * labels (and `plane: worker`) satisfy the work's pool, and it is for the
 * work's owner.
 */
export function machineTakes(
  machine: Pick<MachineFacts, "labels" | "for">,
  work: Pick<WaitingWork, "pool" | "project" | "user" | "key">,
): boolean {
  const labels: Record<string, string> = { ...machine.labels, plane: "worker" };
  return (
    Object.entries(work.pool).every(([key, value]) => labels[key] === value) &&
    principalsTake({ for: machine.for, work })
  );
}

function targetOf(record: MachineRecord): MachineTarget {
  return {
    name: record.facts.name,
    ref: record.facts.ref,
    idempotencyKey: record.idempotencyKey,
    options: record.facts.options,
    labels: record.facts.labels,
  };
}

async function emit(
  context: PassContext,
  kind: MachineEventKind,
  record: MachineRecord,
): Promise<void> {
  const { facts } = record;
  await context.world.event({
    kind,
    at: context.now,
    machine: {
      name: facts.name,
      ref: facts.ref,
      managed: facts.managed,
      labels: facts.labels,
      for: facts.for,
      options: facts.options,
      reason: facts.reason,
    },
  });
}

async function setNotice(
  context: PassContext,
  record: MachineRecord,
  notice: string | null,
): Promise<void> {
  if (notice === record.facts.notice) return;
  await context.fence();
  await context.world.note({ name: record.facts.name, notice });
}

/** A machine that would be refused work for how it isolates agents. */
function isolationNotice(
  record: MachineRecord,
  wanted: PlannedMachine,
): string | null {
  if (
    record.facts.isolation !== "process" ||
    wanted.trusted ||
    servesOneOwner(wanted.for) ||
    servesNobody(wanted.for)
  )
    return optionsNotice(record, wanted);
  return "It runs agents as plain processes and serves more than one principal, so it takes no work. Give it sandboxes that isolate agents (microsandbox or gVisor), or mark it trusted if everyone it serves trusts each other.";
}

/** Options apply when a machine is created; say so when the plan changed them. */
function optionsNotice(
  record: MachineRecord,
  wanted: PlannedMachine,
): string | null {
  if (
    !record.facts.managed ||
    canonical(record.facts.options) === canonical(wanted.options)
  )
    return null;
  return "The plan's options for this machine changed. Options apply only when a machine is created: give the new shape a new name.";
}

function workspaces(record: MachineRecord): string {
  const count = record.facts.holding.workspaces;
  return count === 1
    ? "live workspace is"
    : `${count > 0 ? `${count} ` : ""}live workspaces are`;
}

async function withTimeout<T>(args: {
  work: Promise<T>;
  timeoutMs: number;
  message: string;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(args.message)), args.timeoutMs);
  });
  try {
    return await Promise.race([args.work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function preview(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 200);
  } catch {
    return String(value);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON with sorted keys: stored jsonb reorders keys, so compare this way. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : entry,
  );
}
