import { createHash, randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
  NodeLabelsSchema,
  type WorkerPlacement,
  WorkerPlacementSchema,
} from "./placement.js";
import type { WorkWorkerRegistry } from "./worker-registry.js";

/**
 * A machine rule (ADR 0167): every active member of a directory group gets
 * a machine of their own, or the group shares a fixed number of machines.
 */
export const MachineRuleSchema = z.strictObject({
  group: z.email().toLowerCase(),
  machines: z.union([
    z.literal("each-member"),
    z.strictObject({ shared: z.number().int().positive().max(100) }),
  ]),
  /** The provisioner's machine class, such as a size or an image. */
  class: z.string().min(1).max(64),
  labels: NodeLabelsSchema.default({}),
  /** Shared machines only: the group's members trust each other. */
  trusted: z.boolean().default(false),
});
export type MachineRule = z.output<typeof MachineRuleSchema>;

const RuleName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Use lowercase letters, digits, dashes");

/**
 * Creates and destroys worker machines on a platform (a cloud, a
 * virtualization host). A created machine starts the Work worker with the
 * given control plane and one-time enrollment code, for example through
 * cloud-init; it enrolls itself.
 */
export interface MachineProvisioner {
  create(args: {
    name: string;
    class: string;
    labels: Readonly<Record<string, string>>;
    enrollment: { controlPlaneUrl: string; code: string };
  }): Promise<{ ref: string }>;
  destroy(args: { name: string; ref: string | null }): Promise<void>;
}

export interface ReconcileSummary {
  created: string[];
  updated: string[];
  removed: string[];
  failed: Array<{ name: string; error: string }>;
}

interface DesiredMachine {
  name: string;
  rule: string;
  class: string;
  placement: WorkerPlacement;
}

/**
 * Keeps enrolled workers in step with machine rules and the directory:
 * creates what is missing, updates placement that drifted, and revokes and
 * destroys machines nobody should have, such as a disabled member's.
 */
export class MachineReconciler {
  private running: Promise<ReconcileSummary> | undefined;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      tenantId: string;
      workers: WorkWorkerRegistry;
      provisioner: MachineProvisioner;
      controlPlaneUrl: string;
      /** A user's sign-in email, for dedicated machines' access. */
      emailOf: (userId: string) => Promise<string | undefined>;
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

  async setRule(args: { name: string; rule: unknown }): Promise<MachineRule> {
    const name = RuleName.parse(args.name);
    const rule = MachineRuleSchema.parse(args.rule);
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

  /** One pass; concurrent callers share it, and replicas take turns. */
  reconcile(): Promise<ReconcileSummary> {
    this.running ??= this.guardedPass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private readonly holder = randomUUID();

  private async guardedPass(): Promise<ReconcileSummary> {
    const held = await sql<{ holder: string }>`
      INSERT INTO work_machine_reconciler (tenant_id, holder, expires_at)
      VALUES (${this.deps.tenantId}, ${this.holder}, now() + interval '10 minutes')
      ON CONFLICT (tenant_id) DO UPDATE
        SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
        WHERE work_machine_reconciler.expires_at < now()
           OR work_machine_reconciler.holder = EXCLUDED.holder
      RETURNING holder
    `.execute(this.deps.db);
    if (held.rows.length === 0) {
      // Another replica is reconciling; its pass covers this one.
      return { created: [], updated: [], removed: [], failed: [] };
    }
    try {
      return await this.pass();
    } finally {
      await this.deps.db
        .deleteFrom("work_machine_reconciler")
        .where("tenant_id", "=", this.deps.tenantId)
        .where("holder", "=", this.holder)
        .execute();
    }
  }

  private async pass(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      created: [],
      updated: [],
      removed: [],
      failed: [],
    };
    const destroy = async (machine: { name: string; ref: string | null }) => {
      try {
        await this.deps.provisioner.destroy(machine);
        await this.deps.workers.forgetMachine(machine);
        summary.removed.push(machine.name);
        return true;
      } catch (error) {
        // The machine keeps its record, so the next pass tries again.
        summary.failed.push({ name: machine.name, error: message(error) });
        return false;
      }
    };
    const desired = await this.desired();
    const machines = await this.deps.workers.machines();

    // Expired codes and machines nobody should have go first, and a name
    // is reused only after its old machine is gone.
    const pendingDestroy = new Set<string>();
    for (const machine of machines) {
      const unwanted =
        machine.state === "expired" ||
        machine.state === "revoked" ||
        !desired.has(machine.name);
      if (!unwanted) continue;
      if (machine.state === "enrolled" || machine.state === "pending") {
        await this.deps.workers.revoke({ name: machine.name });
        await this.deps.workers.cancelEnrollments({ name: machine.name });
      }
      if (!(await destroy(machine))) pendingDestroy.add(machine.name);
    }

    for (const machine of desired.values()) {
      if (pendingDestroy.has(machine.name)) continue;
      const current = machines.find(
        (candidate) =>
          candidate.name === machine.name &&
          (candidate.state === "enrolled" || candidate.state === "pending"),
      );
      try {
        if (current?.state === "enrolled") {
          if (canonical(current.placement) !== canonical(machine.placement)) {
            await this.deps.workers.setPlacement({
              name: machine.name,
              placement: machine.placement,
            });
            summary.updated.push(machine.name);
          }
          continue;
        }
        if (current) continue;
        const enrollment = await this.deps.workers.createEnrollment({
          name: machine.name,
          ttlMinutes: 60,
          placement: machine.placement,
          machine: { rule: machine.rule },
        });
        const { ref } = await this.deps.provisioner.create({
          name: machine.name,
          class: machine.class,
          labels: machine.placement.labels,
          enrollment: {
            controlPlaneUrl: this.deps.controlPlaneUrl,
            code: enrollment.code,
          },
        });
        await this.deps.workers.recordMachineRef({
          code: enrollment.code,
          ref,
        });
        summary.created.push(machine.name);
      } catch (error) {
        summary.failed.push({ name: machine.name, error: message(error) });
      }
    }
    const changed =
      summary.created.length + summary.updated.length + summary.removed.length;
    if (changed > 0 || summary.failed.length > 0) {
      this.deps.log?.(
        `Machines: ${summary.created.length} created, ${summary.updated.length} updated, ${summary.removed.length} removed, ${summary.failed.length} failed`,
      );
    }
    return summary;
  }

  private async desired(): Promise<Map<string, DesiredMachine>> {
    const desired = new Map<string, DesiredMachine>();
    for (const [rule, definition] of Object.entries(await this.rules())) {
      const labels = { ...definition.labels, class: definition.class };
      if (definition.machines === "each-member") {
        for (const member of await this.members(definition.group)) {
          const name = dedicatedName(rule, member.userId, definition.class);
          desired.set(name, {
            name,
            rule,
            class: definition.class,
            placement: WorkerPlacementSchema.parse({
              labels,
              access: { people: [member.email] },
            }),
          });
        }
        continue;
      }
      for (let index = 1; index <= definition.machines.shared; index += 1) {
        const name = sharedName(rule, definition.class, index);
        desired.set(name, {
          name,
          rule,
          class: definition.class,
          placement: WorkerPlacementSchema.parse({
            labels,
            access: { groups: [definition.group] },
            trusted: definition.trusted,
          }),
        });
      }
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
      .execute();
    const members: Array<{ userId: string; email: string }> = [];
    for (const row of rows) {
      const email = await this.deps.emailOf(row.user_id);
      if (email) members.push({ userId: row.user_id, email });
    }
    return members;
  }
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
