import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  isProjectPrincipal,
  PLACEMENT_WAIT_FRESH_SECONDS,
  type WorkerNode,
  type WorkerNodesService,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import { parseSignInCapability } from "@catamorphic/sandbox";
import {
  type Kysely,
  type Selectable,
  sql,
  type Transaction,
  type UpdateObject,
} from "kysely";
import { z } from "zod";
import {
  DEFAULT_LOST_AFTER_MINUTES,
  type MachineFacts,
  type MachinePrincipal,
  type MachineState,
  type MachineVerb,
  normalizePrincipals,
  type WaitingWork,
} from "../machines/contract.js";
import {
  lostAfterMsOf,
  type MachinePhase,
  type MachineRecord,
  machineStateOf,
  type PlannedMachine,
} from "../machines/sequencer.js";
import {
  type ScheduledPlacement,
  storedPlacement,
  type WorkerPlacement,
} from "./placement.js";

export const WORKER_NODE_PREFIX = "worker.";

/** Minutes an enrollment code works; a machine still starting keeps its code. */
const ENROLLMENT_MINUTES = 60;

type MachineRow = Selectable<DB["work_machines"]>;

const PHASES: readonly MachinePhase[] = [
  "starting",
  "running",
  "stopping",
  "stopped",
  "resuming",
  "destroying",
];

function phaseOf(value: string): MachinePhase {
  return PHASES.find((phase) => phase === value) ?? "starting";
}

const VERBS: readonly MachineVerb[] = [
  "create",
  "destroy",
  "stop",
  "start",
  "describe",
];

const OptionsSchema = z.record(z.string(), z.unknown());

const WaitPool = z.record(z.string(), z.string());
const WaitRequirements = z.object({
  resources: z
    .object({
      cpuMillis: z.number().optional(),
      memoryMb: z.number().optional(),
      storageMb: z.number().optional(),
      gpu: z.boolean().optional(),
    })
    .default({}),
  capabilities: z.array(z.string()).default([]),
  isolation: z.enum(["none", "process", "sandbox"]).optional(),
});

/**
 * The machines Work knows (ADR 0347), in Postgres: one row per name from
 * the moment its intent is recorded until its platform confirmed it gone.
 * Nothing about a machine lives in a replica's memory.
 */
export class MachineStore {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      nodes: WorkerNodesService;
      tenantId: string;
      authorityId: string;
      /**
       * Derives the enrollment code of a machine the hook makes, so every
       * replica repeats its create with one code and none is stored.
       */
      enrollmentSecret: string;
      /** Minutes unseen that make a machine lost when its plan gives none. */
      lostMinutes?: number;
    },
  ) {}

  get defaultLostMinutes(): number {
    return this.deps.lostMinutes ?? DEFAULT_LOST_AFTER_MINUTES;
  }

  /** A machine's row, if Work knows it. */
  async row(args: {
    name: string;
    transaction?: Transaction<DB>;
  }): Promise<MachineRow | undefined> {
    return (args.transaction ?? this.deps.db)
      .selectFrom("work_machines")
      .selectAll()
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .executeTakeFirst();
  }

  /**
   * The enrollment code of a machine the hook makes: derived from the
   * server's secret, its name and a nonce, so it is the same wherever it
   * is asked for and only its hash is stored.
   */
  private code(args: { name: string; nonce: string }): string {
    const mac = createHmac("sha256", this.deps.enrollmentSecret)
      .update(
        `work-machine-enrollment\0${this.deps.tenantId}\0${args.name}\0${args.nonce}`,
      )
      .digest("base64url");
    return `wke_${mac.slice(0, 32)}`;
  }

  /**
   * Record the intent to make a machine (ADR 0347): its row and a new
   * enrollment, under the name's lock, so replicas asking at once record
   * one. False when the name is known already.
   */
  async intend(args: { machine: PlannedMachine }): Promise<boolean> {
    const { machine } = args;
    return this.deps.db.transaction().execute(async (trx) => {
      await this.lockName({ name: machine.name, transaction: trx });
      if (await this.row({ name: machine.name, transaction: trx }))
        return false;
      const enrolled = await trx
        .selectFrom("work_workers")
        .select("node_id")
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", machine.name)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (enrolled) return false;
      const nonce = randomBytes(16).toString("hex");
      const key = hash(this.code({ name: machine.name, nonce }));
      await trx
        .insertInto("work_machines")
        .values({
          tenant_id: this.deps.tenantId,
          name: machine.name,
          managed: true,
          enrollment_nonce: nonce,
          idempotency_key: key,
          labels: JSON.stringify(machine.labels),
          serves: machine.for === null ? null : JSON.stringify(machine.for),
          trusted: machine.trusted,
          options: JSON.stringify(machine.options),
          lost_after_minutes: machine.lostAfterMinutes,
          reason: machine.reason,
          phase: "starting",
        })
        .execute();
      await this.insertEnrollment({
        name: machine.name,
        key,
        transaction: trx,
      });
      return true;
    });
  }

  /**
   * The enrollment a machine's create is asked with, the same on every
   * pass; its code keeps working while the machine is still starting.
   */
  async enrollment(args: {
    name: string;
  }): Promise<{ code: string; idempotencyKey: string } | null> {
    const row = await this.row(args);
    if (!row?.enrollment_nonce || !row.idempotency_key) return null;
    await this.deps.db
      .updateTable("work_worker_enrollments")
      .set({
        expires_at: sql`now() + make_interval(mins => ${ENROLLMENT_MINUTES})`,
      })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("code_hash", "=", row.idempotency_key)
      .where("used_at", "is", null)
      .execute();
    return {
      code: this.code({ name: args.name, nonce: row.enrollment_nonce }),
      idempotencyKey: row.idempotency_key,
    };
  }

  /** A new enrollment, and so a new idempotency key, after a refusal. */
  async reissue(args: { name: string }): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      await this.lockName({ name: args.name, transaction: trx });
      const row = await this.row({ name: args.name, transaction: trx });
      if (!row?.managed || row.enrollment_nonce || row.phase !== "starting")
        return;
      const nonce = randomBytes(16).toString("hex");
      const key = hash(this.code({ name: args.name, nonce }));
      await trx
        .updateTable("work_machines")
        .set({
          enrollment_nonce: nonce,
          idempotency_key: key,
          updated_at: sql`now()`,
        })
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", args.name)
        .execute();
      await this.insertEnrollment({ name: args.name, key, transaction: trx });
    });
  }

  private async insertEnrollment(args: {
    name: string;
    key: string;
    transaction: Transaction<DB>;
  }): Promise<void> {
    await args.transaction
      .deleteFrom("work_worker_enrollments")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("used_at", "is", null)
      .execute();
    await args.transaction
      .insertInto("work_worker_enrollments")
      .values({
        code_hash: args.key,
        tenant_id: this.deps.tenantId,
        name: args.name,
        expires_at: sql<Date>`now() + make_interval(mins => ${ENROLLMENT_MINUTES})`,
      })
      .execute();
  }

  /** One issuer or enroller per name at a time, across replicas, until commit. */
  async lockName(args: {
    name: string;
    transaction: Transaction<DB>;
  }): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`work-worker-name:${this.deps.tenantId}:${args.name}`}))`.execute(
      args.transaction,
    );
  }

  async created(args: { name: string; ref: string }): Promise<void> {
    await this.update(args.name, {
      ref: args.ref,
      refused_count: 0,
      refused_at: null,
    });
  }

  /**
   * The platform made nothing: the code is withdrawn, and a later pass
   * asks again with a new one. A machine that enrolled anyway keeps its
   * code; only the failure is recorded.
   */
  async refused(args: { name: string; reason: string }): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      await this.lockName({ name: args.name, transaction: trx });
      const row = await this.row({ name: args.name, transaction: trx });
      if (!row) return;
      const failure = {
        last_error: `Its platform refused: ${args.reason}`.slice(0, 4_000),
        last_error_verb: "create",
        last_error_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      };
      const withdrawn = row.idempotency_key
        ? await trx
            .deleteFrom("work_worker_enrollments")
            .where("tenant_id", "=", this.deps.tenantId)
            .where("code_hash", "=", row.idempotency_key)
            .where("used_at", "is", null)
            .returning("code_hash")
            .executeTakeFirst()
        : undefined;
      await trx
        .updateTable("work_machines")
        .set(
          withdrawn
            ? {
                ...failure,
                enrollment_nonce: null,
                idempotency_key: null,
                refused_count: sql<number>`refused_count + 1`,
                refused_at: sql<Date>`now()`,
              }
            : failure,
        )
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", args.name)
        .execute();
    });
  }

  async configure(args: {
    name: string;
    labels: Readonly<Record<string, string>>;
    trusted: boolean;
    reason: string | null;
    lostAfterMinutes: number | null;
  }): Promise<void> {
    await this.updatePlacement(args.name, {
      labels: JSON.stringify(args.labels),
      trusted: args.trusted,
      reason: args.reason,
      lost_after_minutes: args.lostAfterMinutes,
    });
  }

  /** Whom a machine is for from now on; ends a reset no longer wanted. */
  async setFor(args: {
    name: string;
    for: readonly MachinePrincipal[] | null;
  }): Promise<void> {
    await this.updatePlacement(args.name, {
      serves: principalsJson(args.for),
      reset_pending: false,
      reset_serves: null,
    });
  }

  async beginReset(args: {
    name: string;
    for: readonly MachinePrincipal[] | null;
  }): Promise<void> {
    await this.updatePlacement(args.name, {
      reset_pending: true,
      reset_serves: principalsJson(args.for),
    });
  }

  /** A reset machine is for whom it was being reset for. */
  async finishReset(args: { name: string }): Promise<void> {
    await this.updatePlacement(args.name, {
      serves: sql`CASE WHEN reset_pending THEN reset_serves ELSE serves END`,
      reset_pending: false,
      reset_serves: null,
    });
  }

  async setDropped(args: { name: string; dropped: boolean }): Promise<void> {
    await this.updatePlacement(args.name, {
      dropped_at: args.dropped ? sql<Date>`coalesce(dropped_at, now())` : null,
    });
  }

  async openPlacement({ name }: { name: string }): Promise<void> {
    await this.updatePlacement(name, {}, { onlyWhenUnopened: true });
  }

  /** Move a machine to a phase, in the caller's transaction when given. */
  async setPhase(args: {
    name: string;
    phase: MachinePhase;
    from?: readonly MachinePhase[];
    lost?: boolean;
    at?: string;
    transaction?: Transaction<DB>;
  }): Promise<boolean> {
    const moved = await (args.transaction ?? this.deps.db)
      .updateTable("work_machines")
      .set({
        phase: args.phase,
        phase_since: args.at === undefined ? sql`now()` : new Date(args.at),
        verb_done_at: null,
        updated_at: sql`now()`,
        ...(args.phase === "destroying"
          ? {
              destroy_requested_at: sql<Date>`coalesce(destroy_requested_at, now())`,
            }
          : {}),
        ...(args.lost ? { lost_at: sql<Date>`coalesce(lost_at, now())` } : {}),
        ...(args.phase === "running" ? { lost_at: null } : {}),
      })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("phase", "!=", args.phase)
      .$if(args.from !== undefined, (query) =>
        query.where("phase", "in", [...(args.from ?? [])]),
      )
      .returning("name")
      .executeTakeFirst();
    return Boolean(moved);
  }

  async startAsked(args: { name: string }): Promise<void> {
    await this.deps.db
      .updateTable("work_machines")
      .set({ verb_done_at: sql`now()`, updated_at: sql`now()` })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("phase", "=", "resuming")
      .execute();
  }

  /** Its platform confirmed it gone: Work knows it no more. */
  async forget(args: {
    name: string;
    transaction?: Transaction<DB>;
  }): Promise<void> {
    const db = args.transaction ?? this.deps.db;
    await db
      .deleteFrom("work_machines")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .execute();
    await db
      .deleteFrom("work_worker_enrollments")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("used_at", "is", null)
      .execute();
  }

  async note(args: { name: string; notice: string | null }): Promise<void> {
    await this.update(args.name, { notice: args.notice });
  }

  async failed(args: {
    name: string;
    verb: MachineVerb;
    message: string;
  }): Promise<void> {
    await this.update(args.name, {
      last_error: args.message.slice(0, 4_000),
      last_error_verb: args.verb,
      last_error_at: sql<Date>`now()`,
    });
  }

  async succeeded(args: { name: string; verb: MachineVerb }): Promise<void> {
    await this.deps.db
      .updateTable("work_machines")
      .set({ last_error: null, last_error_verb: null, last_error_at: null })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("last_error_verb", "=", args.verb)
      .execute();
  }

  /** What the latest plan said, for the machines listing on every replica. */
  async planned(args: { error: string | null }): Promise<void> {
    const values = args.error
      ? { error: args.error.slice(0, 4_000), error_at: sql<Date>`now()` }
      : { planned_at: sql<Date>`now()`, error: null, error_at: null };
    await this.deps.db
      .insertInto("work_machine_plans")
      .values({ tenant_id: this.deps.tenantId, ...values })
      .onConflict((conflict) =>
        conflict.column("tenant_id").doUpdateSet(values),
      )
      .execute();
  }

  async plan(): Promise<{
    plannedAt: string | null;
    error: { message: string; at: string } | null;
  }> {
    const row = await this.deps.db
      .selectFrom("work_machine_plans")
      .selectAll()
      .where("tenant_id", "=", this.deps.tenantId)
      .executeTakeFirst();
    return {
      plannedAt: row?.planned_at?.toISOString() ?? null,
      error:
        row?.error && row.error_at
          ? { message: row.error, at: row.error_at.toISOString() }
          : null,
    };
  }

  /** Fence placement decisions under the same node lock as an Allocation. */
  private async updatePlacement(
    name: string,
    values: UpdateObject<DB, "work_machines">,
    options: { onlyWhenUnopened?: boolean } = {},
  ): Promise<void> {
    const { db, tenantId } = this.deps;
    const nodeId = `${WORKER_NODE_PREFIX}${name}`;
    await db.transaction().execute(async (trx) => {
      const node = await trx
        .selectFrom("worker_nodes")
        .select(["id", "admission_revision"])
        .where("id", "=", nodeId)
        .where("tenant_id", "=", tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (options.onlyWhenUnopened && (!node || node.admission_revision))
        return;
      const updated = await trx
        .updateTable("work_machines")
        .set({ ...values, updated_at: sql`now()` })
        .where("tenant_id", "=", tenantId)
        .where("name", "=", name)
        .returning(["reset_pending", "dropped_at", "phase"])
        .executeTakeFirst();
      if (node && updated)
        await trx
          .updateTable("worker_nodes")
          .set({
            admission_revision:
              updated.reset_pending ||
              updated.dropped_at ||
              updated.phase !== "running"
                ? null
                : randomUUID(),
          })
          .where("id", "=", node.id)
          .execute();
    });
  }

  private async update(
    name: string,
    values: UpdateObject<DB, "work_machines">,
  ): Promise<void> {
    await this.deps.db
      .updateTable("work_machines")
      .set({ ...values, updated_at: sql`now()` })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", name)
      .execute();
  }

  /** One machine's placement, as its worker's connection is checked against. */
  async placementOf(args: { name: string }): Promise<WorkerPlacement> {
    const row = await this.row(args);
    if (!row) throw new Error(`Work knows no machine named '${args.name}'`);
    return storedPlacement(row);
  }

  /**
   * Placement of every machine, by node, for the scheduler. A machine the
   * plan dropped, one stopping, stopped or resuming, and one waiting for
   * its reset take no new work; the Allocations one already holds keep
   * reaching it.
   */
  async placements(): Promise<Map<string, ScheduledPlacement>> {
    const rows = await this.deps.db
      .selectFrom("work_machines as machine")
      .innerJoin("worker_nodes as node", (join) =>
        join
          .onRef("node.tenant_id", "=", "machine.tenant_id")
          .on(
            "node.id",
            "=",
            sql<string>`${WORKER_NODE_PREFIX} || machine.name`,
          ),
      )
      .select([
        "machine.name",
        "machine.labels",
        "machine.serves",
        "machine.trusted",
        "machine.phase",
        "machine.dropped_at",
        "machine.reset_pending",
        "node.admission_revision",
      ])
      .where("machine.tenant_id", "=", this.deps.tenantId)
      .execute();
    return new Map(
      rows.map((row) => [
        `${WORKER_NODE_PREFIX}${row.name}`,
        {
          ...storedPlacement(row),
          admissionRevision: row.admission_revision,
          accepting:
            row.phase === "running" &&
            row.admission_revision !== null &&
            row.dropped_at === null &&
            !row.reset_pending,
        },
      ]),
    );
  }

  /**
   * Every machine with its facts (ADR 0347): what Work stores, its
   * worker's lease and report, and what it holds, read by the database's
   * clock so every replica and listing agree.
   */
  async records(): Promise<MachineRecord[]> {
    const { db, tenantId } = this.deps;
    const [rows, workers, nodes, holdings, loads, clock] = await Promise.all([
      db
        .selectFrom("work_machines")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .orderBy("name")
        .execute(),
      db
        .selectFrom("work_workers")
        .select(["name", "enrolled_at", "last_seen_at", "revoked_at"])
        .where("tenant_id", "=", tenantId)
        .execute(),
      this.deps.nodes.list({ tenantId, authorityId: this.deps.authorityId }),
      db
        .selectFrom("execution_allocations as allocation")
        .leftJoin("agent_sessions as session", (join) =>
          join
            .onRef("session.id", "=", "allocation.root_workload_id")
            .on("allocation.workload_kind", "=", "agent"),
        )
        .select([
          "allocation.worker_node_id",
          "allocation.project_id",
          "session.external_user_id",
          "session.chat_key",
        ])
        .where("allocation.tenant_id", "=", tenantId)
        .where("allocation.status", "=", "active")
        .where("allocation.worker_node_id", "like", `${WORKER_NODE_PREFIX}%`)
        .execute(),
      db
        .selectFrom("execution_allocations")
        .select([
          "worker_node_id",
          sql<string>`count(*) FILTER (WHERE capacity_released_at IS NULL)`.as(
            "holding",
          ),
          sql<Date | null>`max(capacity_released_at)`.as("last_released"),
        ])
        .where("tenant_id", "=", tenantId)
        .where("worker_node_id", "like", `${WORKER_NODE_PREFIX}%`)
        .groupBy("worker_node_id")
        .execute(),
      sql<{ now: Date }>`SELECT now() AS now`.execute(db),
    ]);
    const now = clock.rows[0]?.now ?? new Date();
    const workerOf = new Map(workers.map((worker) => [worker.name, worker]));
    const nodeOf = new Map(nodes.map((node) => [node.id, node]));
    const loadOf = new Map(loads.map((load) => [load.worker_node_id, load]));
    return rows.map((row) => {
      const nodeId = `${WORKER_NODE_PREFIX}${row.name}`;
      const worker = workerOf.get(row.name);
      const node = nodeOf.get(nodeId);
      const load = loadOf.get(nodeId);
      const held = holdings.filter((entry) => entry.worker_node_id === nodeId);
      const phase = phaseOf(row.phase);
      const seen =
        worker?.last_seen_at ?? worker?.enrolled_at ?? row.phase_since;
      const lostAfterMs = lostAfterMsOf({
        lostAfterMinutes: row.lost_after_minutes,
        defaultMinutes: this.defaultLostMinutes,
      });
      const state = machineStateOf({
        phase,
        dropped: row.dropped_at !== null || row.reset_pending,
        disabled: row.disabled_at !== null,
        live: Boolean(node?.available) && !worker?.revoked_at,
        unseenForMs: now.getTime() - seen.getTime(),
        lostAfterMs,
        startAskedForMs: row.verb_done_at
          ? now.getTime() - row.verb_done_at.getTime()
          : null,
      });
      const placement = storedPlacement(row);
      const everConnected = phase !== "starting";
      const facts: MachineFacts = {
        name: row.name,
        ref: row.ref,
        managed: row.managed,
        state,
        since: sinceOf({ row, state, seen }).toISOString(),
        labels: placement.labels,
        for: placement.for,
        trusted: placement.trusted,
        options: OptionsSchema.parse(row.options),
        reason: row.reason,
        holding: {
          workspaces: held.length,
          for: normalizePrincipals(
            held.map((entry) =>
              entry.external_user_id &&
              !isProjectPrincipal(entry.external_user_id)
                ? { user: entry.external_user_id }
                : entry.chat_key
                  ? { project: entry.project_id, key: entry.chat_key }
                  : { project: entry.project_id },
            ),
          ),
        },
        idleSince:
          (state === "serving" || state === "draining") &&
          Number(load?.holding ?? 0) === 0
            ? latest([
                row.phase_since,
                load?.last_released ?? null,
                worker?.enrolled_at ?? null,
              ]).toISOString()
            : null,
        lastSeenAt: worker?.last_seen_at?.toISOString() ?? null,
        capacity: everConnected && node?.capacity ? node.capacity : null,
        usage: everConnected && node ? node.usage : null,
        disk: everConnected && node?.disk ? diskFacts(node) : null,
        isolation: everConnected ? isolationOf(node) : null,
        signedIn: signedInOf(node),
        notice: row.notice,
        lastError:
          row.last_error && row.last_error_at
            ? {
                verb:
                  VERBS.find((verb) => verb === row.last_error_verb) ??
                  "create",
                message: row.last_error,
                at: row.last_error_at.toISOString(),
              }
            : null,
      };
      return {
        facts,
        phase,
        phaseSince: row.phase_since.toISOString(),
        idempotencyKey: row.idempotency_key,
        dropped: row.dropped_at !== null,
        refused:
          row.refused_count > 0 && row.refused_at
            ? { count: row.refused_count, at: row.refused_at.toISOString() }
            : null,
        reset: row.reset_pending
          ? { for: storedPlacement({ ...row, serves: row.reset_serves }).for }
          : null,
        startAsked: row.verb_done_at !== null,
        destroyRequestedAt: row.destroy_requested_at?.toISOString() ?? null,
        lostAfterMinutes: row.lost_after_minutes,
        revoked: Boolean(worker?.revoked_at),
      };
    });
  }

  /** The database's clock, which every time in the facts is read by. */
  async now(): Promise<string> {
    const clock = await sql<{ now: Date }>`SELECT now() AS now`.execute(
      this.deps.db,
    );
    return (clock.rows[0]?.now ?? new Date()).toISOString();
  }

  /**
   * Work that has no machine yet (ADR 0258): waits tried recently with
   * something still queued, oldest first. A disabled member's work is no
   * reason for a machine.
   */
  async work(): Promise<WaitingWork[]> {
    const rows = await this.deps.db
      .selectFrom("placement_waits")
      .leftJoin(
        "work_accounts",
        "work_accounts.user_id",
        "placement_waits.owner",
      )
      .select([
        "placement_waits.root_workload_id",
        "placement_waits.workload_kind",
        "placement_waits.project_id",
        "placement_waits.owner",
        "placement_waits.chat_key",
        "placement_waits.environment_name",
        "placement_waits.pool",
        "placement_waits.requirements",
        "placement_waits.reason",
        "placement_waits.waiting_since",
        "work_accounts.disabled_at",
        sql<boolean>`EXISTS (SELECT 1 FROM environment_cache_fills WHERE id = placement_waits.root_workload_id)`.as(
          "fill",
        ),
      ])
      .where("placement_waits.tenant_id", "=", this.deps.tenantId)
      .where("placement_waits.last_tried_at", ">", waitFresh())
      .where(queuedPlacementWait(this.deps.db))
      .orderBy("placement_waits.waiting_since")
      .execute();
    const work: WaitingWork[] = [];
    for (const row of rows) {
      const pool = WaitPool.safeParse(row.pool);
      const requirements = WaitRequirements.safeParse(row.requirements);
      if (!pool.success || !requirements.success) continue;
      if (row.owner !== null && row.disabled_at !== null) continue;
      work.push({
        id: row.root_workload_id,
        kind: row.fill
          ? "fill"
          : row.workload_kind === "agent"
            ? "chat"
            : "run",
        project: row.project_id,
        user: row.owner,
        key: row.chat_key,
        environment: row.environment_name,
        pool: pool.data,
        requirements: requirements.data,
        reason: row.reason === "unavailable" ? "unavailable" : "capacity",
        waitingSince: row.waiting_since.toISOString(),
      });
    }
    return work;
  }

  /**
   * What a pass would act on, in one cheap statement, so a replica looks
   * every few seconds and plans only when it changed: the work waiting,
   * what machines hold, and where each machine stands.
   */
  async signature(): Promise<string> {
    const row = await this.deps.db
      .selectNoFrom((eb) => [
        eb
          .selectFrom("placement_waits")
          .select(
            sql<string>`count(*)::text || '/' || coalesce(max(waiting_since)::text, '')`.as(
              "waits",
            ),
          )
          .where("tenant_id", "=", this.deps.tenantId)
          .where("last_tried_at", ">", waitFresh())
          .where(queuedPlacementWait(this.deps.db))
          .as("waits"),
        eb
          .selectFrom("execution_allocations")
          .select(
            sql<string>`count(*) FILTER (WHERE capacity_released_at IS NULL)::text || '/' || coalesce(max(capacity_released_at)::text, '')`.as(
              "work",
            ),
          )
          .where("tenant_id", "=", this.deps.tenantId)
          .where("worker_node_id", "like", `${WORKER_NODE_PREFIX}%`)
          .as("work"),
        eb
          .selectFrom("work_machines")
          .select(
            sql<string>`coalesce(string_agg(name || ':' || phase || ':' || (dropped_at IS NOT NULL)::text || ':' || (disabled_at IS NOT NULL)::text, ',' ORDER BY name), '')`.as(
              "machines",
            ),
          )
          .where("tenant_id", "=", this.deps.tenantId)
          .as("machines"),
        eb
          .selectFrom("work_accounts")
          .select(
            sql<string>`count(*)::text || '/' || coalesce(max(updated_at)::text, '')`.as(
              "accounts",
            ),
          )
          .as("accounts"),
        eb
          .selectFrom("memberships")
          .select(
            sql<string>`count(*)::text || '/' || coalesce(max(updated_at)::text, '')`.as(
              "roles",
            ),
          )
          .as("roles"),
      ])
      .executeTakeFirst();
    const reach = [...(await this.reach())]
      .map(([name, entry]) => `${name}:${entry.state}`)
      .join(",");
    return [
      row?.waits ?? "",
      row?.work ?? "",
      row?.machines ?? "",
      row?.accounts ?? "",
      row?.roles ?? "",
      reach,
    ].join("|");
  }

  /**
   * Every machine's state by name, from its row and its worker's lease
   * alone: what maintenance and the pass trigger read every few seconds.
   */
  async reach(): Promise<
    Map<
      string,
      {
        nodeId: string;
        state: MachineState;
        managed: boolean;
        lostNoted: boolean;
      }
    >
  > {
    const fallback = this.defaultLostMinutes;
    const rows = await this.deps.db
      .selectFrom("work_machines as machine")
      .leftJoin("work_workers as worker", (join) =>
        join
          .onRef("worker.tenant_id", "=", "machine.tenant_id")
          .onRef("worker.name", "=", "machine.name"),
      )
      .leftJoin("worker_nodes as node", "node.id", "worker.node_id")
      .select([
        "machine.name",
        "machine.managed",
        "machine.phase",
        "machine.dropped_at",
        "machine.disabled_at",
        "machine.lost_at",
        "machine.lost_after_minutes",
        sql<boolean>`coalesce(node.enabled AND node.lease_expires_at > now() AND worker.revoked_at IS NULL, false)`.as(
          "live",
        ),
        sql<number>`(extract(epoch from (now() - coalesce(worker.last_seen_at, worker.enrolled_at, machine.phase_since))) * 1000)::float8`.as(
          "unseen_for_ms",
        ),
        sql<
          number | null
        >`(extract(epoch from (now() - machine.verb_done_at)) * 1000)::float8`.as(
          "start_asked_for_ms",
        ),
      ])
      .where("machine.tenant_id", "=", this.deps.tenantId)
      .execute();
    return new Map(
      rows.map((row) => [
        row.name,
        {
          nodeId: `${WORKER_NODE_PREFIX}${row.name}`,
          managed: row.managed,
          lostNoted: row.lost_at !== null,
          state: machineStateOf({
            phase: phaseOf(row.phase),
            dropped: row.dropped_at !== null,
            disabled: row.disabled_at !== null,
            live: row.live,
            unseenForMs: Number(row.unseen_for_ms),
            lostAfterMs: lostAfterMsOf({
              lostAfterMinutes: row.lost_after_minutes,
              defaultMinutes: fallback,
            }),
            startAskedForMs:
              row.start_asked_for_ms === null
                ? null
                : Number(row.start_asked_for_ms),
          }),
        },
      ]),
    );
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function principalsJson(
  principals: readonly MachinePrincipal[] | null,
): string | null {
  return principals === null
    ? null
    : JSON.stringify(normalizePrincipals(principals));
}

function latest(dates: readonly (Date | null)[]): Date {
  return dates.reduce<Date>(
    (best, date) => (date && date > best ? date : best),
    new Date(0),
  );
}

/** Since when a machine is in its state. */
function sinceOf(args: {
  row: MachineRow;
  state: MachineState;
  seen: Date;
}): Date {
  const { row, state } = args;
  if (state === "unreachable" || state === "lost")
    return row.phase === "resuming"
      ? (row.verb_done_at ?? args.seen)
      : args.seen;
  if (state === "disabled") return row.disabled_at ?? row.phase_since;
  if (state === "draining") return row.dropped_at ?? row.phase_since;
  return row.phase_since;
}

function diskFacts(node: WorkerNode): MachineFacts["disk"] {
  if (!node.disk) return null;
  return {
    totalBytes: node.disk.totalBytes,
    freeBytes: node.disk.freeBytes,
    floorBytes: node.disk.floorBytes,
    low: node.diskLowSince !== undefined,
  };
}

function isolationOf(
  node: WorkerNode | undefined,
): "process" | "sandbox" | null {
  const isolation = node?.descriptor.isolation;
  return isolation === "process" || isolation === "sandbox" ? isolation : null;
}

/** Members signed in to a harness on a machine, from what it reports. */
function signedInOf(node: WorkerNode | undefined): string[] {
  const members = new Set<string>();
  for (const capability of node?.descriptor.capabilities ?? []) {
    const signIn = parseSignInCapability(capability);
    if (signIn) members.add(signIn.member);
  }
  return [...members].sort();
}

/** Since when a wait for a machine still counts as demand (ADR 0258). */
function waitFresh() {
  return sql<Date>`now() - make_interval(secs => ${PLACEMENT_WAIT_FRESH_SECONDS})`;
}

/**
 * Chats and runs reuse placement demand, and a cache fill that waits for a
 * machine with room for its size (ADR 0336); waiting journals alone are no
 * demand.
 */
function queuedPlacementWait(db: Kysely<DB>) {
  const turns = db
    .selectFrom("agent_turns")
    .select("id")
    .where("session_id", "=", sql<string>`placement_waits.root_workload_id`)
    .where("status", "=", "queued");
  const jobs = db
    .selectFrom("workflow_runs as root")
    .innerJoin(
      "workflow_runs as run",
      "run.allocation_id",
      "root.allocation_id",
    )
    .innerJoin("execution_jobs as job", "job.workflow_run_id", "run.id")
    .select("job.id")
    .where("root.id", "=", sql<string>`placement_waits.root_workload_id`)
    .where("root.status", "in", ["pending", "running", "waiting"])
    .where("run.status", "in", ["pending", "running", "waiting"])
    .where("job.status", "=", "pending")
    .where("job.kind", "!=", "durable_pause_timeout")
    .where("job.available_at", "<=", sql<Date>`now()`);
  const fills = db
    .selectFrom("environment_cache_fills")
    .select("id")
    .where("id", "=", sql<string>`placement_waits.root_workload_id`)
    .where("status", "=", "queued");
  return sql<boolean>`((placement_waits.workload_kind = 'agent' AND EXISTS (${turns})) OR
    (placement_waits.workload_kind = 'workflow' AND EXISTS (${jobs})) OR
    EXISTS (${fills}))`;
}
