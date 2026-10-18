import { createHash, randomUUID } from "node:crypto";
import {
  PLACEMENT_WAIT_FRESH_SECONDS,
  releaseReplicaClaim,
  renewReplicaClaim,
  takeReplicaClaim,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import {
  HetznerCloudError,
  type HetznerCloudMachines,
} from "@catamorphic/hetzner";
import { getTracer, withSpan } from "@catamorphic/otel";
import { environmentSatisfies, poolMatches } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
  type InstallTarget,
  workerCloudInit,
  workerInstallScript,
} from "./install-script.js";
import {
  type MachineClass,
  MachineName,
  type MachinePlatform,
} from "./machine-classes.js";
import {
  accessGroupsOf,
  NodeLabelsSchema,
  WorkerAccessSchema,
  type WorkerPlacement,
  WorkerPlacementSchema,
} from "./placement.js";
import type {
  MachineLoad,
  PooledMachine,
  ProvisionedMachine,
  WorkWorkerRegistry,
} from "./worker-registry.js";

const tracer = getTracer("@catamorphic/work-server");

/** Days a released machine keeps its disk unless its rule says otherwise. */
export const DEFAULT_RETAIN_DAYS = 7;

/** Minutes a machine on demand stays once idle, unless its rule says otherwise. */
export const DEFAULT_IDLE_MINUTES = 10;

/** Minutes a machine on demand has to enroll before it is replaced. */
export const DEFAULT_ENROLL_MINUTES = 15;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Machines that come and go with the work waiting for them (ADR 0258): up
 * to `max`, keeping `min` warm, each destroyed once idle for
 * `idleMinutes`, and replaced when it does not enroll within
 * `enrollMinutes`.
 */
const DemandSchema = z
  .strictObject({
    max: z.number().int().positive().max(100),
    min: z.number().int().min(0).max(100).default(0),
    // At least a minute: a machine that just enrolled is idle until the
    // work it was made for lands on it.
    idleMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(DEFAULT_IDLE_MINUTES),
    enrollMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .default(DEFAULT_ENROLL_MINUTES),
  })
  .refine((demand) => demand.min <= demand.max, {
    message: "min may not be more than max",
    path: ["min"],
  });
export type MachineDemand = z.output<typeof DemandSchema>;

/** How many machines a rule gives, and to whom. */
const RuleMachinesSchema = z.union([
  z.literal("each-member"),
  z.strictObject({ shared: z.number().int().positive().max(100) }),
  z.strictObject({ demand: DemandSchema }),
]);
type RuleMachines = z.output<typeof RuleMachinesSchema>;

/**
 * A machine rule (ADRs 0167, 0205, 0258): every active member of a
 * directory group gets a machine of their own, the group shares a fixed
 * number of machines, or machines come and go with the work waiting for
 * them, of a machine class. Machines on demand serve a group's members or
 * named projects' own work (project chats and automations). A machine
 * nobody should have any more is released and kept for `retainDays` before
 * it is destroyed or reset; a machine on demand keeps nothing.
 */
export const MachineRuleSchema = z
  .strictObject({
    group: z.email().toLowerCase().optional(),
    /** Machines on demand only: the projects whose own work they take. */
    projects: z.array(z.uuid()).min(1).max(100).optional(),
    machines: RuleMachinesSchema,
    /** A class from `WORK_MACHINES_CONFIG`, or the provisioner hook's. */
    class: z.string().min(1).max(64),
    /** Labels a created machine carries; a pooled one keeps its own. */
    labels: NodeLabelsSchema.default({}),
    /**
     * Shared machines and machines on demand: the people (or projects)
     * they serve trust each other, so processes are isolation enough.
     */
    trusted: z.boolean().default(false),
    /** Days a released machine keeps its disk; 0 destroys or resets it at once. */
    retainDays: z.number().int().min(0).max(365).optional(),
  })
  .superRefine((rule, context) => {
    const demand = demandOf(rule) !== undefined;
    if ((rule.group === undefined) === (rule.projects === undefined))
      context.addIssue({
        code: "custom",
        message: "Name either a group or projects",
        path: ["group"],
      });
    if (rule.projects !== undefined && !demand)
      context.addIssue({
        code: "custom",
        message:
          "Only machines on demand serve projects; give each-member and shared machines a group",
        path: ["projects"],
      });
    if (demand && rule.retainDays !== undefined && rule.retainDays !== 0)
      context.addIssue({
        code: "custom",
        message:
          "A machine on demand is destroyed once it is idle; leave out retainDays",
        path: ["retainDays"],
      });
  })
  .transform((rule) => ({
    ...rule,
    retainDays: rule.retainDays ?? (demandOf(rule) ? 0 : DEFAULT_RETAIN_DAYS),
  }));
export type MachineRule = z.output<typeof MachineRuleSchema>;

/** A rule's demand settings, when its machines come and go with demand. */
export function demandOf(rule: {
  machines: RuleMachines;
}): MachineDemand | undefined {
  return typeof rule.machines === "object" && "demand" in rule.machines
    ? rule.machines.demand
    : undefined;
}

/**
 * Creates and destroys worker machines on a platform (a cloud, a
 * virtualization host) for `custom` classes. A created machine starts the
 * Work worker with the given control plane and one-time enrollment code,
 * for example by running `enrollment.cloudInit` through cloud-init; it
 * enrolls itself. `create` throws {@link MachineProvisioningRefusedError}
 * when the platform refused and created nothing, so the next pass tries
 * again with a new code; any other error keeps the code, since the machine
 * may still come up and enroll.
 *
 * Work never calls `create` twice with one enrollment code, so `create` is
 * idempotent per code: use `enrollment.idempotencyKey`, a hash of the code,
 * as the platform's token (an EC2 `ClientToken`), never the name, which a
 * later machine of the same rule reuses once this one is gone. `destroy`
 * removes the machine `ref` names and every machine named `name` (a create
 * that failed uncertainly may have made one with no recorded ref), and
 * says whether they are gone: `{ done: false }` while a destruction is
 * under way or a machine may still appear, and Work asks again on later
 * passes, forgetting the machine only once it is done.
 */
export interface MachineProvisioner {
  create(args: {
    name: string;
    class: string;
    /** The rule the machine is for. */
    rule: string;
    /** The class's `options` from `WORK_MACHINES_CONFIG`, as written. */
    options?: Readonly<Record<string, unknown>>;
    /**
     * Machines on demand (ADR 0258): what the work waiting for this
     * machine needs, to size it. Absent for a machine kept warm.
     */
    waiting?: {
      resources: Readonly<{
        cpuMillis?: number;
        memoryMb?: number;
        storageMb?: number;
        gpu?: boolean;
      }>;
      capabilities: readonly string[];
    };
    labels: Readonly<Record<string, string>>;
    enrollment: {
      controlPlaneUrl: string;
      code: string;
      /** A hash of `code`: the platform's idempotency token for this create. */
      idempotencyKey: string;
      /**
       * Cloud-init user data that installs the worker with this code (ADR
       * 0205), when the server knows its worker image.
       */
      cloudInit?: string;
    };
  }): Promise<{ ref: string }>;
  /**
   * Destroy the machine `ref` names and every machine named `name`; done
   * once none is left.
   */
  destroy(args: { name: string; ref: string | null }): Promise<{
    done: boolean;
  }>;
}

/** A platform refused to create a machine, and created nothing. */
export class MachineProvisioningRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineProvisioningRefusedError";
  }
}

/** What one pass changed. */
export interface ReconcileSummary {
  /** Machines created on a platform. */
  created: string[];
  /** Pooled machines handed to a rule, and released machines handed back. */
  assigned: string[];
  /** Machines whose placement drifted from their rule's. */
  updated: string[];
  /** Machines that now serve nobody and keep their disk for a while. */
  released: string[];
  /** Machines destroyed on their platform. */
  removed: string[];
  /** Machines whose destruction is under way (a snapshot being written). */
  destroying: string[];
  /** Pooled machines reset and free again. */
  reset: string[];
  /** What went wrong, by machine (or rule) and the rule it belongs to. */
  failed: Array<{ name: string; error: string; rule?: string }>;
  /** Another replica was reconciling; its pass covers this one. */
  busy?: true;
}

/** How a rule's machines stand, for the operator. */
export interface MachineRuleStatus {
  platform: MachinePlatform | null;
  /** Machines the rule calls for now. */
  desired: number;
  /** Enrolled and serving their people. */
  ready: number;
  /** Created and not yet enrolled. */
  starting: number;
  /** Without a machine: a pool with none free, or not created yet. */
  waiting: number;
  /** Released and kept for their retention. */
  released: number;
  /** Machines on demand: work waiting for one of this rule's machines. */
  queued?: number;
  /**
   * What keeps the rule from being acted on fully: an unknown class (its
   * machines are left as they are), a machine on demand that never
   * connected (no more are made until the rule is written again), or work
   * its machines cannot take.
   */
  problem?: string;
  /** What failed for the rule's machines in the latest pass. */
  failure?: { error: string; at: string };
}

/** A machine a provisioned rule calls for, by its stable name. */
interface DesiredMachine {
  name: string;
  rule: string;
  class: string;
  placement: WorkerPlacement;
  retainDays: number;
  /** Minutes it has to enroll once created (machines on demand). */
  enrollMinutes?: number;
  /** What the work it is created for needs (machines on demand). */
  waiting?: {
    resources: DemandWait["requirements"]["resources"];
    capabilities: string[];
  };
}

/** Work waiting for a machine, as machine rules on demand read it. */
interface DemandWait {
  projectId: string;
  /** Null for a project's own work. */
  owner: string | null;
  /** The owner's directory groups, for a group's machines. */
  groups: readonly string[];
  pool: Readonly<Record<string, string>>;
  requirements: z.output<typeof DemandWaitRequirements>;
}

const DemandWaitPool = z.record(z.string(), z.string());
const DemandWaitRequirements = z.object({
  resources: z
    .object({
      cpuMillis: z.number().optional(),
      memoryMb: z.number().optional(),
      storageMb: z.number().optional(),
      gpu: z.boolean().optional(),
    })
    .default({}),
  capabilities: z.array(z.string()).default([]),
  trust: z.enum(["local", "managed"]).optional(),
  isolation: z.enum(["none", "process", "sandbox"]).optional(),
  topology: z
    .enum(["controller", "contained", "native", "external"])
    .optional(),
});

/** A place a pool rule fills with one of its class's free machines. */
interface DesiredSlot {
  rule: string;
  class: string;
  holder: { member: string } | { slot: number };
  /** For a shared place: the group it serves, part of its identity. */
  group: string | null;
  access: WorkerPlacement["access"];
  trusted: boolean;
  retainDays: number;
}

/** What rules call for now. */
interface Desired {
  rules: Record<string, MachineRule>;
  provisioned: Map<string, DesiredMachine>;
  slots: DesiredSlot[];
  /** Rules that cannot be acted on, and why; their machines stay as they are. */
  problems: Map<string, string>;
  /** Machines on demand: work waiting for each rule's machines. */
  queued: Map<string, number>;
  /** What keeps rules on demand from serving all their work, by rule. */
  notices: Map<string, string[]>;
}

/** Marks a ref as a Hetzner Cloud server id. */
const HETZNER_REF = "hcloud:";

/**
 * Keeps workers in step with machine rules and the directory (ADR 0205):
 * creates cloud machines and assigns pooled ones that are missing, updates
 * placement that drifted, releases machines nobody should have any more,
 * and destroys or resets them once their retention ends. Retention runs on
 * the database's clock, so replicas agree on it.
 */
export class MachineReconciler {
  private running: Promise<ReconcileSummary> | undefined;
  private readonly holder = randomUUID();

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      tenantId: string;
      workers: WorkWorkerRegistry;
      /** `WORK_MACHINES_CONFIG` classes; none means every class is custom. */
      classes: Readonly<Record<string, MachineClass>>;
      /** The `machineProvisioner` hook, for custom classes. */
      provisioner?: MachineProvisioner;
      /** For hetzner-cloud classes. */
      hetzner?: HetznerCloudMachines;
      /** What machines install, or why they cannot. */
      install: { target: InstallTarget } | { unavailable: string };
      controlPlaneUrl: string;
      /** A user's sign-in email, for dedicated machines' access. */
      emailOf: (userId: string) => Promise<string | undefined>;
      /** How long a pass holds its claim without renewing (default 2 minutes). */
      leaseMs?: number;
      /**
       * How long a pass waits for one pooled machine's reset (default 3
       * minutes); a slower reset finishes on a later pass.
       */
      resetWaitMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  async rules(): Promise<Record<string, MachineRule>> {
    const rows = await this.deps.db
      .selectFrom("work_machine_rules")
      .select(["name", "definition"])
      .where("tenant_id", "=", this.deps.tenantId)
      .orderBy("name")
      .execute();
    return Object.fromEntries(
      rows.map((row) => [row.name, MachineRuleSchema.parse(row.definition)]),
    );
  }

  /**
   * Write a rule. Its class must be one the server knows: a configured
   * class, or any class when only the provisioner hook is configured.
   */
  async setRule(args: { name: string; rule: unknown }): Promise<MachineRule> {
    const name = MachineName.parse(args.name);
    const rule = MachineRuleSchema.parse(args.rule);
    const machineClass = this.classOf(rule.class);
    if (!machineClass)
      throw new Error(
        `Machine class '${rule.class}' is not configured. Classes: ${
          Object.keys(this.deps.classes).join(", ") || "none"
        }. Add it to the WORK_MACHINES_CONFIG file.`,
      );
    if (machineClass.platform === "pool" && Object.keys(rule.labels).length > 0)
      throw new Error(
        "A pooled machine keeps the labels it enrolled with; remove labels from this rule",
      );
    if (machineClass.platform === "pool" && demandOf(rule))
      throw new Error(
        `Machines on demand are created on a platform, and class '${rule.class}' is a pool of enrolled machines. Use a hetzner-cloud or custom class`,
      );
    // A machine serving several owners must isolate its agents to connect
    // (ADR 0167): refuse a rule whose class's machines are known not to.
    if (
      demandOf(rule) &&
      !rule.trusted &&
      servesSeveral(rule) &&
      (await this.runsPlainProcesses(rule.class))
    )
      throw new Error(
        `Machines of class '${rule.class}' run agents as plain processes, so a machine serving ${rule.group ? "a group" : "several projects"} would be refused when it connects. Give the class machines that isolate agents (microsandbox or gVisor), or add "trusted": true if everyone it serves trusts each other`,
      );
    await this.deps.db
      .insertInto("work_machine_rules")
      .values({
        name,
        tenant_id: this.deps.tenantId,
        definition: JSON.stringify(rule),
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "name"]).doUpdateSet({
          definition: JSON.stringify(rule),
          updated_at: sql`now()`,
        }),
      )
      .execute();
    return rule;
  }

  /**
   * Remove a rule. Its machines keep the rule's retention, which outlives
   * it, and are released by the next pass.
   */
  async deleteRule(name: string): Promise<boolean> {
    return this.deps.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom("work_machine_rules")
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", name)
        .returning("definition")
        .executeTakeFirst();
      if (!deleted) return false;
      const parsed = MachineRuleSchema.safeParse(deleted.definition);
      if (parsed.success)
        await trx
          .updateTable("work_workers")
          .set({ retain_days: parsed.data.retainDays })
          .where("tenant_id", "=", this.deps.tenantId)
          .where("machine_rule", "=", name)
          .where("revoked_at", "is", null)
          .where("released_at", "is", null)
          .execute();
      return true;
    });
  }

  /** Directory groups rules name, for the directory mirror. */
  async groups(): Promise<string[]> {
    return [
      ...new Set(
        Object.values(await this.rules()).flatMap((rule) =>
          rule.group ? [rule.group] : [],
        ),
      ),
    ];
  }

  /** How each rule's machines stand right now. */
  async status(): Promise<Record<string, MachineRuleStatus>> {
    const desired = await this.desired();
    const [machines, pooled, failures] = await Promise.all([
      this.deps.workers.machines(),
      this.deps.workers.pooledMachines(),
      this.deps.db
        .selectFrom("work_machine_rules")
        .select(["name", "last_failure", "last_failure_at"])
        .where("tenant_id", "=", this.deps.tenantId)
        .where("last_failure", "is not", null)
        .execute(),
    ]);
    const status: Record<string, MachineRuleStatus> = {};
    for (const [name, rule] of Object.entries(desired.rules)) {
      const platform = this.classOf(rule.class)?.platform ?? null;
      const problem =
        desired.problems.get(name) ?? desired.notices.get(name)?.join(" ");
      const failed = failures.find((row) => row.name === name);
      const extra = {
        ...(problem ? { problem } : {}),
        ...(failed?.last_failure && failed.last_failure_at
          ? {
              failure: {
                error: failed.last_failure,
                at: failed.last_failure_at.toISOString(),
              },
            }
          : {}),
      };
      if (platform === "pool") {
        const slots = desired.slots.filter((slot) => slot.rule === name);
        const held = pooled.filter((machine) => machine.rule === name);
        const ready = held.filter(
          (machine) => machine.releasedForMs === null,
        ).length;
        status[name] = {
          platform,
          desired: slots.length,
          ready,
          starting: 0,
          waiting: Math.max(0, slots.length - ready),
          released: held.length - ready,
          ...extra,
        };
        continue;
      }
      const wanted = [...desired.provisioned.values()].filter(
        (machine) => machine.rule === name,
      );
      const own = machines.filter((machine) => machine.rule === name);
      const isWanted = (machineName: string) =>
        wanted.some((machine) => machine.name === machineName);
      const ready = own.filter(
        (machine) =>
          machine.state === "enrolled" &&
          machine.releasedForMs === null &&
          isWanted(machine.name),
      ).length;
      const starting = own.filter(
        (machine) => machine.state === "pending" && isWanted(machine.name),
      ).length;
      status[name] = {
        platform,
        desired: wanted.length,
        ready,
        starting,
        waiting: Math.max(0, wanted.length - ready - starting),
        released: own.filter(
          (machine) =>
            machine.state === "enrolled" && machine.releasedForMs !== null,
        ).length,
        ...(demandOf(rule) ? { queued: desired.queued.get(name) ?? 0 } : {}),
        ...extra,
      };
    }
    return status;
  }

  /**
   * One pass; concurrent callers share it, and replicas take turns: a pass
   * runs only while this replica holds the tenant's reconciler claim (ADR
   * 0193), renewed as it goes and checked before every change it makes.
   */
  reconcile(): Promise<ReconcileSummary> {
    this.running ??= withSpan(
      {
        tracer,
        name: "machines.reconcile",
        attributes: { "catamorphic.tenant.id": this.deps.tenantId },
      },
      () => this.guardedPass(),
    ).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Start a pass without waiting for it, as after a rule changed: its
   * outcome reaches the rule's status and the log.
   */
  reconcileSoon(): void {
    void this.reconcile().catch((error: unknown) =>
      this.deps.log?.(`Machine reconciliation failed: ${message(error)}`),
    );
  }

  /** Waits for a pass in progress (shutdown); starts none. */
  async settle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  private get leaseMs(): number {
    return this.deps.leaseMs ?? 120_000;
  }

  private async guardedPass(): Promise<ReconcileSummary> {
    const claim = {
      db: this.deps.db,
      name: `machine-reconciler:${this.deps.tenantId}`,
      holder: this.holder,
    };
    const ttlSeconds = Math.max(1, Math.ceil(this.leaseMs / 1000));
    const summary: ReconcileSummary = {
      created: [],
      assigned: [],
      updated: [],
      released: [],
      removed: [],
      destroying: [],
      reset: [],
      failed: [],
    };
    if (!(await takeReplicaClaim({ ...claim, ttlSeconds }))) {
      // Another replica is reconciling; its pass covers this one.
      return { ...summary, busy: true };
    }
    // Demand this pass sees; a change after this starts another pass.
    this.demandSeen = await this.demandSignature().catch(() => this.demandSeen);
    const lease = { lost: false };
    // A platform call can outlast the claim; keep it while the pass runs.
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
        throw new ReconcilerLeaseLostError();
      }
    };
    try {
      const desired = await this.pass({ fence, summary });
      await fence();
      await this.recordFailures({ rules: Object.keys(desired.rules), summary });
    } catch (error) {
      if (!(error instanceof ReconcilerLeaseLostError)) throw error;
      this.deps.log?.(
        "Machine reconciliation stopped: another replica took over the pass",
      );
    } finally {
      clearInterval(heartbeat);
      await releaseReplicaClaim(claim).catch(() => undefined);
    }
    const changed =
      summary.created.length +
      summary.assigned.length +
      summary.updated.length +
      summary.released.length +
      summary.removed.length +
      summary.reset.length;
    if (changed > 0 || summary.failed.length > 0) {
      this.deps.log?.(
        `Machines: ${summary.created.length} created, ${summary.assigned.length} assigned, ${summary.updated.length} updated, ${summary.released.length} released, ${summary.removed.length} removed, ${summary.reset.length} reset, ${summary.failed.length} failed`,
      );
    }
    return summary;
  }

  /** Each rule's failures in this pass, or none, for its status. */
  private async recordFailures(args: {
    rules: readonly string[];
    summary: ReconcileSummary;
  }): Promise<void> {
    for (const rule of args.rules) {
      const failures = args.summary.failed.filter(
        (failure) => failure.rule === rule,
      );
      await this.deps.db
        .updateTable("work_machine_rules")
        .set(
          failures.length > 0
            ? {
                last_failure: failures
                  .map((failure) =>
                    failure.name === rule
                      ? failure.error
                      : `${failure.name}: ${failure.error}`,
                  )
                  .join("\n")
                  .slice(0, 4_000),
                last_failure_at: sql`now()`,
              }
            : { last_failure: null, last_failure_at: null },
        )
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", rule)
        .execute();
    }
  }

  /**
   * Records what it changes in `summary`; `fence` throws once another
   * reconciler holds the claim, ending the pass with what it did so far.
   */
  private async pass(args: {
    fence: () => Promise<void>;
    summary: ReconcileSummary;
  }): Promise<Desired> {
    const desired = await this.desired();
    for (const [rule, problem] of desired.problems)
      args.summary.failed.push({ name: rule, error: problem, rule });
    for (const [rule, notices] of desired.notices)
      for (const notice of notices)
        args.summary.failed.push({ name: rule, error: notice, rule });
    await this.reconcileProvisioned({ ...args, desired });
    await this.reconcilePooled({ ...args, desired });
    return desired;
  }

  /**
   * Run one machine's step; a failure is recorded for it and the pass goes
   * on with the next machine. Losing the claim still ends the pass.
   */
  private async step(args: {
    summary: ReconcileSummary;
    name: string;
    rule: string | null;
    run: () => Promise<void>;
  }): Promise<boolean> {
    try {
      await args.run();
      return true;
    } catch (error) {
      if (error instanceof ReconcilerLeaseLostError) throw error;
      args.summary.failed.push({
        name: args.name,
        error: message(error),
        ...(args.rule ? { rule: args.rule } : {}),
      });
      return false;
    }
  }

  /** Cloud and custom machines: one per desired name. */
  private async reconcileProvisioned({
    fence,
    summary,
    desired,
  }: {
    fence: () => Promise<void>;
    summary: ReconcileSummary;
    desired: Desired;
  }): Promise<void> {
    const machines = await this.deps.workers.machines();

    // Expired codes, machines an operator revoked, and machines nobody
    // should have go first, and a name is reused only after its old
    // machine is gone. An enrolled machine is released before that and
    // kept for its retention. A machine stays listed until its platform
    // confirmed it is gone, so a failed destruction is tried again.
    const pendingDestroy = new Set<string>();
    for (const machine of machines) {
      if (desired.problems.has(machine.rule)) continue;
      const wanted = desired.provisioned.has(machine.name);
      if (wanted && machine.state !== "expired" && machine.state !== "revoked")
        continue;
      const settled = await this.step({
        summary,
        name: machine.name,
        rule: machine.rule,
        run: async () => {
          if (machine.state === "enrolled") {
            const retainDays = this.retainDaysOf({ machine, desired });
            if (machine.releasedForMs === null) {
              await fence();
              await this.deps.workers.release({
                name: machine.name,
                retainDays,
              });
              summary.released.push(machine.name);
            }
            if (
              !retentionEnded({
                releasedForMs: machine.releasedForMs ?? 0,
                retainDays,
              })
            )
              return;
            // Chats on it give their workspaces back saved once they idle
            // (ADR 0173); a machine that can no longer save them goes at
            // once. Revoked under its node's lock, so no Allocation lands
            // on it between this check and its revocation (ADR 0258).
            await fence();
            if (
              !(await this.deps.workers.drain({
                name: machine.name,
                unseenForMs: this.lostAfterMs(machine.rule, desired),
              }))
            )
              return;
          }
          if (machine.state === "enrolled" || machine.state === "pending") {
            await fence();
            // Its code stops working, and it stays listed until destroyed.
            await this.deps.workers.expireEnrollments({ name: machine.name });
          }
          await fence();
          if (!(await this.unprovision(machine))) {
            summary.destroying.push(machine.name);
            pendingDestroy.add(machine.name);
            return;
          }
          await this.deps.workers.forgetMachine(machine);
          summary.removed.push(machine.name);
        },
      });
      if (!settled) pendingDestroy.add(machine.name);
    }

    for (const machine of desired.provisioned.values()) {
      if (pendingDestroy.has(machine.name)) continue;
      const current = machines.find(
        (candidate) =>
          candidate.name === machine.name &&
          (candidate.state === "enrolled" || candidate.state === "pending"),
      );
      if (current?.state === "pending") continue;
      await this.step({
        summary,
        name: machine.name,
        rule: machine.rule,
        run: async () => {
          if (current && current.releasedForMs !== null) {
            // Their person or group is back before the machine went.
            await fence();
            await this.deps.workers.reassign(machine);
            summary.assigned.push(machine.name);
            return;
          }
          if (current) {
            if (canonical(current.placement) !== canonical(machine.placement)) {
              await fence();
              await this.deps.workers.setPlacement(machine);
              summary.updated.push(machine.name);
            }
            if (current.retainDays !== machine.retainDays) {
              await fence();
              await this.deps.workers.setRetainDays(machine);
            }
            return;
          }
          await this.create({ machine, fence, summary });
        },
      });
    }
  }

  /**
   * Create a missing machine. Nothing is issued while machines cannot
   * install from this server. A platform that refused creates nothing, so
   * its code is withdrawn and the next pass tries again; after any other
   * failure the code stays, since the machine may still come up and enroll.
   */
  private async create(args: {
    machine: DesiredMachine;
    fence: () => Promise<void>;
    summary: ReconcileSummary;
  }): Promise<void> {
    const { machine } = args;
    const machineClass = this.classOf(machine.class);
    if (
      machineClass?.platform === "hetzner-cloud" &&
      "unavailable" in this.deps.install
    )
      throw new Error(this.deps.install.unavailable);
    await args.fence();
    const enrollment = await this.deps.workers.createMachineEnrollment({
      name: machine.name,
      rule: machine.rule,
      // A machine on demand that does not enroll in time is replaced.
      ttlMinutes: machine.enrollMinutes ?? 60,
      placement: machine.placement,
    });
    // Its machine enrolled or is being created since this pass looked.
    if (!enrollment) return;
    try {
      const ref = await this.provision({ machine, code: enrollment.code });
      await this.deps.workers.recordMachineRef({
        code: enrollment.code,
        ref,
      });
      args.summary.created.push(machine.name);
    } catch (error) {
      if (
        (error instanceof HetznerCloudError && error.definite) ||
        error instanceof MachineProvisioningRefusedError
      )
        await this.deps.workers.cancelEnrollments({ name: machine.name });
      throw error;
    }
  }

  /**
   * Pooled machines (ADR 0205): each place a pool rule calls for holds one
   * free machine of its class. Machines nobody holds any more are released,
   * then reset through their worker once their retention ends.
   */
  private async reconcilePooled({
    fence,
    summary,
    desired,
  }: {
    fence: () => Promise<void>;
    summary: ReconcileSummary;
    desired: Desired;
  }): Promise<void> {
    const pooled = await this.deps.workers.pooledMachines();
    const slots = new Map(desired.slots.map((slot) => [slotKey(slot), slot]));
    /** Places with a machine serving them. */
    const held = new Set<string>();
    const placementFor = (machine: PooledMachine, slot: DesiredSlot) =>
      WorkerPlacementSchema.parse({
        labels: machine.placement.labels,
        access: slot.access,
        trusted: slot.trusted,
      });
    const fits = (machine: PooledMachine, slot: DesiredSlot | undefined) =>
      slot !== undefined &&
      machine.placement.labels.class === slot.class &&
      !held.has(slotKey(slot));

    // Held machines keep their place, follow its placement, or are released.
    const released: PooledMachine[] = [];
    for (const machine of pooled) {
      if (!machine.rule) continue;
      const rule = machine.rule;
      if (desired.problems.has(rule)) {
        if (machine.releasedForMs === null)
          held.add(slotKey(machineSlot(machine)));
        continue;
      }
      if (machine.releasedForMs !== null) {
        released.push(machine);
        continue;
      }
      const slot = slots.get(slotKey(machineSlot(machine)));
      if (slot && fits(machine, slot)) {
        held.add(slotKey(slot));
        await this.step({
          summary,
          name: machine.name,
          rule,
          run: async () => {
            const placement = placementFor(machine, slot);
            if (canonical(machine.placement) !== canonical(placement)) {
              await fence();
              await this.deps.workers.setPlacement({
                name: machine.name,
                placement,
              });
              summary.updated.push(machine.name);
            }
            if (machine.retainDays !== slot.retainDays) {
              await fence();
              await this.deps.workers.setRetainDays({
                name: machine.name,
                retainDays: slot.retainDays,
              });
            }
          },
        });
        continue;
      }
      const retainDays = this.retainDaysOf({ machine, desired });
      await this.step({
        summary,
        name: machine.name,
        rule,
        run: async () => {
          await fence();
          await this.deps.workers.release({ name: machine.name, retainDays });
          summary.released.push(machine.name);
          released.push({ ...machine, releasedForMs: 0, retainDays });
        },
      });
    }

    // Released machines go back to their person or group within their
    // retention; afterwards they are reset.
    const resets = pooled
      .filter((machine) => !machine.rule && machine.releasedForMs !== null)
      .map((machine) => machine.name);
    for (const machine of released) {
      const slot = slots.get(slotKey(machineSlot(machine)));
      const retainDays = this.retainDaysOf({ machine, desired });
      const ended = retentionEnded({
        releasedForMs: machine.releasedForMs ?? 0,
        retainDays,
      });
      await this.step({
        summary,
        name: machine.name,
        rule: machine.rule,
        run: async () => {
          if (slot && fits(machine, slot) && !ended) {
            await fence();
            await this.deps.workers.reassign({
              name: machine.name,
              placement: placementFor(machine, slot),
              retainDays: slot.retainDays,
            });
            held.add(slotKey(slot));
            summary.assigned.push(machine.name);
            return;
          }
          if (!ended) return;
          await fence();
          await this.deps.workers.beginReset({ name: machine.name });
          resets.push(machine.name);
        },
      });
    }

    // Resets run at once, each waiting a bounded time. A machine that is
    // not connected is reset when it reconnects, one whose chats still hold
    // workspaces once they idle and give them back saved (ADR 0173), and a
    // reset that takes longer than the wait on a later pass.
    const freed = new Set<string>();
    await Promise.all(
      resets.map((name) =>
        this.step({
          summary,
          name,
          rule: null,
          run: async () => {
            if (!(await this.deps.workers.connected({ name }))) return;
            if ((await this.deps.workers.activeWorkspaces({ name })) > 0)
              return;
            await fence();
            await this.deps.workers.resetPooled({
              name,
              timeoutMs: this.deps.resetWaitMs ?? 3 * 60_000,
            });
            await fence();
            await this.deps.workers.freePooled({ name });
            freed.add(name);
            summary.reset.push(name);
          },
        }),
      ),
    );

    // Places still without a machine take a free one of their class.
    const free = pooled.filter(
      (machine) =>
        (!machine.rule && machine.releasedForMs === null) ||
        freed.has(machine.name),
    );
    for (const slot of desired.slots) {
      if (held.has(slotKey(slot)) || desired.problems.has(slot.rule)) continue;
      const index = free.findIndex(
        (machine) => machine.placement.labels.class === slot.class,
      );
      const [machine] = index >= 0 ? free.splice(index, 1) : [];
      if (!machine) continue;
      await this.step({
        summary,
        name: machine.name,
        rule: slot.rule,
        run: async () => {
          await fence();
          if (
            await this.deps.workers.assignPooled({
              name: machine.name,
              rule: slot.rule,
              holder: slot.holder,
              placement: placementFor(machine, slot),
              retainDays: slot.retainDays,
            })
          ) {
            held.add(slotKey(slot));
            summary.assigned.push(machine.name);
          }
        },
      });
    }
  }

  /** Create a machine on its class's platform; resolves with its ref. */
  private async provision(args: {
    machine: DesiredMachine;
    code: string;
  }): Promise<string> {
    const { machine, code } = args;
    const machineClass = this.classOf(machine.class);
    const idempotencyKey = createHash("sha256").update(code).digest("hex");
    const cloudInit =
      "target" in this.deps.install
        ? workerCloudInit({
            script: workerInstallScript(this.deps.install.target),
            code,
          })
        : undefined;
    if (machineClass?.platform === "hetzner-cloud") {
      if (!this.deps.hetzner)
        throw new MachineProvisioningRefusedError(
          "Set WORK_HETZNER_TOKEN to create Hetzner Cloud machines",
        );
      if (!cloudInit)
        throw new MachineProvisioningRefusedError(
          "unavailable" in this.deps.install
            ? this.deps.install.unavailable
            : "Machines cannot install from this server",
        );
      const { ref } = await this.deps.hetzner.create({
        name: machine.name,
        serverType: machineClass.serverType,
        location: machineClass.location,
        image: machineClass.image,
        ...(machineClass.sshKeys ? { sshKeys: machineClass.sshKeys } : {}),
        ...(machineClass.firewalls
          ? { firewalls: machineClass.firewalls }
          : {}),
        ...(machineClass.networks ? { networks: machineClass.networks } : {}),
        labels: {
          ...machineClass.labels,
          "work-rule": machine.rule,
          "work-class": machine.class,
        },
        userData: cloudInit,
      });
      return `${HETZNER_REF}${ref}`;
    }
    if (machineClass?.platform === "custom" && this.deps.provisioner) {
      const { ref } = await this.deps.provisioner.create({
        name: machine.name,
        class: machine.class,
        rule: machine.rule,
        ...(machineClass.options ? { options: machineClass.options } : {}),
        ...(machine.waiting ? { waiting: machine.waiting } : {}),
        labels: machine.placement.labels,
        enrollment: {
          controlPlaneUrl: this.deps.controlPlaneUrl,
          code,
          idempotencyKey,
          ...(cloudInit ? { cloudInit } : {}),
        },
      });
      return ref;
    }
    throw new MachineProvisioningRefusedError(
      `Machine class '${machine.class}' creates no machines`,
    );
  }

  /**
   * Destroy a machine on the platform that made it, by its reference or
   * else by its name. False while the destruction is still under way.
   */
  private async unprovision(machine: ProvisionedMachine): Promise<boolean> {
    const className = machine.placement.labels.class;
    const machineClass = className ? this.classOf(className) : undefined;
    if (
      machine.ref?.startsWith(HETZNER_REF) ||
      machineClass?.platform === "hetzner-cloud"
    ) {
      if (!this.deps.hetzner)
        throw new Error(
          "Set WORK_HETZNER_TOKEN to destroy Hetzner Cloud machines",
        );
      // Only a machine that enrolled can hold anyone's work.
      const snapshot =
        machineClass?.platform === "hetzner-cloud" &&
        machineClass.snapshot &&
        (machine.state === "enrolled" || machine.state === "revoked");
      const destroyed = await this.deps.hetzner.destroy({
        name: machine.name,
        ref: machine.ref?.startsWith(HETZNER_REF)
          ? machine.ref.slice(HETZNER_REF.length)
          : null,
        ...(snapshot
          ? {
              snapshot: {
                description: `Work machine ${machine.name} of rule ${machine.rule}`,
                labels: { "work-rule": machine.rule },
              },
            }
          : {}),
      });
      return destroyed.done;
    }
    if (!this.deps.provisioner)
      throw new Error(
        `No platform destroys machines of class '${className ?? "unknown"}'`,
      );
    const destroyed = await this.deps.provisioner.destroy({
      name: machine.name,
      ref: machine.ref,
    });
    return destroyed.done;
  }

  /**
   * How long a machine holding workspaces may go unseen before it is lost
   * and revoked anyway: its rule's `enrollMinutes` for machines on demand.
   */
  private lostAfterMs(rule: string, desired: Desired): number {
    const definition = desired.rules[rule];
    const demand = definition ? demandOf(definition) : undefined;
    return (demand?.enrollMinutes ?? DEFAULT_ENROLL_MINUTES) * 60_000;
  }

  /** Whether machines of this class are known to run plain processes. */
  private async runsPlainProcesses(machineClass: string): Promise<boolean> {
    const row = await this.deps.db
      .selectFrom("work_workers")
      .innerJoin("worker_nodes", "worker_nodes.id", "work_workers.node_id")
      .select("work_workers.name")
      .where("work_workers.tenant_id", "=", this.deps.tenantId)
      .where(sql<boolean>`work_workers.labels ->> 'class' = ${machineClass}`)
      .where(sql<boolean>`worker_nodes.descriptor ->> 'isolation' = 'process'`)
      .executeTakeFirst();
    return Boolean(row);
  }

  /**
   * The class a name refers to: a configured one, or with none configured
   * any class, handled by the provisioner hook.
   */
  private classOf(name: string): MachineClass | undefined {
    if (Object.keys(this.deps.classes).length > 0)
      return this.deps.classes[name];
    return this.deps.provisioner ? { platform: "custom" } : undefined;
  }

  /** Retention: the rule's now, else what the machine recorded. */
  private retainDaysOf(args: {
    machine: { rule: string | null; retainDays: number | null };
    desired: Desired;
  }): number {
    const rule = args.machine.rule
      ? args.desired.rules[args.machine.rule]
      : undefined;
    return rule?.retainDays ?? args.machine.retainDays ?? DEFAULT_RETAIN_DAYS;
  }

  private async desired(): Promise<Desired> {
    const rules = await this.rules();
    const desired: Desired = {
      rules,
      provisioned: new Map(),
      slots: [],
      problems: new Map(),
      queued: new Map(),
      notices: new Map(),
    };
    const demand = Object.values(rules).some((rule) => demandOf(rule))
      ? await this.demandState()
      : undefined;
    const { notices } = desired;
    // Each piece of waiting work is one rule's to serve: the first by name
    // that takes it and whose machines are not known to fall short of it.
    const assigned = new Map<string, DemandWait[]>();
    if (demand)
      for (const wait of demand.waits)
        for (const [rule, definition] of Object.entries(rules)) {
          const machineClass = this.classOf(definition.class);
          if (
            !demandOf(definition) ||
            !machineClass ||
            machineClass.platform === "pool" ||
            !demandWaitMatches(definition, wait)
          )
            continue;
          const short = demandShortfall({
            machines: demand.machines.filter(
              (machine) => machine.rule === rule,
            ),
            loads: demand.loads,
            wait,
          });
          if (short) {
            const said = notices.get(rule) ?? [];
            const notice = `Work waiting for this rule needs what its machines do not offer (${short}); they take none of it.`;
            if (!said.includes(notice)) notices.set(rule, [...said, notice]);
            continue;
          }
          assigned.set(rule, [...(assigned.get(rule) ?? []), wait]);
          break;
        }
    for (const [rule, definition] of Object.entries(rules)) {
      const machineClass = this.classOf(definition.class);
      if (!machineClass) {
        desired.problems.set(
          rule,
          `Machine class '${definition.class}' is not configured; this rule's machines are left as they are`,
        );
        continue;
      }
      const ruleDemand = demandOf(definition);
      if (ruleDemand && demand) {
        if (machineClass.platform === "pool") {
          desired.problems.set(
            rule,
            `Machines on demand are created on a platform, and class '${definition.class}' is a pool; this rule's machines are left as they are`,
          );
          continue;
        }
        const waits = assigned.get(rule) ?? [];
        desired.queued.set(rule, waits.length);
        const stalled = demand.stalled.find(
          (machine) =>
            machine.rule === rule &&
            machine.enrolledForMs >= ruleDemand.enrollMinutes * 60_000,
        );
        if (stalled)
          notices.set(rule, [
            ...(notices.get(rule) ?? []),
            neverConnectedNotice({
              name: stalled.name,
              minutes: ruleDemand.enrollMinutes,
              definition,
            }),
          ]);
        for (const machine of demandMachines({
          rule,
          definition,
          demand: ruleDemand,
          machines: demand.machines.filter((machine) => machine.rule === rule),
          loads: demand.loads,
          waits,
          stalled: Boolean(stalled),
        }))
          desired.provisioned.set(machine.name, machine);
        continue;
      }
      const group = definition.group ?? "";
      const members =
        definition.machines === "each-member" ? await this.members(group) : [];
      if (machineClass.platform === "pool") {
        const holders =
          definition.machines === "each-member"
            ? members.map((member) => ({
                holder: { member: member.userId },
                group: null,
                access: WorkerAccessSchema.parse({
                  people: [member.email],
                }),
                trusted: false,
              }))
            : Array.from(
                {
                  length:
                    "shared" in definition.machines
                      ? definition.machines.shared
                      : 0,
                },
                (_, index) => ({
                  holder: { slot: index + 1 },
                  group,
                  access: WorkerAccessSchema.parse({ groups: [group] }),
                  trusted: definition.trusted,
                }),
              );
        for (const holder of holders)
          desired.slots.push({
            rule,
            class: definition.class,
            retainDays: definition.retainDays,
            ...holder,
          });
        continue;
      }
      const labels = { ...definition.labels, class: definition.class };
      const add = (name: string, placement: unknown) =>
        desired.provisioned.set(name, {
          name,
          rule,
          class: definition.class,
          placement: WorkerPlacementSchema.parse(placement),
          retainDays: definition.retainDays,
        });
      if (definition.machines === "each-member") {
        for (const member of members)
          add(dedicatedName(rule, member.userId, definition.class), {
            labels,
            access: { people: [member.email] },
          });
        continue;
      }
      const shared =
        "shared" in definition.machines ? definition.machines.shared : 0;
      for (let index = 1; index <= shared; index += 1)
        add(sharedName(rule, definition.class, group, index), {
          labels,
          access: { groups: [group] },
          trusted: definition.trusted,
        });
    }
    return desired;
  }

  /**
   * What machines on demand decide on (ADR 0258): the work waiting for a
   * machine with a turn queued, tried recently and oldest first, with its
   * owner's directory groups; every machine a rule provisioned; how busy
   * each enrolled one is; and machines that enrolled since their rule was
   * last written and never connected.
   */
  private async demandState(): Promise<{
    waits: DemandWait[];
    machines: ProvisionedMachine[];
    loads: Map<string, MachineLoad>;
    stalled: Array<{ rule: string; name: string; enrolledForMs: number }>;
  }> {
    const [rows, machines, loads, stalled] = await Promise.all([
      this.deps.db
        .selectFrom("placement_waits")
        .leftJoin(
          "work_accounts",
          "work_accounts.user_id",
          "placement_waits.owner",
        )
        .select([
          "placement_waits.project_id",
          "placement_waits.owner",
          "placement_waits.pool",
          "placement_waits.requirements",
          "work_accounts.directory_groups",
          "work_accounts.disabled_at",
        ])
        .where("placement_waits.tenant_id", "=", this.deps.tenantId)
        .where("placement_waits.last_tried_at", ">", waitFresh())
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("agent_turns")
              .select("agent_turns.id")
              .whereRef(
                "agent_turns.session_id",
                "=",
                "placement_waits.root_workload_id",
              )
              .where("agent_turns.status", "=", "queued"),
          ),
        )
        .orderBy("placement_waits.waiting_since")
        .execute(),
      this.deps.workers.machines(),
      this.deps.workers.machineLoad(),
      this.deps.db
        .selectFrom("work_workers")
        .innerJoin("work_machine_rules", (join) =>
          join
            .onRef(
              "work_machine_rules.tenant_id",
              "=",
              "work_workers.tenant_id",
            )
            .onRef("work_machine_rules.name", "=", "work_workers.machine_rule"),
        )
        .select([
          "work_workers.machine_rule",
          "work_workers.name",
          sql<number>`(extract(epoch from (now() - work_workers.enrolled_at)) * 1000)::float8`.as(
            "enrolled_for_ms",
          ),
        ])
        .where("work_workers.tenant_id", "=", this.deps.tenantId)
        .where("work_workers.pool", "=", false)
        .where("work_workers.last_seen_at", "is", null)
        .whereRef(
          "work_workers.enrolled_at",
          ">",
          "work_machine_rules.updated_at",
        )
        .orderBy("work_workers.enrolled_at")
        .execute(),
    ]);
    const waits: DemandWait[] = [];
    for (const row of rows) {
      const pool = DemandWaitPool.safeParse(row.pool);
      const requirements = DemandWaitRequirements.safeParse(row.requirements);
      if (!pool.success || !requirements.success) continue;
      // A disabled member's work gets no machine.
      if (row.owner !== null && row.disabled_at !== null) continue;
      waits.push({
        projectId: row.project_id,
        owner: row.owner,
        groups: Array.isArray(row.directory_groups)
          ? row.directory_groups.flatMap((group) =>
              typeof group === "string" ? [group.toLowerCase()] : [],
            )
          : [],
        pool: pool.data,
        requirements: requirements.data,
      });
    }
    return {
      waits,
      machines,
      loads,
      stalled: stalled.map((row) => ({
        rule: row.machine_rule ?? "",
        name: row.name,
        enrolledForMs: Number(row.enrolled_for_ms),
      })),
    };
  }

  /**
   * Whether demand changed since a pass of this replica last looked (ADR
   * 0258): one indexed statement every few seconds, a full pass only when
   * the work waiting for machines, or the work on rules' machines, changed
   * since the latest pass started. A change that came during a pass, or
   * while another replica held the claim, starts one on the next look. Idle
   * machines go on the regular pass. What it remembers is this replica's
   * own shortcut (ADR 0193): another replica looks for itself, and the pass
   * runs under the tenant's claim either way.
   */
  async checkDemand(): Promise<void> {
    const seen = await this.demandSignature();
    if (seen === undefined || seen === this.demandSeen) return;
    this.reconcileSoon();
  }

  /** What the latest pass of this replica saw; see {@link checkDemand}. */
  private demandSeen: string | undefined;

  /** Demand, in one statement; undefined while no rule is on demand. */
  private async demandSignature(): Promise<string | undefined> {
    const row = await this.deps.db
      .selectNoFrom((eb) => [
        eb
          .exists(
            eb
              .selectFrom("work_machine_rules")
              .select("name")
              .where("tenant_id", "=", this.deps.tenantId)
              .where(sql<boolean>`definition -> 'machines' ? 'demand'`),
          )
          .as("demand"),
        eb
          .selectFrom("placement_waits")
          .select(
            sql<string>`count(*)::text || '/' || coalesce(max(waiting_since)::text, '')`.as(
              "waits",
            ),
          )
          .where("tenant_id", "=", this.deps.tenantId)
          .where("last_tried_at", ">", waitFresh())
          .where(({ exists, selectFrom }) =>
            exists(
              selectFrom("agent_turns")
                .select("agent_turns.id")
                .whereRef(
                  "agent_turns.session_id",
                  "=",
                  "placement_waits.root_workload_id",
                )
                .where("agent_turns.status", "=", "queued"),
            ),
          )
          .as("waits"),
        eb
          .selectFrom("execution_allocations")
          .select(
            sql<string>`count(*) FILTER (WHERE capacity_released_at IS NULL)::text || '/' || coalesce(max(capacity_released_at)::text, '')`.as(
              "work",
            ),
          )
          .where(
            "worker_node_id",
            "in",
            eb
              .selectFrom("work_workers")
              .select("node_id")
              .where("tenant_id", "=", this.deps.tenantId)
              .where("machine_rule", "is not", null)
              .where("revoked_at", "is", null),
          )
          .as("work"),
      ])
      .executeTakeFirst();
    if (!row?.demand) return undefined;
    return `${row.waits ?? ""}|${row.work ?? ""}`;
  }

  /** Active accounts the directory last placed in the group. */
  private async members(
    group: string,
  ): Promise<Array<{ userId: string; email: string }>> {
    const rows = await this.deps.db
      .selectFrom("work_accounts")
      .select("user_id")
      .where("disabled_at", "is", null)
      .where(
        sql<boolean>`directory_groups @> ${JSON.stringify([group])}::jsonb`,
      )
      .orderBy("user_id")
      .execute();
    const members: Array<{ userId: string; email: string }> = [];
    for (const row of rows) {
      const email = await this.deps.emailOf(row.user_id);
      if (email) members.push({ userId: row.user_id, email });
    }
    return members;
  }
}

/** Another reconciler holds the claim: this pass stops before changing more. */
class ReconcilerLeaseLostError extends Error {
  constructor() {
    super("The machine reconciler's claim moved to another replica");
    this.name = "ReconcilerLeaseLostError";
  }
}

/** Retention measured by the database's clock (`releasedForMs`). */
function retentionEnded(args: {
  releasedForMs: number;
  retainDays: number;
}): boolean {
  return args.releasedForMs >= args.retainDays * DAY_MS;
}

/** The place a held pooled machine fills, as its rule last assigned it. */
function machineSlot(
  machine: PooledMachine,
): Pick<DesiredSlot, "rule" | "holder" | "group"> {
  return {
    rule: machine.rule ?? "",
    ...(machine.member !== null
      ? { holder: { member: machine.member }, group: null }
      : {
          holder: { slot: machine.slot ?? 0 },
          group: accessGroupsOf(machine.placement.access)[0] ?? "",
        }),
  };
}

/**
 * A place's identity. A shared place includes its group, so a rule whose
 * group changes releases its machines rather than handing them over.
 */
function slotKey(slot: Pick<DesiredSlot, "rule" | "holder" | "group">): string {
  return "member" in slot.holder
    ? `${slot.rule}\0member\0${slot.holder.member}`
    : `${slot.rule}\0slot\0${slot.group ?? ""}\0${slot.holder.slot}`;
}

/**
 * A stable worker name for one person's machine under one rule. The class
 * is part of it: a new class means a new machine, never a relabeled one.
 */
export function dedicatedName(
  rule: string,
  userId: string,
  machineClass: string,
): string {
  return `${rule}-${digest(`${userId}\0${machineClass}`, 12)}`;
}

/**
 * A stable worker name for a group's shared machine. The class and the
 * group are part of it: another group never inherits a machine and its disk.
 */
export function sharedName(
  rule: string,
  machineClass: string,
  group: string,
  index: number,
): string {
  return `${rule}-${digest(`${machineClass}\0${group}`, 6)}-${index}`;
}

/**
 * A stable worker name for a machine on demand. The class and whom it
 * serves (a group, or the projects) are part of it: a machine never moves
 * to other people's work with its disk.
 */
export function demandName(args: {
  rule: string;
  machineClass: string;
  scope: { group: string } | { projects: readonly string[] };
  index: number;
}): string {
  return `${demandPrefix(args)}${args.index}`;
}

function demandPrefix(args: {
  rule: string;
  machineClass: string;
  scope: { group: string } | { projects: readonly string[] };
}): string {
  const scope =
    "group" in args.scope
      ? `group\0${args.scope.group}`
      : `projects\0${[...args.scope.projects].sort().join(",")}`;
  return `${args.rule}-${digest(`${args.machineClass}\0${scope}`, 6)}-`;
}

/**
 * Whether a rule on demand serves this waiting work: a machine with the
 * rule's labels (and its class, on a worker) satisfies the work's pool,
 * and its access takes the work's owner. A group's machines take its
 * members' chats; projects' machines take those projects' own work.
 */
function demandWaitMatches(rule: MachineRule, wait: DemandWait): boolean {
  const labels = { ...rule.labels, class: rule.class, plane: "worker" };
  if (!poolMatches(labels, wait.pool)) return false;
  if (rule.projects)
    return wait.owner === null && rule.projects.includes(wait.projectId);
  return (
    wait.owner !== null &&
    rule.group !== undefined &&
    wait.groups.includes(rule.group)
  );
}

/** Since when a wait for a machine still counts as demand (ADR 0258). */
function waitFresh() {
  return sql<Date>`now() - make_interval(secs => ${PLACEMENT_WAIT_FRESH_SECONDS})`;
}

/** A rule whose machines serve more than one person or project. */
function servesSeveral(rule: MachineRule): boolean {
  return rule.group !== undefined || (rule.projects?.length ?? 0) > 1;
}

/**
 * What a rule's connected machines lack for a piece of waiting work, from
 * what they report, or undefined when one could take it or none reported
 * yet. The work's own needs are checked as admission checks them; a
 * machine's free room is not.
 */
function demandShortfall(args: {
  machines: readonly ProvisionedMachine[];
  loads: ReadonlyMap<string, MachineLoad>;
  wait: DemandWait;
}): string | undefined {
  const { requirements } = args.wait;
  const reasons: string[][] = [];
  for (const machine of args.machines) {
    const descriptor = args.loads.get(machine.name)?.live?.descriptor;
    if (!descriptor) continue;
    const fit = environmentSatisfies(descriptor, {
      workload: "agent",
      capabilities: requirements.capabilities,
      resources: requirements.resources,
      ...(requirements.trust ? { trust: requirements.trust } : {}),
      ...(requirements.isolation ? { isolation: requirements.isolation } : {}),
      ...(requirements.topology ? { topology: requirements.topology } : {}),
    });
    if (fit.compatible) return undefined;
    reasons.push([...fit.reasons]);
  }
  return reasons[0]?.join("; ");
}

/** Why a rule on demand makes no more machines: one never connected. */
function neverConnectedNotice(args: {
  name: string;
  minutes: number;
  definition: MachineRule;
}): string {
  const why =
    !args.definition.trusted && servesSeveral(args.definition)
      ? `It serves ${args.definition.group ? "a group" : "several projects"}, so it must isolate agents (microsandbox or gVisor) to connect; one running plain processes is refused. Check its log, or add "trusted": true if everyone it serves trusts each other.`
      : "Check its log: it may not reach this server, or its sandboxes may not start.";
  return `Machine ${args.name} enrolled but did not connect within ${args.minutes} minutes, so this rule makes no more machines until it is written again. ${why}`;
}

/** What one machine has room for, as admission charges it. */
function roomFor(
  room: { workspaces: number; cpuMillis?: number; memoryMb?: number },
  defaults: { cpuMillis?: number; memoryMb?: number },
  wait: DemandWait,
): { cpuMillis: number; memoryMb: number } | undefined {
  const cpuMillis =
    wait.requirements.resources.cpuMillis ?? defaults.cpuMillis ?? 0;
  const memoryMb =
    wait.requirements.resources.memoryMb ?? defaults.memoryMb ?? 0;
  if (room.workspaces < 1) return undefined;
  if (room.cpuMillis !== undefined && room.cpuMillis < cpuMillis)
    return undefined;
  if (room.memoryMb !== undefined && room.memoryMb < memoryMb) return undefined;
  return { cpuMillis, memoryMb };
}

/**
 * The machines a rule on demand calls for now (ADR 0258). It keeps every
 * machine still enrolling, every machine that enrolled and is still
 * connecting, every machine holding work, every machine idle for less than
 * `idleMinutes`, then the most recently idle up to `min`. A machine not
 * seen for `enrollMinutes` (since it enrolled, when it never connected) is
 * lost and kept for nothing. Work no connected machine has room for (each
 * piece charged its resources, or the machine's defaults), beyond one
 * piece per machine still enrolling or connecting, gets new machines up to
 * `max`, counting the rule's machines for whom it served before. A rule
 * whose machine never connected makes none.
 */
function demandMachines(args: {
  rule: string;
  definition: MachineRule;
  demand: MachineDemand;
  machines: readonly ProvisionedMachine[];
  loads: ReadonlyMap<string, MachineLoad>;
  waits: readonly DemandWait[];
  stalled: boolean;
}): DesiredMachine[] {
  const { rule, definition, demand } = args;
  const scope: { group: string } | { projects: readonly string[] } =
    definition.projects
      ? { projects: definition.projects }
      : { group: definition.group ?? "" };
  const prefix = demandPrefix({
    rule,
    machineClass: definition.class,
    scope,
  });
  const placement = WorkerPlacementSchema.parse({
    labels: { ...definition.labels, class: definition.class },
    access:
      "projects" in scope
        ? { projects: [...scope.projects] }
        : { groups: [scope.group] },
    trusted: definition.trusted,
  });
  const desired = (name: string, waiting?: DesiredMachine["waiting"]) => ({
    name,
    rule,
    class: definition.class,
    placement,
    retainDays: 0,
    enrollMinutes: demand.enrollMinutes,
    ...(waiting ? { waiting } : {}),
  });
  // Only machines for whom the rule serves now: another group's or
  // projects' machines go once their work is done, and count meanwhile.
  const own = args.machines.filter((machine) =>
    machine.name.startsWith(prefix),
  );
  const before = args.machines.filter(
    (machine) =>
      !machine.name.startsWith(prefix) &&
      (machine.state === "pending" || machine.state === "enrolled"),
  ).length;
  const lostAfter = demand.enrollMinutes * 60_000;
  const kept: ProvisionedMachine[] = [];
  /** Kept machines that will take a piece of work once they connect. */
  let coming = 0;
  const idle: Array<{ machine: ProvisionedMachine; idleForMs: number }> = [];
  for (const machine of own) {
    if (machine.state === "pending") {
      kept.push(machine);
      coming += 1;
      continue;
    }
    if (machine.state !== "enrolled") continue;
    const load = args.loads.get(machine.name);
    if (!load) continue;
    if (!load.live && load.unseenForMs >= lostAfter) continue;
    if (load.holding > 0) kept.push(machine);
    else if (load.neverConnected) {
      // Enrolled, and still starting its worker.
      kept.push(machine);
      coming += 1;
    } else if (load.idleForMs < demand.idleMinutes * 60_000) kept.push(machine);
    else idle.push({ machine, idleForMs: load.idleForMs });
  }
  idle.sort((left, right) => left.idleForMs - right.idleForMs);
  for (const { machine } of idle) {
    if (kept.length >= demand.min) break;
    kept.push(machine);
  }
  // Work a connected kept machine has room for is admitted there on its
  // next try.
  const free = kept.flatMap((machine) => {
    const live = args.loads.get(machine.name)?.live;
    return live ? [{ room: { ...live.free }, defaults: live.defaults }] : [];
  });
  const uncovered = args.waits.filter((wait) => {
    for (const slot of free) {
      const charged = roomFor(slot.room, slot.defaults, wait);
      if (!charged) continue;
      slot.room.workspaces -= 1;
      if (slot.room.cpuMillis !== undefined)
        slot.room.cpuMillis -= charged.cpuMillis;
      if (slot.room.memoryMb !== undefined)
        slot.room.memoryMb -= charged.memoryMb;
      return false;
    }
    return true;
  });
  const unmet = uncovered.slice(coming);
  const room = Math.max(0, demand.max - kept.length - before);
  const add = args.stalled
    ? 0
    : Math.min(room, Math.max(unmet.length, demand.min - kept.length, 0));
  const machines = kept.map((machine) => desired(machine.name));
  const taken = new Set(own.map((machine) => machine.name));
  for (let index = 1, made = 0; made < add; index += 1) {
    const name = `${prefix}${index}`;
    if (taken.has(name)) continue;
    const wait = unmet[made];
    machines.push(
      desired(
        name,
        wait
          ? {
              resources: wait.requirements.resources,
              capabilities: wait.requirements.capabilities,
            }
          : undefined,
      ),
    );
    made += 1;
  }
  return machines;
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON with sorted keys: stored jsonb reorders keys, so compare this way. */
function canonical(value: unknown): string {
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
