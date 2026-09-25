import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  cleanupWorkerAllocations,
  RemoteWorkerJobsService,
  type WorkerCapacity,
  type WorkerNodeLease,
  type WorkerNodesService,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type { EnvironmentBinding, SandboxProvider } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
  servesOnePerson,
  storedPlacement,
  type WorkerPlacement,
  WorkerPlacementSchema,
} from "./placement.js";

export const WORKER_NODE_PREFIX = "worker.";

const WorkerName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use lowercase letters, digits, dashes");

/** What a worker reports about itself when it connects. */
export const WorkerOfferSchema = z.strictObject({
  isolation: z.enum(["process", "sandbox"]),
  resourceLimits: z
    .array(z.enum(["cpuMillis", "memoryMb", "storageMb", "gpu"]))
    .default([]),
  workspaceRoot: z.string().startsWith("/"),
  capacity: z.strictObject({
    workspaces: z.number().int().positive().max(1_000),
    cpuMillis: z.number().int().positive().optional(),
    memoryMb: z.number().int().positive().optional(),
  }),
  defaults: z
    .strictObject({
      cpuMillis: z.number().int().positive().optional(),
      memoryMb: z.number().int().positive().optional(),
    })
    .default({}),
  version: z.string().max(100).optional(),
});
export type WorkerOffer = z.infer<typeof WorkerOfferSchema>;

interface HeldWorker {
  lease: WorkerNodeLease;
  provider: SandboxProvider;
}

export class WorkerIsolationError extends Error {
  constructor(name: string) {
    super(
      `Worker '${name}' serves more than one person, so it must isolate agents with microsandbox (WORK_SANDBOX=microsandbox), or be marked trusted by the operator`,
    );
    this.name = "WorkerIsolationError";
  }
}

export class WorkerConnectConflictError extends Error {
  constructor() {
    super(
      "Another control-plane instance still holds this worker's lease; retry after it expires",
    );
    this.name = "WorkerConnectConflictError";
  }
}

/**
 * Enrolled remote workers (ADR 0164). A worker proves itself with a machine
 * credential issued once at enrollment; it never receives database, vault,
 * or sign-in secrets. The control-plane instance a worker connects to holds
 * the worker node's lease, runs its agents' controller loops, and forwards
 * sandbox operations to it. Leases lapse when the worker stops polling.
 */
export class WorkWorkerRegistry {
  private readonly held = new Map<string, HeldWorker>();
  private readonly jobs: RemoteWorkerJobsService;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      nodes: WorkerNodesService;
      tenantId: string;
      authorityId: string;
      /** A worker unseen for this long loses its lease here. */
      livenessMs?: number;
      log?: (line: string) => void;
    },
  ) {
    this.jobs = new RemoteWorkerJobsService(deps.db);
  }

  get jobService(): RemoteWorkerJobsService {
    return this.jobs;
  }

  /** Operator: a one-time code a new worker exchanges for its credential. */
  async createEnrollment(args: {
    name: string;
    ttlMinutes?: number;
    placement?: z.input<typeof WorkerPlacementSchema>;
    /** Set by the machine reconciler for machines it provisions. */
    machine?: { rule: string; ref?: string };
  }): Promise<{ code: string; nodeId: string; expiresAt: Date }> {
    const name = WorkerName.parse(args.name);
    const placement = WorkerPlacementSchema.parse(args.placement ?? {});
    const existing = await this.deps.db
      .selectFrom("work_workers")
      .select("node_id")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", name)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (existing) {
      throw new Error(
        `A worker named '${name}' is already enrolled; revoke it first`,
      );
    }
    const code = `wke_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + (args.ttlMinutes ?? 30) * 60_000);
    await this.deps.db
      .insertInto("work_worker_enrollments")
      .values({
        code_hash: hash(code),
        tenant_id: this.deps.tenantId,
        name,
        labels: JSON.stringify(placement.labels),
        access: JSON.stringify(placement.access),
        trusted: placement.trusted,
        machine_rule: args.machine?.rule ?? null,
        machine_ref: args.machine?.ref ?? null,
        expires_at: expiresAt,
      })
      .execute();
    return { code, nodeId: `${WORKER_NODE_PREFIX}${name}`, expiresAt };
  }

  /** Worker: exchange a one-time code for a machine credential. */
  async enroll(args: {
    code: string;
  }): Promise<{ nodeId: string; name: string; credential: string }> {
    return this.deps.db.transaction().execute(async (trx) => {
      const enrollment = await trx
        .updateTable("work_worker_enrollments")
        .set({ used_at: sql`now()` })
        .where("code_hash", "=", hash(args.code))
        .where("tenant_id", "=", this.deps.tenantId)
        .where("used_at", "is", null)
        .where("expires_at", ">", sql<Date>`now()`)
        .returning([
          "name",
          "labels",
          "access",
          "trusted",
          "machine_rule",
          "machine_ref",
        ])
        .executeTakeFirst();
      if (!enrollment) {
        throw new Error("The enrollment code is invalid, used, or expired");
      }
      const nodeId = `${WORKER_NODE_PREFIX}${enrollment.name}`;
      const secret = randomBytes(32).toString("base64url");
      await trx
        .deleteFrom("work_workers")
        .where("node_id", "=", nodeId)
        .where("revoked_at", "is not", null)
        .execute();
      // A re-enrolled name gets its (revoked, disabled) node back.
      await trx
        .updateTable("worker_nodes")
        .set({ enabled: true })
        .where("id", "=", nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .execute();
      await trx
        .insertInto("work_workers")
        .values({
          node_id: nodeId,
          tenant_id: this.deps.tenantId,
          name: enrollment.name,
          credential_hash: hash(secret),
          labels: JSON.stringify(enrollment.labels),
          access: JSON.stringify(enrollment.access),
          trusted: enrollment.trusted,
          machine_rule: enrollment.machine_rule,
          machine_ref: enrollment.machine_ref,
        })
        .execute();
      return {
        nodeId,
        name: enrollment.name,
        credential: `${nodeId}:${secret}`,
      };
    });
  }

  /** The enrolled worker a request's credential proves, if any. */
  async authenticate(
    authorization: string | undefined,
  ): Promise<{ nodeId: string; name: string } | undefined> {
    const match = authorization?.match(/^Worker\s+(worker\.[a-z0-9-]+):(\S+)$/);
    if (!match?.[1] || !match[2]) return undefined;
    const row = await this.deps.db
      .selectFrom("work_workers")
      .select(["node_id", "name", "credential_hash"])
      .where("node_id", "=", match[1])
      .where("tenant_id", "=", this.deps.tenantId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!row) return undefined;
    const expected = Buffer.from(row.credential_hash, "hex");
    const actual = Buffer.from(hash(match[2]), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return undefined;
    return { nodeId: row.node_id, name: row.name };
  }

  /** Worker: take this instance's hold on the worker node's lease. */
  async connect(args: {
    nodeId: string;
    name: string;
    offer: WorkerOffer;
  }): Promise<string> {
    const policy = await this.placement(args.nodeId);
    if (
      args.offer.isolation === "process" &&
      !servesOnePerson(policy.access) &&
      !policy.trusted
    ) {
      throw new WorkerIsolationError(args.name);
    }
    const previous = this.held.get(args.nodeId);
    if (previous) {
      this.held.delete(args.nodeId);
      await this.deps.nodes.release({ lease: previous.lease });
    }
    const descriptor: EnvironmentBinding = {
      id: args.nodeId,
      label: args.name,
      description: `Run on worker ${args.name}`,
      trust: "managed",
      isolation: args.offer.isolation,
      // Workflow runs carry project secrets; they stay on the control plane.
      workloads: ["agent"],
      agentTopologies: ["controller"],
      capabilities: ["network.egress"],
      resources: {
        ...(args.offer.capacity.cpuMillis
          ? { cpuMillis: args.offer.capacity.cpuMillis }
          : {}),
        ...(args.offer.capacity.memoryMb
          ? { memoryMb: args.offer.capacity.memoryMb }
          : {}),
      },
      resourceLimits: args.offer.resourceLimits,
      labels: { ...policy.labels, node: args.nodeId, plane: "worker" },
    };
    let lease: WorkerNodeLease;
    try {
      lease = await this.deps.nodes.register({
        tenantId: this.deps.tenantId,
        authorityId: this.deps.authorityId,
        descriptor,
        capacity: args.offer.capacity satisfies WorkerCapacity,
        defaults: args.offer.defaults,
      });
    } catch (error) {
      if (error instanceof Error && /already running/.test(error.message))
        throw new WorkerConnectConflictError();
      throw error;
    }
    this.held.set(args.nodeId, {
      lease,
      provider: this.providerFor(args.nodeId, args.offer.workspaceRoot),
    });
    await this.touch(args.nodeId);
    this.deps.log?.(`Worker ${args.name} connected`);
    return lease.token;
  }

  private readonly providers = new Map<string, SandboxProvider>();

  /**
   * One provider per worker node for this instance's lifetime: it fences
   * each operation with whatever lease this instance holds at that moment,
   * so sessions survive the worker reconnecting.
   */
  private providerFor(nodeId: string, workspaceRoot: string): SandboxProvider {
    const existing = this.providers.get(nodeId);
    if (existing) return existing;
    const provider = this.jobs.sandboxProvider({
      nodeId,
      leaseToken: () => this.held.get(nodeId)?.lease.token,
      workspaceRoot,
    });
    this.providers.set(nodeId, provider);
    return provider;
  }

  /** One enrolled worker's placement policy. */
  async placement(nodeId: string): Promise<WorkerPlacement> {
    const row = await this.deps.db
      .selectFrom("work_workers")
      .select(["labels", "access", "trusted"])
      .where("node_id", "=", nodeId)
      .where("tenant_id", "=", this.deps.tenantId)
      .executeTakeFirstOrThrow();
    return storedPlacement(row);
  }

  /** Placement policy of every enrolled worker, for the scheduler. */
  async placements(): Promise<Map<string, WorkerPlacement>> {
    const rows = await this.deps.db
      .selectFrom("work_workers")
      .select(["node_id", "labels", "access", "trusted"])
      .where("tenant_id", "=", this.deps.tenantId)
      .where("revoked_at", "is", null)
      .execute();
    return new Map(rows.map((row) => [row.node_id, storedPlacement(row)]));
  }

  /** Operator: change whose work a worker takes and how it is labeled. */
  async setPlacement(args: {
    name: string;
    placement: Partial<z.input<typeof WorkerPlacementSchema>>;
  }): Promise<WorkerPlacement> {
    const nodeId = `${WORKER_NODE_PREFIX}${WorkerName.parse(args.name)}`;
    const current = await this.placement(nodeId);
    const next = WorkerPlacementSchema.parse({ ...current, ...args.placement });
    await this.deps.db
      .updateTable("work_workers")
      .set({
        labels: JSON.stringify(next.labels),
        access: JSON.stringify(next.access),
        trusted: next.trusted,
      })
      .where("node_id", "=", nodeId)
      .where("tenant_id", "=", this.deps.tenantId)
      .execute();
    return next;
  }

  /** Directory groups worker access names, for the directory mirror. */
  async accessGroups(): Promise<string[]> {
    const groups = new Set<string>();
    for (const placement of (await this.placements()).values()) {
      if (!("everyone" in placement.access))
        for (const group of placement.access.groups) groups.add(group);
    }
    return [...groups];
  }

  async touch(nodeId: string): Promise<void> {
    await this.deps.db
      .updateTable("work_workers")
      .set({ last_seen_at: sql`now()` })
      .where("node_id", "=", nodeId)
      .execute();
  }

  /** Leases this instance holds for connected workers. */
  heldLeases(): WorkerNodeLease[] {
    return [...this.held.values()].map((held) => held.lease);
  }

  /** The forwarding provider when this instance holds the node's lease. */
  heldProvider(
    nodeId: string,
  ): { provider: SandboxProvider; lease: WorkerNodeLease } | undefined {
    return this.held.get(nodeId);
  }

  /**
   * Renew leases of workers seen recently and release the rest, then
   * retire workspaces of their ended allocations through the worker. The
   * cleanup waits on the worker, so it runs on its own and never holds up
   * the next renewal: a slow workspace removal must not cost a live
   * session its worker.
   */
  async maintain(): Promise<void> {
    const livenessMs = this.deps.livenessMs ?? 30_000;
    for (const [nodeId, held] of this.held) {
      const worker = await this.deps.db
        .selectFrom("work_workers")
        .select(["last_seen_at", "revoked_at"])
        .where("node_id", "=", nodeId)
        .executeTakeFirst();
      const alive =
        !worker?.revoked_at &&
        worker?.last_seen_at &&
        Date.now() - worker.last_seen_at.getTime() < livenessMs;
      if (!alive || !(await this.deps.nodes.renew({ lease: held.lease }))) {
        // A reconnect during this pass holds a new lease; keep that one.
        if (this.held.get(nodeId) === held) this.held.delete(nodeId);
        await this.deps.nodes.release({ lease: held.lease });
        this.deps.log?.(`Worker ${nodeId} disconnected`);
      }
    }
    await this.jobs.sweep();
    this.cleaning ??= this.cleanup().finally(() => {
      this.cleaning = undefined;
    });
  }

  private cleaning: Promise<void> | undefined;

  private async cleanup(): Promise<void> {
    for (const [nodeId, held] of [...this.held]) {
      await cleanupWorkerAllocations({
        db: this.deps.db,
        workerNode: held.lease,
        provider: held.provider,
      }).catch((error) =>
        this.deps.log?.(
          `Workspace cleanup on ${nodeId} deferred: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /** Waits for a cleanup pass in progress (shutdown). */
  async settle(): Promise<void> {
    await this.cleaning;
  }

  /** Operator: end a worker's authority now. Its credential stops working. */
  async revoke(args: { name: string }): Promise<boolean> {
    const row = await this.deps.db
      .updateTable("work_workers")
      .set({ revoked_at: sql`now()` })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("revoked_at", "is", null)
      .returning("node_id")
      .executeTakeFirst();
    if (!row) return false;
    await this.deps.nodes.setEnabled({
      tenantId: this.deps.tenantId,
      authorityId: this.deps.authorityId,
      nodeId: row.node_id,
      enabled: false,
    });
    const held = this.held.get(row.node_id);
    if (held) {
      this.held.delete(row.node_id);
      await this.deps.nodes.release({ lease: held.lease });
    }
    return true;
  }

  /** The platform's id for the machine created with this enrollment code. */
  async recordMachineRef(args: { code: string; ref: string }): Promise<void> {
    const enrollment = await this.deps.db
      .updateTable("work_worker_enrollments")
      .set({ machine_ref: args.ref })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("code_hash", "=", hash(args.code))
      .returning(["name", "used_at"])
      .executeTakeFirst();
    // The machine may have enrolled before the platform answered.
    if (enrollment?.used_at)
      await this.deps.db
        .updateTable("work_workers")
        .set({ machine_ref: args.ref })
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", enrollment.name)
        .where("revoked_at", "is", null)
        .where("machine_ref", "is", null)
        .execute();
  }

  /**
   * Machines a reconciler provisioned, by state: enrolled, still pending
   * enrollment, expired before enrolling, or revoked but not yet destroyed.
   */
  async machines(): Promise<
    Array<{
      name: string;
      ref: string | null;
      rule: string;
      state: "enrolled" | "pending" | "expired" | "revoked";
      placement: WorkerPlacement;
    }>
  > {
    const [workers, enrollments] = await Promise.all([
      this.deps.db
        .selectFrom("work_workers")
        .select([
          "name",
          "machine_ref",
          "machine_rule",
          "revoked_at",
          "labels",
          "access",
          "trusted",
        ])
        .where("tenant_id", "=", this.deps.tenantId)
        .where("machine_rule", "is not", null)
        .where((eb) =>
          eb.or([
            eb("revoked_at", "is", null),
            eb("machine_ref", "is not", null),
          ]),
        )
        .execute(),
      this.deps.db
        .selectFrom("work_worker_enrollments")
        .select([
          "name",
          "machine_ref",
          "machine_rule",
          "labels",
          "access",
          "trusted",
          sql<boolean>`expires_at <= now()`.as("expired"),
        ])
        .where("tenant_id", "=", this.deps.tenantId)
        .where("machine_rule", "is not", null)
        .where("used_at", "is", null)
        .execute(),
    ]);
    return [
      ...workers.map((row) => ({
        name: row.name,
        ref: row.machine_ref,
        rule: row.machine_rule ?? "",
        state: row.revoked_at ? ("revoked" as const) : ("enrolled" as const),
        placement: storedPlacement(row),
      })),
      ...enrollments.map((row) => ({
        name: row.name,
        ref: row.machine_ref,
        rule: row.machine_rule ?? "",
        state: row.expired ? ("expired" as const) : ("pending" as const),
        placement: storedPlacement(row),
      })),
    ];
  }

  /** A provisioned machine was destroyed: stop tracking it. */
  async forgetMachine(args: {
    name: string;
    ref: string | null;
  }): Promise<void> {
    await this.deps.db
      .updateTable("work_workers")
      .set({ machine_ref: null })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("revoked_at", "is not", null)
      .execute();
    await this.cancelEnrollments({ name: args.name });
  }

  /** Invalidate every unused enrollment code for a name. */
  async cancelEnrollments(args: { name: string }): Promise<void> {
    await this.deps.db
      .deleteFrom("work_worker_enrollments")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", args.name)
      .where("used_at", "is", null)
      .execute();
  }

  async list(): Promise<
    Array<{
      name: string;
      nodeId: string;
      enrolledAt: string;
      lastSeenAt: string | null;
      revoked: boolean;
      placement: WorkerPlacement;
      machine: { rule: string; ref: string | null } | null;
    }>
  > {
    const rows = await this.deps.db
      .selectFrom("work_workers")
      .selectAll()
      .where("tenant_id", "=", this.deps.tenantId)
      .orderBy("name")
      .execute();
    return rows.map((row) => ({
      name: row.name,
      nodeId: row.node_id,
      enrolledAt: row.enrolled_at.toISOString(),
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      revoked: row.revoked_at !== null,
      placement: storedPlacement(row),
      machine: row.machine_rule
        ? { rule: row.machine_rule, ref: row.machine_ref }
        : null,
    }));
  }

  /** Release every lease this instance holds (shutdown). */
  async releaseAll(): Promise<void> {
    for (const held of this.held.values()) {
      await this.deps.nodes.release({ lease: held.lease }).catch(() => {});
    }
    this.held.clear();
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isWorkerNode(nodeId: string): boolean {
  return nodeId.startsWith(WORKER_NODE_PREFIX);
}
