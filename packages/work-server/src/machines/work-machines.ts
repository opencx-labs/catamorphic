import { randomUUID } from "node:crypto";
import {
  PlacementWaitsService,
  releaseReplicaClaim,
  renewReplicaClaim,
  takeReplicaClaim,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import type { WorkWorkerRegistry } from "../workers/worker-registry.js";
import type { MachineEvent, MachinesHook, PersonFacts } from "./contract.js";
import {
  emptySummary,
  MachinePassFencedError,
  type MachinePassSummary,
  type MachineWorld,
  runMachinePass,
} from "./sequencer.js";

const tracer = getTracer("@catamorphic/work-server");

/** How long a pass waits for one machine's reset; a slower one finishes later. */
const RESET_WAIT_MS = 3 * 60_000;

/**
 * The sequencer's world on the Work server (ADR 0347): machines, their
 * workers and what they hold in Postgres, by the database's clock.
 */
export function workMachineWorld(deps: {
  db: Kysely<DB>;
  tenantId: string;
  workers: WorkWorkerRegistry;
  controlPlaneUrl: string;
  people: () => Promise<PersonFacts[]>;
  event: (event: MachineEvent) => Promise<void>;
  resetWaitMs?: number;
}): MachineWorld {
  const { workers } = deps;
  const machines = workers.machines;
  const waits = new PlacementWaitsService(deps.db);
  return {
    controlPlaneUrl: deps.controlPlaneUrl,
    now: () => machines.now(),
    records: () => machines.records(),
    work: () => machines.work(),
    people: () => deps.people(),
    intend: (args) => machines.intend(args),
    enrollment: (args) => machines.enrollment(args),
    reissue: (args) => machines.reissue(args),
    created: (args) => machines.created(args),
    refused: (args) => machines.refused(args),
    configure: (args) => machines.configure(args),
    setFor: (args) => machines.setFor(args),
    beginReset: (args) => machines.beginReset(args),
    reset: ({ name }) =>
      workers.resetPlacement({
        name,
        timeoutMs: deps.resetWaitMs ?? RESET_WAIT_MS,
      }),
    drop: ({ name }) => machines.setDropped({ name, dropped: true }),
    undrop: ({ name }) => machines.setDropped({ name, dropped: false }),
    retire: (args) => workers.retireMachine(args),
    declareLost: (args) => workers.declareLost(args),
    beginStop: (args) => workers.beginStop(args),
    stopped: async ({ name }) => {
      await machines.setPhase({ name, phase: "stopped", from: ["stopping"] });
    },
    beginResume: (args) => workers.beginResume(args),
    startAsked: (args) => machines.startAsked(args),
    forget: (args) => machines.forget(args),
    note: (args) => machines.note(args),
    failed: (args) => machines.failed(args),
    succeeded: (args) => machines.succeeded(args),
    event: (event) => deps.event(event),
    planned: (args) => machines.planned(args),
    waiting: ({ machines: byWork }) =>
      waits.setMachines({ tenantId: deps.tenantId, machines: byWork }),
  };
}

/**
 * Keeps machines in step with the host's plan (ADR 0347). A pass runs only
 * while this replica holds the tenant's sequencer claim (ADR 0193),
 * renewed as it goes and checked before every change and every call into
 * host code, so replicas take turns and no machine is made twice.
 */
export class WorkMachines {
  private running: Promise<MachinePassSummary> | undefined;
  private readonly holder = randomUUID();
  /** What the latest pass of this replica saw; see {@link check}. */
  private seen: string | undefined;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      tenantId: string;
      hook: MachinesHook;
      world: MachineWorld;
      workers: WorkWorkerRegistry;
      /** How long a pass holds its claim without renewing (default 2 minutes). */
      leaseMs?: number;
      planTimeoutMs?: number;
      verbTimeoutMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  /** One pass; concurrent callers on this replica share it. */
  pass(): Promise<MachinePassSummary> {
    this.running ??= withSpan(
      {
        tracer,
        name: "machines.pass",
        attributes: { "catamorphic.tenant.id": this.deps.tenantId },
      },
      () => this.guardedPass(),
    ).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Start a pass without waiting for it; its outcome reaches the listing and the log. */
  passSoon(): void {
    void this.pass().catch((error: unknown) =>
      this.deps.log?.(`Machine pass failed: ${message(error)}`),
    );
  }

  /** Waits for a pass in progress (shutdown); starts none. */
  async settle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /**
   * Whether anything a plan reads changed since a pass of this replica
   * last looked: waiting work, what machines hold, a machine connecting,
   * becoming unreachable or lost, accounts and roles. One cheap look every
   * few seconds; a full pass only when it changed. What it remembers is
   * this replica's own shortcut (ADR 0193): the pass runs under the
   * tenant's claim either way.
   */
  async check(): Promise<void> {
    const seen = await this.deps.workers.machines.signature();
    if (seen === this.seen) return;
    this.passSoon();
  }

  private get leaseMs(): number {
    return this.deps.leaseMs ?? 120_000;
  }

  private async guardedPass(): Promise<MachinePassSummary> {
    const claim = {
      db: this.deps.db,
      name: `machine-reconciler:${this.deps.tenantId}`,
      holder: this.holder,
    };
    const ttlSeconds = Math.max(1, Math.ceil(this.leaseMs / 1000));
    if (!(await takeReplicaClaim({ ...claim, ttlSeconds }))) {
      // Another replica is sequencing; its pass covers this one.
      return { ...emptySummary(), busy: true };
    }
    // What this pass sees; a change after this starts another.
    this.seen = await this.deps.workers.machines
      .signature()
      .catch(() => this.seen);
    const lease = { lost: false };
    // A call into host code can outlast the claim; keep it while the pass runs.
    const heartbeat = setInterval(
      () => {
        void renewReplicaClaim({ ...claim, ttlSeconds })
          .then((held) => {
            if (!held) lease.lost = true;
          })
          .catch(() => undefined);
      },
      Math.max(1_000, this.leaseMs / 4),
    );
    heartbeat.unref();
    const fence = async () => {
      if (lease.lost || !(await renewReplicaClaim({ ...claim, ttlSeconds }))) {
        lease.lost = true;
        throw new MachinePassFencedError();
      }
    };
    let summary = emptySummary();
    try {
      summary = await runMachinePass({
        hook: this.deps.hook,
        world: this.deps.world,
        fence,
        defaultLostAfterMinutes: this.deps.workers.machines.defaultLostMinutes,
        ...(this.deps.planTimeoutMs !== undefined
          ? { planTimeoutMs: this.deps.planTimeoutMs }
          : {}),
        ...(this.deps.verbTimeoutMs !== undefined
          ? { verbTimeoutMs: this.deps.verbTimeoutMs }
          : {}),
        ...(this.deps.log ? { log: this.deps.log } : {}),
      });
    } catch (error) {
      if (!(error instanceof MachinePassFencedError)) throw error;
      this.deps.log?.(
        "Machine pass stopped: another replica took over the sequencer",
      );
    } finally {
      clearInterval(heartbeat);
      await releaseReplicaClaim(claim).catch(() => undefined);
    }
    const changed =
      summary.created.length +
      summary.updated.length +
      summary.reset.length +
      summary.released.length +
      summary.lost.length +
      summary.stopped.length +
      summary.resumed.length +
      summary.destroyed.length;
    if (changed > 0 || summary.failed.length > 0)
      this.deps.log?.(
        `Machines: ${summary.created.length} created, ${summary.updated.length} updated, ${summary.reset.length} reset, ${summary.released.length} released, ${summary.lost.length} lost, ${summary.stopped.length} stopped, ${summary.resumed.length} resumed, ${summary.destroyed.length} destroyed, ${summary.failed.length} failed`,
      );
    return summary;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
