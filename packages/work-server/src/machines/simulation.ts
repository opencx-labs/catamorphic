import { createHash } from "node:crypto";
import {
  DEFAULT_LOST_AFTER_MINUTES,
  type MachineEvent,
  type MachineFacts,
  type MachinePrincipal,
  type MachinesHook,
  type MachineVerb,
  normalizePrincipals,
  type PersonFacts,
  type WaitingWork,
} from "./contract.js";
import {
  lostAfterMsOf,
  type MachinePassSummary,
  type MachinePhase,
  type MachineRecord,
  type MachineWorld,
  machineStateOf,
  machineTakes,
  type PlannedMachine,
  runMachinePass,
} from "./sequencer.js";

/*
 * A simulated Work for testing a machines hook (ADR 0347): the real
 * sequencer over machines, work and people kept in memory, with a clock a
 * test moves. A machine the hook's `create` answered for boots and
 * connects by itself after `bootSeconds`; a test places work, ends it,
 * kills a machine, or enrolls one by hand, and reads what the hook was
 * asked to do. No server, database or cloud is involved.
 */

/** One call the simulated Work made into the hook. */
export interface SimulatedCall {
  verb: MachineVerb;
  name: string;
  /** ISO 8601, by the simulation's clock. */
  at: string;
  ref: string | null;
  idempotencyKey: string | null;
  /** What the hook answered; undefined when it threw. */
  answer?: unknown;
  /** What it threw. */
  error?: string;
}

interface SimulatedMachine {
  name: string;
  managed: boolean;
  ref: string | null;
  enrollment: { code: string; idempotencyKey: string } | null;
  generation: number;
  labels: Readonly<Record<string, string>>;
  for: readonly MachinePrincipal[] | null;
  trusted: boolean;
  options: Readonly<Record<string, unknown>>;
  lostAfterMinutes: number | null;
  reason: string | null;
  phase: MachinePhase;
  phaseSince: number;
  startAskedAt: number | null;
  refused: { count: number; at: number } | null;
  droppedAt: number | null;
  disabledAt: number | null;
  reset: { for: readonly MachinePrincipal[] | null } | null;
  notice: string | null;
  lastError: { verb: MachineVerb; message: string; at: number } | null;
  destroyRequestedAt: number | null;
  revoked: boolean;
  /** Its worker runs and reaches the server. */
  alive: boolean;
  /** When its worker connects, once it boots. */
  connectsAt: number | null;
  lastSeenAt: number | null;
  /** Live workspaces: the work on it. */
  holding: WaitingWork[];
  lastReleasedAt: number | null;
  resets: number;
}

export interface SimulatedWorkOptions {
  hook: MachinesHook;
  /** ISO 8601 start of the simulation's clock. */
  start?: string;
  /** Seconds a created or started machine takes to connect (default 60). */
  bootSeconds?: number;
  /** Workspaces one machine holds at once (default 4). */
  workspacesPerMachine?: number;
  /** How machines isolate agents (default "sandbox"). */
  isolation?: "process" | "sandbox";
  people?: readonly PersonFacts[];
  controlPlaneUrl?: string;
}

/** The simulated Work: machines, work and people in memory, and a clock. */
export class SimulatedWork {
  /** Every call into the hook, in order. */
  readonly calls: SimulatedCall[] = [];
  /** Every machine event, in order. */
  readonly events: MachineEvent[] = [];
  /** What the latest plan failed with, or null. */
  planError: string | null = null;
  people: PersonFacts[];
  private clock: number;
  private readonly machines = new Map<string, SimulatedMachine>();
  private waitingWork: WaitingWork[] = [];
  private readonly waitingFor = new Map<
    string,
    { name: string; state: "starting" | "resuming" }
  >();
  private workCount = 0;
  private generations = 0;
  /** Machines that never connect once created, by name. */
  private readonly neverConnect = new Set<string>();
  /** A create whose answer is lost on its way back, once. */
  private answerLost = false;

  constructor(private readonly options: SimulatedWorkOptions) {
    this.clock = Date.parse(options.start ?? "2026-01-01T00:00:00.000Z");
    this.people = [...(options.people ?? [])];
  }

  /** The simulation's time (ISO 8601). */
  get now(): string {
    return new Date(this.clock).toISOString();
  }

  /** Machines as the plan reads them. */
  facts(): MachineFacts[] {
    return this.records().map((record) => record.facts);
  }

  machine(name: string): MachineFacts | undefined {
    return this.facts().find((machine) => machine.name === name);
  }

  /** Work still waiting for a machine. */
  waiting(): readonly WaitingWork[] {
    return this.waitingWork;
  }

  /** The machine being started or resumed for a piece of waiting work. */
  startingFor(
    workId: string,
  ): { name: string; state: "starting" | "resuming" } | undefined {
    return this.waitingFor.get(workId);
  }

  /** Where a piece of work runs, once it has a machine. */
  placedOn(workId: string): string | undefined {
    for (const machine of this.machines.values())
      if (machine.holding.some((work) => work.id === workId))
        return machine.name;
    return undefined;
  }

  /** Add work that needs a machine; it waits until one takes it. */
  addWork(
    work: Partial<Omit<WaitingWork, "id">> & { project: string },
  ): WaitingWork {
    this.workCount += 1;
    const added: WaitingWork = {
      id: `work-${this.workCount}`,
      kind: "chat",
      user: null,
      key: null,
      environment: "default",
      pool: {},
      requirements: { resources: {}, capabilities: [] },
      reason: "unavailable",
      waitingSince: this.now,
      ...work,
    };
    this.waitingWork.push(added);
    this.place();
    return added;
  }

  /** The work ended: its workspace is given back. */
  finishWork(workId: string): void {
    this.waitingWork = this.waitingWork.filter((work) => work.id !== workId);
    for (const machine of this.machines.values()) {
      const before = machine.holding.length;
      machine.holding = machine.holding.filter((work) => work.id !== workId);
      if (machine.holding.length < before) machine.lastReleasedAt = this.clock;
    }
  }

  /** An operator enrolls a machine by hand; it connects after it boots. */
  enrollByHand(args: {
    name: string;
    for?: readonly MachinePrincipal[];
    labels?: Readonly<Record<string, string>>;
    trusted?: boolean;
  }): void {
    const machine = this.blank({
      name: args.name,
      managed: false,
      for: args.for === undefined ? null : normalizePrincipals(args.for),
      labels: args.labels ?? {},
      trusted: args.trusted ?? false,
      options: {},
      lostAfterMinutes: null,
      reason: null,
    });
    machine.connectsAt = this.clock + this.bootMs;
    this.machines.set(args.name, machine);
  }

  /** The machine dies: its worker stops calling. Its platform is the test's to end. */
  lose(name: string): void {
    const machine = this.require(name);
    machine.alive = false;
    machine.connectsAt = null;
  }

  /** A machine that was only unreachable calls again. */
  revive(name: string): void {
    const machine = this.require(name);
    if (machine.phase !== "running" || machine.revoked) return;
    machine.alive = true;
    machine.lastSeenAt = this.clock;
  }

  /** A machine by this name never connects once created. */
  neverConnects(name: string): void {
    this.neverConnect.add(name);
  }

  /** An operator disables or enables a machine. */
  setDisabled(name: string, disabled: boolean): void {
    this.require(name).disabledAt = disabled ? this.clock : null;
  }

  /**
   * The next create's answer is lost on its way back (the server stopped,
   * the network failed): the hook made its machine, and Work must ask again.
   */
  loseNextCreateAnswer(): void {
    this.answerLost = true;
  }

  /** Move the clock; machines boot, renew, and take waiting work as it passes. */
  advance(args: { seconds?: number; minutes?: number }): void {
    const until =
      this.clock + (args.seconds ?? 0) * 1_000 + (args.minutes ?? 0) * 60_000;
    while (this.clock < until) {
      this.clock = Math.min(until, this.clock + 5_000);
      this.tick();
    }
    this.tick();
  }

  /** One pass of the real sequencer over the simulation. */
  async pass(): Promise<MachinePassSummary> {
    this.tick();
    const summary = await runMachinePass({
      hook: this.recordingHook(),
      world: this.world(),
      verbTimeoutMs: 5_000,
      planTimeoutMs: 5_000,
    });
    this.tick();
    return summary;
  }

  /** Passes a few seconds apart until one changes nothing, or `limit` ran. */
  async settle(args: { limit?: number; seconds?: number } = {}): Promise<{
    quiet: boolean;
    passes: MachinePassSummary[];
  }> {
    const passes: MachinePassSummary[] = [];
    for (let index = 0; index < (args.limit ?? 40); index += 1) {
      const before = this.calls.length;
      const summary = await this.pass();
      passes.push(summary);
      const verbs = this.calls
        .slice(before)
        .filter((call) => call.verb !== "describe");
      if (verbs.length === 0 && quietSummary(summary) && !this.transient())
        return { quiet: true, passes };
      this.advance({ seconds: args.seconds ?? 30 });
    }
    return { quiet: false, passes };
  }

  /** Something is still on its way: a boot, a stop, a destruction. */
  private transient(): boolean {
    return [...this.machines.values()].some(
      (machine) =>
        machine.phase === "stopping" ||
        machine.phase === "destroying" ||
        (machine.phase === "resuming" && machine.alive === false) ||
        (machine.phase === "starting" &&
          machine.connectsAt !== null &&
          !this.neverConnect.has(machine.name)),
    );
  }

  private get bootMs(): number {
    return (this.options.bootSeconds ?? 60) * 1_000;
  }

  private require(name: string): SimulatedMachine {
    const machine = this.machines.get(name);
    if (!machine) throw new Error(`The simulation has no machine '${name}'`);
    return machine;
  }

  private blank(args: {
    name: string;
    managed: boolean;
    for: readonly MachinePrincipal[] | null;
    labels: Readonly<Record<string, string>>;
    trusted: boolean;
    options: Readonly<Record<string, unknown>>;
    lostAfterMinutes: number | null;
    reason: string | null;
  }): SimulatedMachine {
    return {
      ...args,
      ref: null,
      enrollment: null,
      generation: 0,
      phase: "starting",
      phaseSince: this.clock,
      startAskedAt: null,
      refused: null,
      droppedAt: null,
      disabledAt: null,
      reset: null,
      notice: null,
      lastError: null,
      destroyRequestedAt: null,
      revoked: false,
      alive: false,
      connectsAt: null,
      lastSeenAt: null,
      holding: [],
      lastReleasedAt: null,
      resets: 0,
    };
  }

  private newEnrollment(machine: SimulatedMachine): void {
    this.generations += 1;
    machine.generation = this.generations;
    const code = `wke_simulated_${machine.name}_${this.generations}`;
    machine.enrollment = {
      code,
      idempotencyKey: createHash("sha256").update(code).digest("hex"),
    };
  }

  private live(machine: SimulatedMachine): boolean {
    return (
      machine.alive &&
      !machine.revoked &&
      machine.disabledAt === null &&
      (machine.phase === "running" || machine.phase === "resuming")
    );
  }

  /** Boot what is due, renew what is alive, and place waiting work. */
  private tick(): void {
    for (const machine of this.machines.values()) {
      if (
        machine.connectsAt !== null &&
        machine.connectsAt <= this.clock &&
        !this.neverConnect.has(machine.name) &&
        machine.disabledAt === null &&
        (machine.phase === "starting" || machine.phase === "resuming")
      ) {
        const kind =
          machine.phase === "starting"
            ? "machine.connected"
            : "machine.started";
        machine.phase = "running";
        machine.phaseSince = this.clock;
        machine.startAskedAt = null;
        machine.alive = true;
        machine.connectsAt = null;
        this.emit(kind, machine);
      }
      if (this.live(machine)) machine.lastSeenAt = this.clock;
    }
    this.place();
  }

  private place(): void {
    const capacity = this.options.workspacesPerMachine ?? 4;
    const isolation = this.options.isolation ?? "sandbox";
    this.waitingWork = this.waitingWork.filter((work) => {
      const takers = [...this.machines.values()]
        .filter(
          (machine) =>
            machine.phase === "running" &&
            this.live(machine) &&
            machine.droppedAt === null &&
            machine.reset === null &&
            machine.holding.length < capacity &&
            (machine.trusted ||
              isolation === "sandbox" ||
              (machine.for !== null && machine.for.length === 1)) &&
            machineTakes(machine, work),
        )
        // Narrowest first: a machine for fewer principals before a shared one.
        .sort(
          (left, right) =>
            (left.for?.length ?? Number.POSITIVE_INFINITY) -
            (right.for?.length ?? Number.POSITIVE_INFINITY),
        );
      const taker = takers[0];
      if (!taker) return true;
      taker.holding.push(work);
      this.waitingFor.delete(work.id);
      return false;
    });
  }

  private emit(kind: MachineEvent["kind"], machine: SimulatedMachine): void {
    const event: MachineEvent = {
      kind,
      at: this.now,
      machine: {
        name: machine.name,
        ref: machine.ref,
        managed: machine.managed,
        labels: machine.labels,
        for: machine.for,
        options: machine.options,
        reason: machine.reason,
      },
    };
    this.events.push(event);
    void Promise.resolve(this.options.hook.onEvent?.(event)).catch(() => {});
  }

  private records(): MachineRecord[] {
    const capacity = this.options.workspacesPerMachine ?? 4;
    return [...this.machines.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((machine) => {
        const seen = machine.lastSeenAt ?? machine.phaseSince;
        const state = machineStateOf({
          phase: machine.phase,
          dropped: machine.droppedAt !== null,
          disabled: machine.disabledAt !== null,
          live: this.live(machine),
          unseenForMs: this.clock - seen,
          lostAfterMs: lostAfterMsOf({
            lostAfterMinutes: machine.lostAfterMinutes,
            defaultMinutes: DEFAULT_LOST_AFTER_MINUTES,
          }),
          startAskedForMs:
            machine.startAskedAt === null
              ? null
              : this.clock - machine.startAskedAt,
        });
        const since =
          state === "unreachable" || state === "lost"
            ? machine.phase === "resuming"
              ? (machine.startAskedAt ?? seen)
              : seen
            : state === "disabled"
              ? (machine.disabledAt ?? machine.phaseSince)
              : state === "draining"
                ? (machine.droppedAt ?? machine.phaseSince)
                : machine.phaseSince;
        const connected = machine.phase !== "starting";
        const facts: MachineFacts = {
          name: machine.name,
          ref: machine.ref,
          managed: machine.managed,
          state,
          since: iso(since),
          labels: machine.labels,
          for: machine.for,
          trusted: machine.trusted,
          options: machine.options,
          reason: machine.reason,
          holding: {
            workspaces: machine.holding.length,
            for: normalizePrincipals(
              machine.holding.map((work) =>
                work.user !== null
                  ? { user: work.user }
                  : work.key !== null
                    ? { project: work.project, key: work.key }
                    : { project: work.project },
              ),
            ),
          },
          idleSince:
            (state === "serving" || state === "draining") &&
            machine.holding.length === 0
              ? iso(Math.max(machine.phaseSince, machine.lastReleasedAt ?? 0))
              : null,
          lastSeenAt:
            machine.lastSeenAt === null ? null : iso(machine.lastSeenAt),
          capacity: connected ? { workspaces: capacity } : null,
          usage: connected
            ? {
                workspaces: machine.holding.length,
                cpuMillis: 0,
                memoryMb: 0,
                storageMb: 0,
              }
            : null,
          disk: null,
          isolation: connected ? (this.options.isolation ?? "sandbox") : null,
          signedIn: [],
          notice: machine.notice,
          lastError: machine.lastError
            ? {
                verb: machine.lastError.verb,
                message: machine.lastError.message,
                at: iso(machine.lastError.at),
              }
            : null,
        };
        return {
          facts,
          phase: machine.phase,
          phaseSince: iso(machine.phaseSince),
          idempotencyKey: machine.enrollment?.idempotencyKey ?? null,
          dropped: machine.droppedAt !== null,
          refused: machine.refused
            ? { count: machine.refused.count, at: iso(machine.refused.at) }
            : null,
          reset: machine.reset,
          startAsked: machine.startAskedAt !== null,
          destroyRequestedAt:
            machine.destroyRequestedAt === null
              ? null
              : iso(machine.destroyRequestedAt),
          lostAfterMinutes: machine.lostAfterMinutes,
          revoked: machine.revoked,
        };
      });
  }

  /** The hook, with every call recorded and a lost answer simulated. */
  private recordingHook(): MachinesHook {
    const { hook } = this.options;
    const record = async <T>(
      call: Pick<SimulatedCall, "verb" | "name" | "ref" | "idempotencyKey">,
      run: () => Promise<T>,
    ): Promise<T> => {
      const entry: SimulatedCall = { ...call, at: this.now };
      this.calls.push(entry);
      try {
        const answer = await run();
        entry.answer = answer;
        return answer;
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    const target = (args: {
      name: string;
      ref: string | null;
      idempotencyKey: string | null;
    }) => ({
      name: args.name,
      ref: args.ref,
      idempotencyKey: args.idempotencyKey,
    });
    const stop = hook.stop?.bind(hook);
    const start = hook.start?.bind(hook);
    const describe = hook.describe?.bind(hook);
    return {
      plan: (facts) => hook.plan(facts),
      create: async (request) => {
        const entry: SimulatedCall = {
          verb: "create",
          name: request.name,
          ref: null,
          idempotencyKey: request.enrollment.idempotencyKey,
          at: this.now,
        };
        this.calls.push(entry);
        const answer = await hook.create(request).catch((error: unknown) => {
          entry.error = error instanceof Error ? error.message : String(error);
          throw error;
        });
        entry.answer = answer;
        if (this.answerLost) {
          // The hook answered (and may have made its machine); Work never
          // heard it.
          this.answerLost = false;
          entry.error = "simulated: the answer was lost on its way back";
          throw new Error(
            "simulated: the answer to create was lost on its way back",
          );
        }
        return answer;
      },
      destroy: (args) =>
        record({ verb: "destroy", ...target(args) }, () => hook.destroy(args)),
      ...(stop
        ? {
            stop: (args) =>
              record({ verb: "stop", ...target(args) }, () => stop(args)),
          }
        : {}),
      ...(start
        ? {
            start: (args) =>
              record({ verb: "start", ...target(args) }, () => start(args)),
          }
        : {}),
      ...(describe
        ? {
            describe: (args) =>
              record({ verb: "describe", ...target(args) }, () =>
                describe(args),
              ),
          }
        : {}),
    };
  }

  private world(): MachineWorld {
    const set = (name: string, change: (machine: SimulatedMachine) => void) => {
      const machine = this.machines.get(name);
      if (machine) change(machine);
    };
    const phase = (machine: SimulatedMachine, next: MachinePhase) => {
      machine.phase = next;
      machine.phaseSince = this.clock;
      machine.startAskedAt = null;
    };
    /** Revoke its worker and begin destroying it. */
    const condemn = (machine: SimulatedMachine) => {
      phase(machine, "destroying");
      machine.destroyRequestedAt ??= this.clock;
      machine.revoked = true;
      machine.alive = false;
      machine.connectsAt = null;
      // Its work is retired: its chats wait for another machine.
      for (const work of machine.holding)
        this.waitingWork.push({ ...work, waitingSince: this.now });
      machine.holding = [];
    };
    return {
      controlPlaneUrl:
        this.options.controlPlaneUrl ?? "https://work.example.test",
      now: async () => this.now,
      records: async () => this.records(),
      work: async () => [...this.waitingWork],
      people: async () => [...this.people],
      intend: async ({ machine: planned }: { machine: PlannedMachine }) => {
        if (this.machines.has(planned.name)) return false;
        const machine = this.blank({
          name: planned.name,
          managed: true,
          for: planned.for,
          labels: planned.labels,
          trusted: planned.trusted,
          options: planned.options,
          lostAfterMinutes: planned.lostAfterMinutes,
          reason: planned.reason,
        });
        this.newEnrollment(machine);
        this.machines.set(planned.name, machine);
        return true;
      },
      enrollment: async ({ name }) =>
        this.machines.get(name)?.enrollment ?? null,
      reissue: async ({ name }) =>
        set(name, (machine) => {
          if (
            machine.managed &&
            !machine.enrollment &&
            machine.phase === "starting"
          )
            this.newEnrollment(machine);
        }),
      created: async ({ name, ref }) =>
        set(name, (machine) => {
          machine.ref = ref;
          machine.refused = null;
          if (machine.phase === "starting")
            machine.connectsAt ??= this.clock + this.bootMs;
        }),
      refused: async ({ name, reason }) =>
        set(name, (machine) => {
          machine.enrollment = null;
          machine.refused = {
            count: (machine.refused?.count ?? 0) + 1,
            at: this.clock,
          };
          machine.lastError = {
            verb: "create",
            message: `Its platform refused: ${reason}`,
            at: this.clock,
          };
        }),
      configure: async ({ name, ...settings }) =>
        set(name, (machine) => {
          machine.labels = settings.labels;
          machine.trusted = settings.trusted;
          machine.reason = settings.reason;
          machine.lostAfterMinutes = settings.lostAfterMinutes;
        }),
      setFor: async ({ name, for: principals }) =>
        set(name, (machine) => {
          machine.for = principals;
          machine.reset = null;
        }),
      beginReset: async ({ name, for: principals }) =>
        set(name, (machine) => {
          machine.reset = { for: principals };
        }),
      reset: async ({ name }) => {
        const machine = this.require(name);
        if (!this.live(machine)) return "offline";
        if (machine.holding.length > 0) return "busy";
        machine.for = machine.reset?.for ?? machine.for;
        machine.reset = null;
        machine.resets += 1;
        return "done";
      },
      drop: async ({ name }) =>
        set(name, (machine) => {
          machine.droppedAt ??= this.clock;
        }),
      undrop: async ({ name }) =>
        set(name, (machine) => {
          machine.droppedAt = null;
        }),
      retire: async ({ name }) => {
        const machine = this.require(name);
        if (machine.holding.length > 0 && !machine.revoked) return false;
        condemn(machine);
        return true;
      },
      declareLost: async ({ name, unseenForMs }) => {
        const machine = this.require(name);
        if (this.live(machine) && machine.phase === "running") return false;
        const seen = machine.lastSeenAt ?? machine.phaseSince;
        if (machine.phase === "running" && this.clock - seen < unseenForMs)
          return false;
        condemn(machine);
        return true;
      },
      beginStop: async ({ name }) => {
        const machine = this.require(name);
        if (machine.holding.length > 0 || machine.phase !== "running")
          return false;
        phase(machine, "stopping");
        return true;
      },
      stopped: async ({ name }) =>
        set(name, (machine) => {
          phase(machine, "stopped");
          machine.alive = false;
        }),
      beginResume: async ({ name }) => {
        const machine = this.require(name);
        if (machine.phase !== "stopped") return false;
        phase(machine, "resuming");
        return true;
      },
      startAsked: async ({ name }) =>
        set(name, (machine) => {
          machine.startAskedAt = this.clock;
          machine.connectsAt = this.clock + this.bootMs;
        }),
      forget: async ({ name }) => {
        this.machines.delete(name);
      },
      note: async ({ name, notice }) =>
        set(name, (machine) => {
          machine.notice = notice;
        }),
      failed: async ({ name, verb, message }) =>
        set(name, (machine) => {
          machine.lastError = { verb, message, at: this.clock };
        }),
      succeeded: async ({ name, verb }) =>
        set(name, (machine) => {
          if (machine.lastError?.verb === verb) machine.lastError = null;
        }),
      event: async (event) => {
        this.events.push(event);
        await Promise.resolve(this.options.hook.onEvent?.(event)).catch(
          () => {},
        );
      },
      planned: async ({ error }) => {
        this.planError = error;
      },
      waiting: async ({ machines }) => {
        this.waitingFor.clear();
        for (const [work, machine] of machines)
          this.waitingFor.set(work, machine);
      },
    };
  }

  /** How often a machine was reset before its principals changed. */
  resetsOf(name: string): number {
    return this.machines.get(name)?.resets ?? 0;
  }
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** A pass that changed nothing and failed at nothing. */
export function quietSummary(summary: MachinePassSummary): boolean {
  return (
    summary.planError === undefined &&
    summary.created.length +
      summary.updated.length +
      summary.reset.length +
      summary.released.length +
      summary.lost.length +
      summary.stopped.length +
      summary.resumed.length +
      summary.destroying.length +
      summary.destroyed.length +
      summary.failed.length ===
      0
  );
}
