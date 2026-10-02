import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  cleanupWorkerAllocations,
  nodeExecutor,
  REMOTE_EPOCH_PATTERN,
  RemoteEpochSupersededError,
  RemoteExecutorLeaseLostError,
  RemoteOperationQueue,
  type WorkerCapacity,
  WorkerNodeLeaseHeldError,
  type WorkerNodesService,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type { EnvironmentBinding } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
  servesOneOwner,
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
  /** The worker's provider runs background processes (ADR 0174). */
  processes: z.boolean().default(false),
  /**
   * What its sandboxes can be given (ADR 0176): images, image builds,
   * containers, an enforced egress policy.
   */
  capabilities: z
    .array(
      z.union([
        z.enum([
          "images",
          "images.build",
          "containers",
          "network.policy",
          // What the machine offers beside its provider (ADR 0184).
          "credentials.personal",
          "harness.claude-code",
          "harness.codex",
          // Its sandboxes mount members' own sign-ins (ADR 0197).
          "sign-ins",
        ]),
        // A member signed in to a harness on it: the fact, never the value.
        z.string().regex(/^sign-in:(claude-code|codex):\S{1,255}$/),
      ]),
    )
    .max(10_000)
    .default([]),
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

/**
 * What a worker sends to connect: the epoch its process chose at start
 * (ADR 0192), which every later call repeats as its session, and its offer.
 */
export const WorkerConnectSchema = z.strictObject({
  session: z.string().regex(REMOTE_EPOCH_PATTERN, "Use a UUIDv7 epoch"),
  offer: WorkerOfferSchema,
});

export class WorkerIsolationError extends Error {
  constructor(name: string) {
    super(
      `Worker '${name}' serves more than one person, so it must isolate agents with microsandbox (WORK_SANDBOX=microsandbox), or be marked trusted by the operator`,
    );
    this.name = "WorkerIsolationError";
  }
}

/** The operator disabled this worker's node; it may connect once enabled. */
export class WorkerDisabledError extends Error {
  constructor() {
    super("The operator disabled this worker; it connects once enabled again");
    this.name = "WorkerDisabledError";
  }
}

/**
 * A newer process of this worker connected under a new epoch (ADR 0192).
 * The old process must stop: connecting again would take the lease back.
 */
export class WorkerSupersededError extends RemoteExecutorLeaseLostError {
  constructor() {
    super();
    this.message =
      "A newer process of this worker connected; this one must stop";
    this.name = "WorkerSupersededError";
  }
}

/**
 * Enrolled remote workers (ADR 0164). A worker proves itself with a machine
 * credential issued once at enrollment; it never receives database, vault,
 * or sign-in secrets. The worker owns its node lease (ADR 0192): its token
 * is the epoch the worker process chose at start, and each of its calls to
 * any replica renews it. Any replica runs the worker's agents and forwards
 * their sandbox operations through the queue in Postgres. Nothing about a
 * worker lives in a replica's memory.
 */
export class WorkWorkerRegistry {
  private readonly queue: RemoteOperationQueue;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      nodes: WorkerNodesService;
      tenantId: string;
      authorityId: string;
      log?: (line: string) => void;
    },
  ) {
    this.queue = new RemoteOperationQueue(deps.db);
  }

  /**
   * The worker takes up to `max` operations, waiting up to 20 seconds. Any
   * replica serves it: the queue and the lease live in Postgres. The call
   * renews the worker's lease.
   */
  async poll(args: {
    nodeId: string;
    session: string;
    pollId: string;
    max: number;
    signal: AbortSignal;
  }) {
    await this.renewOrThrow(args);
    try {
      return await this.queue.poll({
        executor: nodeExecutor(args.nodeId),
        leaseToken: args.session,
        pollId: args.pollId,
        max: args.max,
        signal: args.signal,
        waitMs: 20_000,
        leaseHeld: async () =>
          (await this.deps.nodes.liveToken({ nodeId: args.nodeId })) ===
          args.session,
      });
    } catch (error) {
      if (error instanceof RemoteExecutorLeaseLostError)
        throw await this.ended(args);
      throw error;
    }
  }

  /** The worker reports one operation's outcome, to any replica. */
  async complete(args: {
    nodeId: string;
    session: string;
    operationId: string;
    response?: unknown;
    error?: string;
  }): Promise<void> {
    // A receipt proves the worker is alive; an old epoch's is refused below.
    const renewed = await this.deps.nodes.renewRemote({
      lease: { id: args.nodeId, token: args.session },
    });
    if (renewed.extended) await this.seen(args.nodeId);
    await this.queue.complete({
      executor: nodeExecutor(args.nodeId),
      leaseToken: args.session,
      operationId: args.operationId,
      ...(args.response !== undefined ? { response: args.response } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    });
  }

  /** A keepalive while operations run and no poll is pending. */
  async renew(args: { nodeId: string; session: string }): Promise<void> {
    await this.renewOrThrow(args);
  }

  /**
   * Renew the lease for this epoch, or say why the session ended: a newer
   * process took over, or the operator disabled the worker.
   */
  private async renewOrThrow(args: {
    nodeId: string;
    session: string;
  }): Promise<void> {
    const renewed = await this.deps.nodes.renewRemote({
      lease: { id: args.nodeId, token: args.session },
    });
    if (renewed.extended) await this.seen(args.nodeId);
    if (renewed.held) return;
    throw await this.ended(args);
  }

  /**
   * The operator's "last contact": written when a worker's call extends its
   * lease, so about every five seconds while it calls.
   */
  private async seen(nodeId: string): Promise<void> {
    await this.deps.db
      .updateTable("work_workers")
      .set({ last_seen_at: sql`now()` })
      .where("node_id", "=", nodeId)
      .where((eb) =>
        eb.or([
          eb("last_seen_at", "is", null),
          eb("last_seen_at", "<", sql<Date>`now() - interval '5 seconds'`),
        ]),
      )
      .execute();
  }

  /** Why this epoch's session ended: superseded, or disabled and lapsed. */
  private async ended(args: {
    nodeId: string;
    session: string;
  }): Promise<RemoteExecutorLeaseLostError> {
    const node = await this.deps.db
      .selectFrom("worker_nodes")
      .select(["lease_token", "enabled"])
      .where("id", "=", args.nodeId)
      .executeTakeFirst();
    if (node?.enabled && node.lease_token !== args.session)
      return new WorkerSupersededError();
    return new RemoteExecutorLeaseLostError();
  }

  /** Operator: a one-time code a new worker exchanges for its credential. */
  async createEnrollment(args: {
    name: string;
    ttlMinutes?: number;
    placement?: z.input<typeof WorkerPlacementSchema>;
  }): Promise<{ code: string; nodeId: string; expiresAt: Date }> {
    const enrollment = await this.issueEnrollment(args);
    if (!enrollment) {
      throw new Error(
        `A worker named '${args.name}' is already enrolled; revoke it first`,
      );
    }
    return enrollment;
  }

  /**
   * Machine reconciler: the code for a machine it is about to provision
   * under a rule, or null when that machine already enrolled or has a code
   * waiting. Replicas asking at once get one code, so a person never gets
   * two machines.
   */
  createMachineEnrollment(args: {
    name: string;
    rule: string;
    ttlMinutes: number;
    placement: z.input<typeof WorkerPlacementSchema>;
  }): Promise<{ code: string; nodeId: string; expiresAt: Date } | null> {
    return this.issueEnrollment({ ...args, machineRule: args.rule });
  }

  private async issueEnrollment(args: {
    name: string;
    ttlMinutes?: number;
    placement?: z.input<typeof WorkerPlacementSchema>;
    machineRule?: string;
  }): Promise<{ code: string; nodeId: string; expiresAt: Date } | null> {
    const name = WorkerName.parse(args.name);
    const placement = WorkerPlacementSchema.parse(args.placement ?? {});
    return this.deps.db.transaction().execute(async (trx) => {
      // One issuer per name at a time, across replicas, until commit.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`work-worker-name:${this.deps.tenantId}:${name}`}))`.execute(
        trx,
      );
      const enrolled = await trx
        .selectFrom("work_workers")
        .select("node_id")
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", name)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (enrolled) return null;
      if (args.machineRule) {
        // A code nobody used yet: its machine is being created, or the
        // reconciler destroys it before issuing another.
        const waiting = await trx
          .selectFrom("work_worker_enrollments")
          .select("code_hash")
          .where("tenant_id", "=", this.deps.tenantId)
          .where("name", "=", name)
          .where("machine_rule", "is not", null)
          .where("used_at", "is", null)
          .executeTakeFirst();
        if (waiting) return null;
      }
      const code = `wke_${randomBytes(24).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + (args.ttlMinutes ?? 30) * 60_000);
      await trx
        .insertInto("work_worker_enrollments")
        .values({
          code_hash: hash(code),
          tenant_id: this.deps.tenantId,
          name,
          labels: JSON.stringify(placement.labels),
          access: JSON.stringify(placement.access),
          trusted: placement.trusted,
          machine_rule: args.machineRule ?? null,
          machine_ref: null,
          expires_at: expiresAt,
        })
        .execute();
      return { code, nodeId: `${WORKER_NODE_PREFIX}${name}`, expiresAt };
    });
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

  /**
   * Worker: connect under the epoch its process chose at start (ADR 0192).
   * Any replica accepts it; the machine credential is the authority. The
   * same epoch again only refreshes the offer and the lease. A new epoch
   * takes over at once and fails the old epoch's operations as uncertain.
   */
  async connect(args: {
    nodeId: string;
    name: string;
    session: string;
    offer: WorkerOffer;
  }): Promise<void> {
    const policy = await this.placement(args.nodeId);
    if (
      args.offer.isolation === "process" &&
      !servesOneOwner(policy.access) &&
      !policy.trusted
    ) {
      throw new WorkerIsolationError(args.name);
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
      capabilities: ["network.egress", ...args.offer.capabilities],
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
    try {
      const connected = await this.deps.nodes.connectRemote({
        tenantId: this.deps.tenantId,
        authorityId: this.deps.authorityId,
        descriptor,
        capacity: args.offer.capacity satisfies WorkerCapacity,
        defaults: args.offer.defaults,
        epoch: args.session,
        offer: {
          workspaceRoot: args.offer.workspaceRoot,
          processes: args.offer.processes,
        },
      });
      await this.seen(args.nodeId);
      if (connected.superseded)
        this.deps.log?.(`Worker ${args.name} restarted and connected`);
      else this.deps.log?.(`Worker ${args.name} connected`);
    } catch (error) {
      if (error instanceof WorkerNodeLeaseHeldError)
        throw new WorkerDisabledError();
      if (error instanceof RemoteEpochSupersededError)
        throw new WorkerSupersededError();
      throw error;
    }
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

  /**
   * Retire workspaces of ended allocations on every connected worker,
   * through the worker, and drop abandoned queue rows. Any replica runs it:
   * each Allocation is claimed in Postgres before its workspace is
   * destroyed (ADR 0192). The cleanup waits on workers, so a pass in
   * progress is never started twice.
   */
  async maintain(): Promise<void> {
    await this.queue.sweep().catch(() => {});
    this.cleaning ??= this.cleanup().finally(() => {
      this.cleaning = undefined;
    });
  }

  private cleaning: Promise<void> | undefined;

  private async cleanup(): Promise<void> {
    const nodes = await this.deps.nodes.list({
      tenantId: this.deps.tenantId,
      authorityId: this.deps.authorityId,
    });
    for (const node of nodes) {
      if (!node.remote || !node.available || !isWorkerNode(node.id)) continue;
      await cleanupWorkerAllocations({
        db: this.deps.db,
        workerNode: { id: node.id, remote: true },
        provider: this.deps.nodes.remoteProvider({
          nodeId: node.id,
          offer: node.remote,
          label: "The worker",
        }),
      }).catch((error) =>
        this.deps.log?.(
          `Workspace cleanup on ${node.id} deferred: ${
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
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isWorkerNode(nodeId: string): boolean {
  return nodeId.startsWith(WORKER_NODE_PREFIX);
}
