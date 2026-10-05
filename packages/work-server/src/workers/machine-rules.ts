import { createHash, randomUUID } from "node:crypto";
import {
  releaseReplicaClaim,
  renewReplicaClaim,
  takeReplicaClaim,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type { HetznerCloudMachines } from "@catamorphic/hetzner";
import { getTracer, withSpan } from "@catamorphic/otel";
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
  NodeLabelsSchema,
  WorkerAccessSchema,
  type WorkerPlacement,
  WorkerPlacementSchema,
} from "./placement.js";
import type {
  PooledMachine,
  ProvisionedMachine,
  WorkWorkerRegistry,
} from "./worker-registry.js";

const tracer = getTracer("@catamorphic/work-server");

/** Days a released machine keeps its disk unless its rule says otherwise. */
export const DEFAULT_RETAIN_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

/**
 * A machine rule (ADRs 0167, 0204): every active member of a directory
 * group gets a machine of their own, or the group shares a fixed number of
 * machines, of a machine class. A machine nobody should have any more is
 * released and kept for `retainDays` before it is destroyed or reset.
 */
export const MachineRuleSchema = z.strictObject({
  group: z.email().toLowerCase(),
  machines: z.union([
    z.literal("each-member"),
    z.strictObject({ shared: z.number().int().positive().max(100) }),
  ]),
  /** A class from `WORK_MACHINES_CONFIG`, or the provisioner hook's. */
  class: z.string().min(1).max(64),
  /** Labels a created machine carries; a pooled one keeps its own. */
  labels: NodeLabelsSchema.default({}),
  /** Shared machines only: the group's members trust each other. */
  trusted: z.boolean().default(false),
  /** Days a released machine keeps its disk; 0 destroys or resets it at once. */
  retainDays: z.number().int().min(0).max(365).default(DEFAULT_RETAIN_DAYS),
});
export type MachineRule = z.output<typeof MachineRuleSchema>;

/**
 * Creates and destroys worker machines on a platform (a cloud, a
 * virtualization host) for `custom` classes. A created machine starts the
 * Work worker with the given control plane and one-time enrollment code,
 * for example by running `enrollment.cloudInit` through cloud-init; it
 * enrolls itself.
 */
export interface MachineProvisioner {
  create(args: {
    name: string;
    class: string;
    labels: Readonly<Record<string, string>>;
    enrollment: {
      controlPlaneUrl: string;
      code: string;
      /**
       * Cloud-init user data that installs the worker with this code (ADR
       * 0204), when the server knows its worker image.
       */
      cloudInit?: string;
    };
  }): Promise<{ ref: string }>;
  destroy(args: { name: string; ref: string | null }): Promise<void>;
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
  /** Pooled machines reset and free again. */
  reset: string[];
  failed: Array<{ name: string; error: string }>;
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
  /** Why the rule cannot be acted on, such as an unknown class. */
  problem?: string;
}

/** A machine a provisioned rule calls for, by its stable name. */
interface DesiredMachine {
  name: string;
  rule: string;
  class: string;
  placement: WorkerPlacement;
  retainDays: number;
}

/** A place a pool rule fills with one of its class's free machines. */
interface DesiredSlot {
  rule: string;
  class: string;
  holder: { member: string } | { slot: number };
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
}

/** Marks a ref as a Hetzner Cloud server id. */
const HETZNER_REF = "hcloud:";

/**
 * Keeps workers in step with machine rules and the directory (ADR 0204):
 * creates cloud machines and assigns pooled ones that are missing, updates
 * placement that drifted, releases machines nobody should have any more,
 * and destroys or resets them once their retention ends.
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
      /** The clock retention is measured by. */
      now?: () => Date;
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

  async deleteRule(name: string): Promise<boolean> {
    const result = await this.deps.db
      .deleteFrom("work_machine_rules")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", name)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /** Directory groups rules name, for the directory mirror. */
  async groups(): Promise<string[]> {
    return [
      ...new Set(Object.values(await this.rules()).map((rule) => rule.group)),
    ];
  }

  /** How each rule's machines stand right now. */
  async status(): Promise<Record<string, MachineRuleStatus>> {
    const desired = await this.desired();
    const [machines, pooled] = await Promise.all([
      this.deps.workers.machines(),
      this.deps.workers.pooledMachines(),
    ]);
    const status: Record<string, MachineRuleStatus> = {};
    for (const [name, rule] of Object.entries(desired.rules)) {
      const platform = this.classOf(rule.class)?.platform ?? null;
      const problem = desired.problems.get(name);
      if (platform === "pool") {
        const slots = desired.slots.filter((slot) => slot.rule === name);
        const held = pooled.filter((machine) => machine.rule === name);
        const ready = held.filter((machine) => !machine.releasedAt).length;
        status[name] = {
          platform,
          desired: slots.length,
          ready,
          starting: 0,
          waiting: Math.max(0, slots.length - ready),
          released: held.length - ready,
          ...(problem ? { problem } : {}),
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
          !machine.releasedAt &&
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
          (machine) => machine.state === "enrolled" && machine.releasedAt,
        ).length,
        ...(problem ? { problem } : {}),
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

  /** Waits for a pass in progress (shutdown); starts none. */
  async settle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  private get leaseMs(): number {
    return this.deps.leaseMs ?? 120_000;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
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
      reset: [],
      failed: [],
    };
    if (!(await takeReplicaClaim({ ...claim, ttlSeconds }))) {
      // Another replica is reconciling; its pass covers this one.
      return { ...summary, busy: true };
    }
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
      await this.pass({ fence, summary });
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

  /**
   * Records what it changes in `summary`; `fence` throws once another
   * reconciler holds the claim, ending the pass with what it did so far.
   */
  private async pass(args: {
    fence: () => Promise<void>;
    summary: ReconcileSummary;
  }): Promise<void> {
    const desired = await this.desired();
    for (const [rule, problem] of desired.problems)
      args.summary.failed.push({ name: rule, error: problem });
    await this.reconcileProvisioned({ ...args, desired });
    await this.reconcilePooled({ ...args, desired });
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
    const now = this.now();
    const destroy = async (machine: ProvisionedMachine) => {
      await fence();
      try {
        await this.unprovision(machine);
        await this.deps.workers.forgetMachine(machine);
        summary.removed.push(machine.name);
        return true;
      } catch (error) {
        // The machine keeps its record, so the next pass tries again.
        summary.failed.push({ name: machine.name, error: message(error) });
        return false;
      }
    };
    const machines = await this.deps.workers.machines();

    // Expired codes, machines an operator revoked, and machines nobody
    // should have go first, and a name is reused only after its old
    // machine is gone. An enrolled machine is released before that and
    // kept for its retention.
    const pendingDestroy = new Set<string>();
    for (const machine of machines) {
      if (desired.problems.has(machine.rule)) continue;
      const wanted = desired.provisioned.has(machine.name);
      if (wanted && machine.state !== "expired" && machine.state !== "revoked")
        continue;
      if (machine.state === "enrolled") {
        const retainDays = this.retainDaysOf({ machine, desired });
        const releasedAt = machine.releasedAt ?? now;
        if (!machine.releasedAt) {
          await fence();
          await this.deps.workers.release({
            name: machine.name,
            at: now,
            retainDays,
          });
          summary.released.push(machine.name);
        }
        if (!retentionEnded({ releasedAt, retainDays, now })) continue;
        // Chats on it give their workspaces back saved once they idle (ADR
        // 0173); a machine that can no longer save them goes at once.
        if (
          (await this.deps.workers.connected({ name: machine.name })) &&
          (await this.deps.workers.activeWorkspaces({ name: machine.name })) > 0
        )
          continue;
      }
      if (machine.state === "enrolled" || machine.state === "pending") {
        await fence();
        await this.deps.workers.revoke({ name: machine.name });
        await this.deps.workers.cancelEnrollments({ name: machine.name });
      }
      if (!(await destroy(machine))) pendingDestroy.add(machine.name);
    }

    for (const machine of desired.provisioned.values()) {
      if (pendingDestroy.has(machine.name)) continue;
      const current = machines.find(
        (candidate) =>
          candidate.name === machine.name &&
          (candidate.state === "enrolled" || candidate.state === "pending"),
      );
      if (current?.state === "pending") continue;
      try {
        if (current?.releasedAt) {
          // Their person or group is back before the machine went.
          await fence();
          await this.deps.workers.reassign(machine);
          summary.assigned.push(machine.name);
          continue;
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
          continue;
        }
        await fence();
        const enrollment = await this.deps.workers.createMachineEnrollment({
          name: machine.name,
          rule: machine.rule,
          ttlMinutes: 60,
          placement: machine.placement,
        });
        // Its machine enrolled or is being created since this pass looked.
        if (!enrollment) continue;
        const ref = await this.provision({ machine, code: enrollment.code });
        await this.deps.workers.recordMachineRef({
          code: enrollment.code,
          ref,
        });
        summary.created.push(machine.name);
      } catch (error) {
        if (error instanceof ReconcilerLeaseLostError) throw error;
        summary.failed.push({ name: machine.name, error: message(error) });
      }
    }
  }

  /**
   * Pooled machines (ADR 0204): each place a pool rule calls for holds one
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
    const now = this.now();
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
      if (desired.problems.has(machine.rule)) {
        if (!machine.releasedAt) held.add(slotKey(machineSlot(machine)));
        continue;
      }
      if (machine.releasedAt) {
        released.push(machine);
        continue;
      }
      const slot = slots.get(slotKey(machineSlot(machine)));
      if (slot && fits(machine, slot)) {
        held.add(slotKey(slot));
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
        continue;
      }
      const retainDays = this.retainDaysOf({ machine, desired });
      await fence();
      await this.deps.workers.release({
        name: machine.name,
        at: now,
        retainDays,
      });
      summary.released.push(machine.name);
      released.push({ ...machine, releasedAt: now, retainDays });
    }

    // Released machines go back to their person or group within their
    // retention; afterwards they are reset.
    const resets = pooled
      .filter((machine) => !machine.rule && machine.releasedAt)
      .map((machine) => machine.name);
    for (const machine of released) {
      const slot = slots.get(slotKey(machineSlot(machine)));
      const retainDays = this.retainDaysOf({ machine, desired });
      const ended = retentionEnded({
        releasedAt: machine.releasedAt ?? now,
        retainDays,
        now,
      });
      if (slot && fits(machine, slot) && !ended) {
        await fence();
        await this.deps.workers.reassign({
          name: machine.name,
          placement: placementFor(machine, slot),
          retainDays: slot.retainDays,
        });
        held.add(slotKey(slot));
        summary.assigned.push(machine.name);
        continue;
      }
      if (!ended) continue;
      await fence();
      await this.deps.workers.beginReset({ name: machine.name });
      resets.push(machine.name);
    }

    // Resets run at once. A machine that is not connected is reset when it
    // reconnects, and one whose chats still hold workspaces once they idle
    // and give them back saved (ADR 0173), on a later pass.
    const freed = new Set<string>();
    await Promise.all(
      resets.map(async (name) => {
        if (!(await this.deps.workers.connected({ name }))) return;
        if ((await this.deps.workers.activeWorkspaces({ name })) > 0) return;
        try {
          await fence();
          await this.deps.workers.resetPooled({ name });
          await fence();
          await this.deps.workers.freePooled({ name });
          freed.add(name);
          summary.reset.push(name);
        } catch (error) {
          if (error instanceof ReconcilerLeaseLostError) throw error;
          summary.failed.push({ name, error: message(error) });
        }
      }),
    );

    // Places still without a machine take a free one of their class.
    const free = pooled.filter(
      (machine) =>
        (!machine.rule && !machine.releasedAt) || freed.has(machine.name),
    );
    for (const slot of desired.slots) {
      if (held.has(slotKey(slot)) || desired.problems.has(slot.rule)) continue;
      const index = free.findIndex(
        (machine) => machine.placement.labels.class === slot.class,
      );
      const [machine] = index >= 0 ? free.splice(index, 1) : [];
      if (!machine) continue;
      await fence();
      const placement = placementFor(machine, slot);
      if (
        await this.deps.workers.assignPooled({
          name: machine.name,
          rule: slot.rule,
          holder: slot.holder,
          placement,
          retainDays: slot.retainDays,
        })
      ) {
        held.add(slotKey(slot));
        summary.assigned.push(machine.name);
      }
    }
  }

  /** Create a machine on its class's platform; resolves with its ref. */
  private async provision(args: {
    machine: DesiredMachine;
    code: string;
  }): Promise<string> {
    const { machine, code } = args;
    const machineClass = this.classOf(machine.class);
    const cloudInit =
      "target" in this.deps.install
        ? workerCloudInit({
            script: workerInstallScript(this.deps.install.target),
            code,
          })
        : undefined;
    if (machineClass?.platform === "hetzner-cloud") {
      if (!this.deps.hetzner)
        throw new Error(
          "Set WORK_HETZNER_TOKEN to create Hetzner Cloud machines",
        );
      if (!cloudInit)
        throw new Error(
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
        labels: machine.placement.labels,
        enrollment: {
          controlPlaneUrl: this.deps.controlPlaneUrl,
          code,
          ...(cloudInit ? { cloudInit } : {}),
        },
      });
      return ref;
    }
    throw new Error(`Machine class '${machine.class}' creates no machines`);
  }

  /** Destroy a machine on the platform that made it. */
  private async unprovision(machine: ProvisionedMachine): Promise<void> {
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
      await this.deps.hetzner.destroy({
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
      return;
    }
    if (!this.deps.provisioner)
      throw new Error(
        `No platform destroys machines of class '${className ?? "unknown"}'`,
      );
    await this.deps.provisioner.destroy({
      name: machine.name,
      ref: machine.ref,
    });
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
    };
    for (const [rule, definition] of Object.entries(rules)) {
      const machineClass = this.classOf(definition.class);
      if (!machineClass) {
        desired.problems.set(
          rule,
          `Machine class '${definition.class}' is not configured; this rule's machines are left as they are`,
        );
        continue;
      }
      const members =
        definition.machines === "each-member"
          ? await this.members(definition.group)
          : [];
      if (machineClass.platform === "pool") {
        const holders =
          definition.machines === "each-member"
            ? members.map((member) => ({
                holder: { member: member.userId },
                access: WorkerAccessSchema.parse({
                  people: [member.email],
                }),
                trusted: false,
              }))
            : Array.from(
                { length: definition.machines.shared },
                (_, index) => ({
                  holder: { slot: index + 1 },
                  access: WorkerAccessSchema.parse({
                    groups: [definition.group],
                  }),
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
      for (let index = 1; index <= definition.machines.shared; index += 1)
        add(sharedName(rule, definition.class, index), {
          labels,
          access: { groups: [definition.group] },
          trusted: definition.trusted,
        });
    }
    return desired;
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

function retentionEnded(args: {
  releasedAt: Date;
  retainDays: number;
  now: Date;
}): boolean {
  return (
    args.releasedAt.getTime() + args.retainDays * DAY_MS <= args.now.getTime()
  );
}

function machineSlot(
  machine: PooledMachine,
): Pick<DesiredSlot, "rule" | "holder"> {
  return {
    rule: machine.rule ?? "",
    holder:
      machine.member !== null
        ? { member: machine.member }
        : { slot: machine.slot ?? 0 },
  };
}

function slotKey(slot: Pick<DesiredSlot, "rule" | "holder">): string {
  return "member" in slot.holder
    ? `${slot.rule}\0member\0${slot.holder.member}`
    : `${slot.rule}\0slot\0${slot.holder.slot}`;
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

/** A stable worker name for a group's shared machine. */
export function sharedName(
  rule: string,
  machineClass: string,
  index: number,
): string {
  return `${rule}-${digest(machineClass, 4)}-${index}`;
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
