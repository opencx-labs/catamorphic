import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  cleanupWorkerAllocations,
  forgetExecutorKey,
  MachineDiskSchema,
  type NodeRetireReason,
  nodeExecutor,
  PlacementWaitsService,
  REMOTE_EPOCH_PATTERN,
  RemoteEpochSupersededError,
  RemoteExecutorLeaseLostError,
  RemoteOperationQueue,
  registerExecutorKey,
  releaseReplicaClaim,
  retireNodeWork,
  takeReplicaClaim,
  type WorkerCapacity,
  WorkerNodeLeaseHeldError,
  type WorkerNodesService,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import {
  describeDisk,
  diskBudgetMb,
  type EnvironmentBinding,
  ExecutorPublicKeySchema,
  MACHINE_CAPABILITIES,
  type MachineDisk,
  SANDBOX_CAPABILITIES,
} from "@catamorphic/sandbox";
import { type Kysely, sql, type Transaction } from "kysely";
import { z } from "zod";
import {
  type MachineEvent,
  type MachineEventKind,
  type MachineFacts,
  principalsChangeNeedsReset,
} from "../machines/contract.js";
import type { HarnessSignInRequest } from "./harness-sign-ins.js";
import { MachineStore, WORKER_NODE_PREFIX } from "./machine-store.js";
import {
  type ScheduledPlacement,
  servesNobody,
  servesOneOwner,
  type WorkerPlacement,
  type WorkerPlacementSchema,
  workerPlacement,
} from "./placement.js";

export { WORKER_NODE_PREFIX };

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
        // What its sandboxes can be given (ADR 0176) and what the machine
        // offers beside its provider (ADR 0184), named by the same
        // constants the providers list, so a new one is never refused.
        z.enum([
          ...Object.values(SANDBOX_CAPABILITIES),
          ...Object.values(MACHINE_CAPABILITIES),
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
  /**
   * Its disk (ADR 0336): the filesystem it writes to with the least room
   * above its floor. Later measurements come with its lease renewals.
   */
  disk: MachineDiskSchema.optional(),
  /** What runs its sandboxes and why it was chosen (ADR 0204). */
  backend: z
    .strictObject({
      kind: z.enum(["microsandbox", "container", "local-process"]),
      runtime: z.enum(["runsc", "runc"]).optional(),
      reason: z.string().max(1000),
    })
    .optional(),
});
export type WorkerOffer = z.infer<typeof WorkerOfferSchema>;

/**
 * What a worker sends to connect: the epoch its process chose at start
 * (ADR 0192), which every later call repeats as its session, its offer, and
 * the public key its operations are sealed to (ADR 0207).
 */
export const WorkerConnectSchema = z.strictObject({
  session: z.string().regex(REMOTE_EPOCH_PATTERN, "Use a UUIDv7 epoch"),
  offer: WorkerOfferSchema,
  publicKey: ExecutorPublicKeySchema,
});

/** A credential older than this is due for rotation on its own (ADR 0207). */
export const WORKER_CREDENTIAL_MAX_AGE_DAYS = 30;

/** The enrolled worker a request's credential proves. */
export interface AuthenticatedWorker {
  nodeId: string;
  name: string;
  /**
   * Its credential should be rotated: the operator asked, or it is older
   * than {@link WORKER_CREDENTIAL_MAX_AGE_DAYS}. Answers tell the worker;
   * nothing is refused for it.
   */
  rotate: boolean;
}

export class WorkerIsolationError extends Error {
  constructor(name: string) {
    super(
      `Worker '${name}' serves more than one person, so it must isolate agents with microsandbox or with gVisor containers (WORK_SANDBOX=container with a runsc runtime), or be marked trusted by the operator`,
    );
    this.name = "WorkerIsolationError";
  }
}

/**
 * This worker's node is disabled: an operator disabled it, or Work stopped
 * its machine (ADR 0350). It may connect once enabled or resumed.
 */
export class WorkerDisabledError extends Error {
  constructor() {
    super(
      "This worker is disabled or its machine is stopped; it connects once it is enabled or resumed",
    );
    this.name = "WorkerDisabledError";
  }
}

/**
 * A rotation request arrived after a later one (ADR 0207): it was delayed on
 * its way, and the worker may already hold the later request's credential,
 * so it replaces nothing.
 */
export class WorkerRotationSupersededError extends Error {
  constructor() {
    super(
      "A later rotation of this worker's credential was already asked for; this one issues nothing",
    );
    this.name = "WorkerRotationSupersededError";
  }
}

/**
 * The worker connected with a key other than the one it enrolled or last
 * rotated with (ADR 0207): its data directory was replaced or altered.
 */
export class WorkerKeyMismatchError extends Error {
  constructor(name: string) {
    super(
      `Worker '${name}' holds a key other than the one it enrolled with; revoke it and enroll it again`,
    );
    this.name = "WorkerKeyMismatchError";
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
 * credential issued at enrollment and rotated every 30 days or when the
 * operator asks (ADR 0207); it never receives database, vault, or sign-in
 * secrets. Its operations are sealed to the public key it registered with
 * that credential. The worker owns its node lease (ADR 0192): its token is
 * the epoch the worker process chose at start, and each of its calls to any
 * replica renews it. Any replica runs the worker's agents and forwards their
 * sandbox operations through the queue in Postgres. Nothing about a worker
 * lives in a replica's memory.
 */
export class WorkWorkerRegistry {
  private readonly queue: RemoteOperationQueue;

  private readonly waits: PlacementWaitsService;

  /** The machines Work knows: whom each is for and where it stands. */
  readonly machines: MachineStore;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      nodes: WorkerNodesService;
      tenantId: string;
      authorityId: string;
      /**
       * Derives the enrollment codes of machines the machines hook makes
       * (ADR 0349); every replica of a deployment shares it.
       */
      enrollmentSecret?: string;
      /**
       * A worker connected: hint this process's agent sweep, which tries
       * chats waiting for a machine (ADR 0258) again at once.
       */
      connected?: () => void;
      /**
       * Something happened to a machine (ADR 0349): it connected, started
       * again, was lost, or fell short of disk. Delivery is the host's;
       * nothing here waits on it.
       */
      event?: (event: MachineEvent) => Promise<void>;
      /**
       * Work was retired from a machine (ADR 0348): hint this process's
       * agent sweep, which admits its chats again at once.
       */
      retired?: () => void;
      /**
       * Minutes unseen that make a machine whose plan sets no limit lost
       * (default 5).
       */
      lostMinutes?: number;
      log?: (line: string) => void;
    },
  ) {
    this.queue = new RemoteOperationQueue(deps.db);
    this.waits = new PlacementWaitsService(deps.db);
    this.machines = new MachineStore({
      db: deps.db,
      nodes: deps.nodes,
      tenantId: deps.tenantId,
      authorityId: deps.authorityId,
      // A registry that makes no machines (a test, a worker-only tool)
      // still needs a secret no one else knows.
      enrollmentSecret:
        deps.enrollmentSecret ?? randomBytes(32).toString("base64url"),
      ...(deps.lostMinutes !== undefined
        ? { lostMinutes: deps.lostMinutes }
        : {}),
    });
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
  async renew(args: {
    nodeId: string;
    session: string;
    /** Its latest disk measurement (ADR 0336). */
    disk?: MachineDisk;
  }): Promise<void> {
    await this.renewOrThrow(args);
    if (args.disk)
      await this.reportDisk({
        nodeId: args.nodeId,
        session: args.session,
        disk: args.disk,
      });
  }

  /**
   * Store a worker's disk report under its epoch (ADR 0336). One that
   * begins an episode under the floor is logged and told as
   * `machine.disk-low` once, whichever replica heard it.
   */
  private async reportDisk(args: {
    nodeId: string;
    session: string;
    disk: MachineDisk;
  }): Promise<void> {
    const episode = await this.deps.nodes.reportDisk({
      lease: { id: args.nodeId, token: args.session },
      disk: args.disk,
    });
    // Every report in an episode whose event is not recorded tries again;
    // the event names its episode, so it is never recorded twice.
    if (
      (episode.state !== "started" && episode.state !== "ongoing") ||
      !episode.unrecorded
    )
      return;
    const name = workerNameOf(args.nodeId);
    if (episode.state === "started")
      this.deps.log?.(
        `Worker ${name} is short of disk: ${describeDisk(args.disk)}`,
      );
    try {
      await this.emit({
        kind: "machine.disk-low",
        name,
        at: episode.since,
        disk: args.disk,
        rethrow: true,
      });
      await this.deps.nodes.diskLowRecorded({
        nodeId: args.nodeId,
        since: episode.since,
      });
    } catch (error) {
      this.deps.log?.(
        `Machine ${name} is short of disk, and recording it failed (tried again on its next report): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Tell the host something happened to a machine. A failure is logged;
   * with `rethrow` the caller hears it and tries again.
   */
  private async emit(args: {
    kind: MachineEventKind;
    name: string;
    at?: Date;
    disk?: MachineDisk;
    rethrow?: boolean;
  }): Promise<void> {
    if (!this.deps.event) return;
    try {
      const row = await this.machines.row({ name: args.name });
      if (!row) return;
      const placement = await this.machines.placementOf({ name: args.name });
      await this.deps.event({
        kind: args.kind,
        at: (args.at ?? new Date()).toISOString(),
        machine: {
          name: row.name,
          ref: row.ref,
          managed: row.managed,
          labels: placement.labels,
          for: placement.for,
          options: z.record(z.string(), z.unknown()).parse(row.options),
          reason: row.reason,
        },
        ...(args.disk
          ? {
              disk: {
                path: args.disk.path,
                totalBytes: args.disk.totalBytes,
                freeBytes: args.disk.freeBytes,
                floorBytes: args.disk.floorBytes,
                measuredAt: args.disk.measuredAt,
              },
            }
          : {}),
      });
    } catch (error) {
      if (args.rethrow) throw error;
      this.deps.log?.(
        `Recording ${args.kind} for machine ${args.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

  /**
   * A worker connected: a machine that was starting or resuming serves
   * from now on (ADRs 0349, 0350), and one that was lost and came back
   * with its disk is lost no more.
   */
  private async serving(args: { nodeId: string; name: string }): Promise<void> {
    await this.deps.db
      .updateTable("work_workers")
      .set({ last_seen_at: sql`now()` })
      .where("node_id", "=", args.nodeId)
      .where("last_seen_at", "is", null)
      .execute();
    const { name } = args;
    if (
      await this.machines.setPhase({
        name,
        phase: "running",
        from: ["starting"],
      })
    ) {
      await this.emit({ kind: "machine.connected", name });
      return;
    }
    if (
      await this.machines.setPhase({
        name,
        phase: "running",
        from: ["resuming"],
      })
    ) {
      await this.emit({ kind: "machine.started", name });
      return;
    }
    await this.deps.db
      .updateTable("work_machines")
      .set({ lost_at: null })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", name)
      .where("phase", "=", "running")
      .where("lost_at", "is not", null)
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

  /**
   * Operator: a one-time code a new worker exchanges for its credential,
   * for a machine enrolled by hand (ADR 0349): Work places work on it by
   * its labels and whom it is for, and never creates, stops or destroys
   * it. The machines hook's own machines are enrolled by the sequencer.
   */
  async createEnrollment(args: {
    name: string;
    ttlMinutes?: number;
    placement?: z.input<typeof WorkerPlacementSchema>;
  }): Promise<{ code: string; nodeId: string; expiresAt: Date }> {
    const name = WorkerName.parse(args.name);
    const placement = workerPlacement(args.placement ?? {});
    return this.deps.db.transaction().execute(async (trx) => {
      // One issuer per name at a time, across replicas, until commit.
      await this.machines.lockName({ name, transaction: trx });
      const enrolled = await trx
        .selectFrom("work_workers")
        .select("node_id")
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", name)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (enrolled)
        throw new Error(
          `A worker named '${name}' is already enrolled; revoke it first`,
        );
      const known = await this.machines.row({ name, transaction: trx });
      if (known?.managed)
        throw new Error(
          `The machines hook's plan already names a machine '${name}'; enroll this one under another name`,
        );
      // A code nobody used: this enrollment replaces it.
      await this.machines.forget({ name, transaction: trx });
      await trx
        .insertInto("work_machines")
        .values({
          tenant_id: this.deps.tenantId,
          name,
          managed: false,
          labels: JSON.stringify(placement.labels),
          serves: placement.for === null ? null : JSON.stringify(placement.for),
          trusted: placement.trusted,
          phase: "starting",
        })
        .execute();
      const code = `wke_${randomBytes(24).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + (args.ttlMinutes ?? 30) * 60_000);
      await trx
        .insertInto("work_worker_enrollments")
        .values({
          code_hash: hash(code),
          tenant_id: this.deps.tenantId,
          name,
          expires_at: expiresAt,
        })
        .execute();
      return { code, nodeId: `${WORKER_NODE_PREFIX}${name}`, expiresAt };
    });
  }

  /**
   * Worker: exchange a one-time code for a machine credential, registering
   * the public key its operations will be sealed to (ADR 0207).
   */
  async enroll(args: {
    code: string;
    publicKey: string;
  }): Promise<{ nodeId: string; name: string; credential: string }> {
    const publicKey = ExecutorPublicKeySchema.parse(args.publicKey);
    return this.deps.db.transaction().execute(async (trx) => {
      const codeHash = hash(args.code);
      const enrollment = await trx
        .selectFrom("work_worker_enrollments")
        .select("name")
        .where("code_hash", "=", codeHash)
        .where("tenant_id", "=", this.deps.tenantId)
        .executeTakeFirst();
      const invalid = () =>
        new Error("The enrollment code is invalid, used, or expired");
      if (!enrollment) throw invalid();

      // The same name lock orders this with issuance, refusal, replacement,
      // and revocation. Recheck the code after acquiring the lock.
      await this.machines.lockName({ name: enrollment.name, transaction: trx });
      const machine = await trx
        .selectFrom("work_machines")
        .select(["phase", "disabled_at", "dropped_at"])
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", enrollment.name)
        .forUpdate()
        .executeTakeFirst();
      if (machine?.phase !== "starting" || machine.dropped_at) throw invalid();
      const consumed = await trx
        .updateTable("work_worker_enrollments")
        .set({ used_at: sql`now()` })
        .where("code_hash", "=", codeHash)
        .where("tenant_id", "=", this.deps.tenantId)
        .where("used_at", "is", null)
        .where("expires_at", ">", sql<Date>`now()`)
        .returning("code_hash")
        .executeTakeFirst();
      if (!consumed) throw invalid();
      const nodeId = `${WORKER_NODE_PREFIX}${enrollment.name}`;
      const secret = randomBytes(32).toString("base64url");
      // A name enrolling again is a new machine under the old node id (ADR
      // 0348): whatever the old one still held is retired in this
      // transaction, before the node is enabled, so the new machine never
      // inherits an Allocation, a reservation or a cache copy.
      await this.retire({
        nodeId,
        name: enrollment.name,
        reason: "replaced",
        transaction: trx,
      });
      await trx
        .deleteFrom("work_workers")
        .where("node_id", "=", nodeId)
        .where("revoked_at", "is not", null)
        .execute();
      // A re-enrolled name gets its (revoked, disabled) node back, as a
      // new machine: nothing of the old one's disk (ADR 0336).
      await trx
        .updateTable("worker_nodes")
        .set({
          enabled: machine.disabled_at === null,
          admission_revision: null,
          lease_expires_at: sql`now()`,
          disk: null,
          disk_low_at: null,
          disk_low_recorded_at: null,
        })
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
        })
        .execute();
      await registerExecutorKey({
        db: trx,
        executor: nodeExecutor(nodeId),
        publicKey,
      });
      return {
        nodeId,
        name: enrollment.name,
        credential: `${nodeId}:${secret}`,
      };
    });
  }

  /**
   * The enrolled worker a request's credential proves, if any. The first
   * call made with a rotated credential makes it current (ADR 0207): its key
   * is registered and the previous credential stops working.
   */
  async authenticate(
    authorization: string | undefined,
  ): Promise<AuthenticatedWorker | undefined> {
    const match = authorization?.match(/^Worker\s+(worker\.[a-z0-9-]+):(\S+)$/);
    if (!match?.[1] || !match[2]) return undefined;
    const nodeId = match[1];
    const presented = hash(match[2]);
    const row = await this.deps.db
      .selectFrom("work_workers")
      .select(["name", "credential_hash", "pending_credential_hash"])
      .select(
        sql<boolean>`rotation_requested_at IS NOT NULL OR credential_issued_at < now() - make_interval(days => ${WORKER_CREDENTIAL_MAX_AGE_DAYS})`.as(
          "rotate",
        ),
      )
      .where("node_id", "=", nodeId)
      .where("tenant_id", "=", this.deps.tenantId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!row) return undefined;
    if (sameHash(row.credential_hash, presented))
      return { nodeId, name: row.name, rotate: row.rotate };
    if (
      row.pending_credential_hash &&
      sameHash(row.pending_credential_hash, presented)
    )
      return this.promote({ nodeId, credentialHash: presented });
    return undefined;
  }

  /**
   * The worker used its rotated credential for the first time: it holds
   * the new credential and key on disk, so operations are sealed to the new
   * key from now on and the previous credential ends. Concurrent first
   * calls promote it once.
   */
  private async promote(args: {
    nodeId: string;
    credentialHash: string;
  }): Promise<AuthenticatedWorker | undefined> {
    return this.deps.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("work_workers")
        .select([
          "name",
          "credential_hash",
          "pending_credential_hash",
          "pending_public_key",
        ])
        .where("node_id", "=", args.nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      // Another call made with this credential promoted it just now.
      if (row.credential_hash === args.credentialHash)
        return { nodeId: args.nodeId, name: row.name, rotate: false };
      if (
        row.pending_credential_hash !== args.credentialHash ||
        !row.pending_public_key
      )
        return undefined;
      const promoted = await trx
        .updateTable("work_workers")
        .set({
          credential_hash: args.credentialHash,
          credential_issued_at: sql`COALESCE(pending_issued_at, now())`,
          pending_credential_hash: null,
          pending_public_key: null,
          pending_issued_at: null,
          pending_rotation: null,
          // An operator's request made after this credential was issued
          // still wants another.
          rotation_requested_at: sql`CASE WHEN rotation_requested_at <= pending_issued_at THEN NULL ELSE rotation_requested_at END`,
        })
        .where("node_id", "=", args.nodeId)
        .returning(sql<boolean>`rotation_requested_at IS NOT NULL`.as("rotate"))
        .executeTakeFirstOrThrow();
      await registerExecutorKey({
        db: trx,
        executor: nodeExecutor(args.nodeId),
        publicKey: row.pending_public_key,
      });
      this.deps.log?.(`Worker ${row.name} rotated its credential and key`);
      return { nodeId: args.nodeId, name: row.name, rotate: promoted.rotate };
    });
  }

  /**
   * Worker: a new credential for the public key it generated (ADR 0207).
   * The new credential stays pending, and the one this call was made with
   * keeps working, until the worker first uses the new one; asking again
   * before then replaces the pending credential. So an answer lost on the
   * way never strands the worker, and a retry is always safe. `rotation` is
   * a UUIDv7 the worker chose for this request: a request replaces the
   * pending credential only when it is later than the pending one's, so one
   * delayed on its way can never replace the credential a later request
   * issued ({@link WorkerRotationSupersededError}).
   */
  async rotate(args: {
    nodeId: string;
    publicKey: string;
    rotation: string;
  }): Promise<{ credential: string }> {
    const publicKey = ExecutorPublicKeySchema.parse(args.publicKey);
    if (!REMOTE_EPOCH_PATTERN.test(args.rotation))
      throw new Error("A rotation id must be a lowercase UUIDv7");
    const secret = randomBytes(32).toString("base64url");
    await this.deps.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("work_workers")
        .select("pending_rotation")
        .where("node_id", "=", args.nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .where("revoked_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new Error("This worker is not enrolled");
      // Lowercase UUIDv7s order by the time they were made.
      if (
        row.pending_rotation !== null &&
        row.pending_rotation >= args.rotation
      )
        throw new WorkerRotationSupersededError();
      await trx
        .updateTable("work_workers")
        .set({
          pending_credential_hash: hash(secret),
          pending_public_key: publicKey,
          pending_issued_at: sql`now()`,
          pending_rotation: args.rotation,
        })
        .where("node_id", "=", args.nodeId)
        .execute();
    });
    return { credential: `${args.nodeId}:${secret}` };
  }

  /**
   * Operator: ask a worker to rotate its credential and key. It is told at
   * its next call and rotates on its own; nothing it runs is interrupted.
   */
  async requestRotation(args: { name: string }): Promise<boolean> {
    const row = await this.deps.db
      .updateTable("work_workers")
      .set({ rotation_requested_at: sql`now()` })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", WorkerName.parse(args.name))
      .where("revoked_at", "is", null)
      .returning("node_id")
      .executeTakeFirst();
    return Boolean(row);
  }

  /**
   * Worker: connect under the epoch its process chose at start (ADR 0192).
   * Any replica accepts it; the machine credential is the authority. The
   * same epoch again only refreshes the offer and the lease. A new epoch
   * takes over at once and fails the old epoch's operations as uncertain.
   * Its key must be the one it enrolled or last rotated with (ADR 0207); a
   * worker enrolled before operations were sealed registers its key here,
   * on the authority of its credential.
   */
  async connect(args: {
    nodeId: string;
    name: string;
    session: string;
    offer: WorkerOffer;
    publicKey: string;
  }): Promise<void> {
    const policy = await this.placement(args.nodeId);
    if (
      args.offer.isolation === "process" &&
      !servesOneOwner(policy.for) &&
      !servesNobody(policy.for) &&
      !policy.trusted
    ) {
      throw new WorkerIsolationError(args.name);
    }
    const registered = await registerExecutorKey({
      db: this.deps.db,
      executor: nodeExecutor(args.nodeId),
      publicKey: args.publicKey,
      ifAbsent: true,
    });
    if (registered !== args.publicKey)
      throw new WorkerKeyMismatchError(args.name);
    const descriptor: EnvironmentBinding = {
      id: args.nodeId,
      label: args.name,
      description: `Run on worker ${args.name}`,
      trust: "managed",
      isolation: args.offer.isolation,
      // Workflow runs carry project secrets; they stay on the control plane.
      workloads: ["agent"],
      agentTopologies: ["controller"],
      capabilities: [
        "network.egress",
        ...args.offer.capabilities.filter(
          (capability) => capability !== MACHINE_CAPABILITIES.disk,
        ),
        // It reports its disk, so admission reserves storage here (ADR 0336).
        ...(args.offer.disk ? [MACHINE_CAPABILITIES.disk] : []),
      ],
      resources: {
        ...(args.offer.capacity.cpuMillis
          ? { cpuMillis: args.offer.capacity.cpuMillis }
          : {}),
        ...(args.offer.capacity.memoryMb
          ? { memoryMb: args.offer.capacity.memoryMb }
          : {}),
        ...(args.offer.disk
          ? { storageMb: diskBudgetMb(args.offer.disk) }
          : {}),
      },
      resourceLimits: args.offer.resourceLimits,
      labels: { ...policy.labels, node: args.nodeId, plane: "worker" },
      ...(args.offer.backend ? { backend: args.offer.backend } : {}),
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
      await this.serving({ nodeId: args.nodeId, name: args.name });
      await this.machines.openPlacement({ name: args.name });
      await this.seen(args.nodeId);
      if (args.offer.disk)
        await this.reportDisk({
          nodeId: args.nodeId,
          session: args.session,
          disk: args.offer.disk,
        });
      if (connected.superseded)
        this.deps.log?.(`Worker ${args.name} restarted and connected`);
      else this.deps.log?.(`Worker ${args.name} connected`);
      // Work waiting for a machine may fit here now (ADR 0258): every
      // replica's sweep tries it again at once.
      await this.waits.wake({ tenantId: this.deps.tenantId });
      this.deps.connected?.();
    } catch (error) {
      if (error instanceof WorkerNodeLeaseHeldError)
        throw new WorkerDisabledError();
      if (error instanceof RemoteEpochSupersededError)
        throw new WorkerSupersededError();
      throw error;
    }
  }

  /** One enrolled worker's placement, as its connection is checked against. */
  async placement(nodeId: string): Promise<WorkerPlacement> {
    return this.machines.placementOf({ name: workerNameOf(nodeId) });
  }

  /** Placement of every machine, by node, for the scheduler. */
  placements(): Promise<Map<string, ScheduledPlacement>> {
    return this.machines.placements();
  }

  /**
   * Operator: change whom a machine enrolled by hand is for, its labels and
   * whether those it serves trust each other. A machine the machines hook
   * made follows its plan instead. Work on it is not moved: change whom it
   * is for while it holds none, or leave that to the plan, which resets a
   * machine before someone new may use it.
   */
  async setPlacement(args: {
    name: string;
    placement: Partial<z.input<typeof WorkerPlacementSchema>>;
  }): Promise<WorkerPlacement> {
    const name = WorkerName.parse(args.name);
    const row = await this.machines.row({ name });
    if (!row) throw new Error(`Work knows no machine named '${name}'`);
    if (row.managed)
      throw new Error(
        `Machine '${name}' follows the machines hook's plan: change its plan entry instead`,
      );
    const current = await this.machines.placementOf({ name });
    const next = workerPlacement({
      labels: current.labels,
      ...(current.for === null ? {} : { for: [...current.for] }),
      trusted: current.trusted,
      ...args.placement,
    });
    await this.machines.configure({
      name,
      labels: next.labels,
      trusted: next.trusted,
      reason: row.reason,
      lostAfterMinutes: row.lost_after_minutes,
    });
    if (
      row.reset_pending ||
      (row.phase !== "starting" &&
        principalsChangeNeedsReset({ from: current.for, to: next.for }))
    ) {
      await this.machines.beginReset({ name, for: next.for });
      await this.resetPlacement({ name });
      return this.machines.placementOf({ name });
    }
    await this.machines.setFor({ name, for: next.for });
    return next;
  }

  /**
   * Operator: disable a machine, or enable it again (ADR 0190). Disabled,
   * it takes no work and its work waits for it; it is never called lost.
   */
  async setDisabled(args: {
    name: string;
    disabled: boolean;
  }): Promise<boolean> {
    const name = WorkerName.parse(args.name);
    const row = await this.deps.db
      .updateTable("work_machines")
      .set({
        disabled_at: args.disabled
          ? sql<Date>`coalesce(disabled_at, now())`
          : null,
        updated_at: sql`now()`,
      })
      .where("tenant_id", "=", this.deps.tenantId)
      .where("name", "=", name)
      .returning("phase")
      .executeTakeFirst();
    if (!row) return false;
    // A machine Work stopped stays off until it is resumed.
    const serves = ["starting", "running", "resuming"].includes(row.phase);
    await this.deps.nodes.setEnabled({
      tenantId: this.deps.tenantId,
      authorityId: this.deps.authorityId,
      nodeId: `${WORKER_NODE_PREFIX}${name}`,
      enabled: !args.disabled && serves,
    });
    return true;
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
    await this.retireGone().catch((error: unknown) =>
      this.deps.log?.(
        `Retiring lost machines' work failed (tried again on the next pass): ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    await this.forgetNeverEnrolled().catch(() => {});
    this.cleaning ??= this.cleanup().finally(() => {
      this.cleaning = undefined;
    });
  }

  private cleaning: Promise<void> | undefined;

  /** A machine enrolled by hand whose code expired unused is known no more. */
  private async forgetNeverEnrolled(): Promise<void> {
    await this.deps.db
      .deleteFrom("work_machines")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("managed", "=", false)
      .where("phase", "=", "starting")
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("work_workers")
              .select("work_workers.node_id")
              .whereRef(
                "work_workers.tenant_id",
                "=",
                "work_machines.tenant_id",
              )
              .whereRef("work_workers.name", "=", "work_machines.name")
              .where("work_workers.revoked_at", "is", null),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("work_worker_enrollments")
              .select("work_worker_enrollments.code_hash")
              .whereRef(
                "work_worker_enrollments.tenant_id",
                "=",
                "work_machines.tenant_id",
              )
              .whereRef(
                "work_worker_enrollments.name",
                "=",
                "work_machines.name",
              )
              .where("work_worker_enrollments.used_at", "is", null)
              .where(
                "work_worker_enrollments.expires_at",
                ">",
                sql<Date>`now()`,
              ),
          ),
        ),
      )
      .execute();
  }

  /**
   * Retire the work of machines that are gone (ADR 0348), on any replica:
   * a revoked worker's, when the process that revoked it stopped before
   * retiring it, and a lost machine's, whoever enrolled it. Its chats are
   * admitted again on a machine open to their owner, or wait for one; the
   * plan replaces a machine it still names, and a machine enrolled by hand
   * that comes back removes the sandboxes whose Allocations are gone. A
   * machine an operator disabled, or one Work stopped, is never lost.
   */
  private async retireGone(): Promise<void> {
    const revoked = await this.deps.db
      .selectFrom("work_workers")
      .select(["node_id", "name"])
      .where("tenant_id", "=", this.deps.tenantId)
      .where("revoked_at", "is not", null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("execution_allocations")
            .select("execution_allocations.id")
            .whereRef(
              "execution_allocations.worker_node_id",
              "=",
              "work_workers.node_id",
            )
            .where("execution_allocations.capacity_released_at", "is", null),
        ),
      )
      .execute();
    for (const worker of revoked)
      await this.retireRevoked({ name: worker.name, nodeId: worker.node_id });
    const lost = [...(await this.machines.reach())].filter(
      ([, machine]) => machine.state === "lost",
    );
    if (lost.length === 0) return;
    const holding = await this.deps.db
      .selectFrom("execution_allocations")
      .select("worker_node_id")
      .distinct()
      .where(
        "worker_node_id",
        "in",
        lost.map(([, machine]) => machine.nodeId),
      )
      .where("capacity_released_at", "is", null)
      .execute();
    const held = new Set(holding.map((row) => row.worker_node_id));
    for (const [name, machine] of lost) {
      if (held.has(machine.nodeId))
        await this.retire({ nodeId: machine.nodeId, name, reason: "lost" });
      // The sequencer says so for the machines it makes, as it replaces them.
      if (machine.managed || machine.lostNoted) continue;
      const noted = await this.deps.db
        .updateTable("work_machines")
        .set({ lost_at: sql`now()` })
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", name)
        .where("lost_at", "is", null)
        .returning("name")
        .executeTakeFirst();
      if (noted) await this.emit({ kind: "machine.lost", name });
    }
  }

  private async retireRevoked(args: {
    name: string;
    nodeId: string;
  }): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      await this.machines.lockName({ name: args.name, transaction: trx });
      const revoked = await trx
        .selectFrom("work_workers")
        .select("name")
        .where("tenant_id", "=", this.deps.tenantId)
        .where("node_id", "=", args.nodeId)
        .where("revoked_at", "is not", null)
        .executeTakeFirst();
      if (revoked)
        await this.retire({ ...args, reason: "revoked", transaction: trx });
    });
  }

  /**
   * Retire what a machine held, through core's one retirement (ADR 0348).
   * Safe to call again, from any replica.
   */
  private async retire(args: {
    nodeId: string;
    name: string;
    reason: NodeRetireReason;
    transaction?: Transaction<DB>;
  }): Promise<void> {
    const retired = await retireNodeWork({
      db: this.deps.db,
      nodeId: args.nodeId,
      reason: args.reason,
      ...(args.transaction ? { transaction: args.transaction } : {}),
    });
    if (retired.released + retired.freed === 0) return;
    this.deps.log?.(
      `Machine ${args.name} is ${args.reason === "lost" ? "lost" : "gone"}: ${retired.released} workspace(s) retired, ${retired.freed} released workspace(s) freed; their chats continue from their last save`,
    );
    this.deps.retired?.();
  }

  private async cleanup(): Promise<void> {
    const pending = await this.deps.db
      .selectFrom("work_machines")
      .select("name")
      .where("tenant_id", "=", this.deps.tenantId)
      .where("managed", "=", false)
      .where("reset_pending", "=", true)
      .execute();
    for (const { name } of pending)
      await this.resetPlacement({ name }).catch((error: unknown) =>
        this.deps.log?.(`Machine reset deferred for ${name}: ${String(error)}`),
      );
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

  /**
   * Operator: end a worker's authority now. Its credential, any rotated one
   * still pending, and its key stop working. A machine enrolled by hand is
   * known no more; one the machines hook made is destroyed by the next
   * pass, and made again if the plan still names it.
   */
  async revoke(args: { name: string }): Promise<boolean> {
    const row = await this.deps.db.transaction().execute(async (trx) => {
      const { name } = args;
      await this.machines.lockName({ name, transaction: trx });
      const nodeId = `${WORKER_NODE_PREFIX}${name}`;
      await trx
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", nodeId)
        .forUpdate()
        .executeTakeFirst();
      const worker = await trx
        .updateTable("work_workers")
        .set({
          revoked_at: sql`now()`,
          pending_credential_hash: null,
          pending_public_key: null,
          pending_issued_at: null,
          pending_rotation: null,
        })
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", name)
        .where("revoked_at", "is", null)
        .returning("node_id")
        .executeTakeFirst();
      if (!worker) return undefined;
      await forgetExecutorKey({
        db: trx,
        executor: nodeExecutor(worker.node_id),
      });
      await trx
        .updateTable("worker_nodes")
        .set({ enabled: false })
        .where("id", "=", worker.node_id)
        .where("tenant_id", "=", this.deps.tenantId)
        .execute();
      const machine = await this.machines.row({ name, transaction: trx });
      if (machine && !machine.managed)
        await this.machines.forget({ name, transaction: trx });
      return worker;
    });
    if (!row) return false;
    await this.retireRevoked({ name: args.name, nodeId: row.node_id });
    return true;
  }

  /**
   * Take a machine out of service for good, unless work landed on it (ADRs
   * 0258, 0349): under its node's row lock, which creating an Allocation
   * takes too, it is revoked and disabled and becomes `destroying` only
   * while no Allocation holds its capacity, so nothing is placed on a
   * machine about to be destroyed. One whose worker an operator revoked,
   * and one that never enrolled, hold nothing. False when it was kept.
   */
  async retireMachine(args: { name: string }): Promise<boolean> {
    const taken = await this.takeOutOfService({ ...args, lost: null });
    if (taken)
      await this.retire({
        nodeId: `${WORKER_NODE_PREFIX}${args.name}`,
        name: args.name,
        reason: "revoked",
      });
    return taken;
  }

  /**
   * A machine has been unseen for `unseenForMs` (ADR 0348): take it out of
   * service for good and retire what it held, so its chats continue from
   * their last save and its plan may replace it. Under its node's row
   * lock, and only while it is still unseen: a machine that called again
   * meanwhile is kept. False when it was kept.
   */
  async declareLost(args: {
    name: string;
    unseenForMs: number;
  }): Promise<boolean> {
    const lost = await this.takeOutOfService({
      name: args.name,
      lost: { unseenForMs: args.unseenForMs },
    });
    if (lost)
      await this.retire({
        nodeId: `${WORKER_NODE_PREFIX}${args.name}`,
        name: args.name,
        reason: "lost",
      });
    return lost;
  }

  /**
   * Revoke and disable a machine under its node's row lock and make it
   * `destroying`. Retiring what it held follows once this commits:
   * disabled, it takes nothing new.
   */
  private async takeOutOfService(args: {
    name: string;
    /** Only a machine still unseen this long, whatever it holds. */
    lost: { unseenForMs: number } | null;
  }): Promise<boolean> {
    const nodeId = `${WORKER_NODE_PREFIX}${args.name}`;
    return this.deps.db.transaction().execute(async (trx) => {
      await this.machines.lockName({ name: args.name, transaction: trx });
      const node = await trx
        .selectFrom("worker_nodes")
        .select(sql<boolean>`enabled AND lease_expires_at > now()`.as("live"))
        .where("id", "=", nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .forUpdate()
        .executeTakeFirst();
      const worker = await trx
        .selectFrom("work_workers")
        .select([
          "revoked_at",
          sql<number>`(extract(epoch from (now() - coalesce(last_seen_at, enrolled_at))) * 1000)::float8`.as(
            "unseen_for_ms",
          ),
        ])
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", args.name)
        .executeTakeFirst();
      const serving = worker !== undefined && worker.revoked_at === null;
      if (args.lost) {
        // It called again meanwhile: it is kept as it is.
        if (serving && node?.live) return false;
        if (serving && Number(worker.unseen_for_ms) < args.lost.unseenForMs)
          return false;
      } else if (serving) {
        const held = await trx
          .selectFrom("execution_allocations")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("worker_node_id", "=", nodeId)
          .where("capacity_released_at", "is", null)
          .executeTakeFirst();
        // Connected, it gives them back as its chats idle (ADR 0173).
        if (Number(held?.count ?? 0) > 0) return false;
      }
      const moved = await this.machines.setPhase({
        name: args.name,
        phase: "destroying",
        ...(args.lost ? { lost: true } : {}),
        transaction: trx,
      });
      if (!moved) return false;
      // Its code stops working: nothing enrolls under this name until its
      // platform confirmed it gone.
      await trx
        .deleteFrom("work_worker_enrollments")
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", args.name)
        .where("used_at", "is", null)
        .execute();
      if (!serving) return true;
      await trx
        .updateTable("work_workers")
        .set({
          revoked_at: sql`now()`,
          pending_credential_hash: null,
          pending_public_key: null,
          pending_issued_at: null,
          pending_rotation: null,
        })
        .where("tenant_id", "=", this.deps.tenantId)
        .where("name", "=", args.name)
        .where("revoked_at", "is", null)
        .execute();
      await forgetExecutorKey({ db: trx, executor: nodeExecutor(nodeId) });
      await trx
        .updateTable("worker_nodes")
        .set({ enabled: false })
        .where("id", "=", nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .where("authority_id", "=", this.deps.authorityId)
        .execute();
      return true;
    });
  }

  /**
   * Begin stopping a machine (ADR 0350): under its node's row lock, only
   * while no Allocation holds its capacity, it takes no new work and
   * becomes `stopping`. It keeps its worker, its credential and its disk.
   * False when it holds something, or is not serving.
   */
  async beginStop(args: { name: string; at?: string }): Promise<boolean> {
    const nodeId = `${WORKER_NODE_PREFIX}${args.name}`;
    return this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .forUpdate()
        .executeTakeFirst();
      const held = await trx
        .selectFrom("execution_allocations")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("worker_node_id", "=", nodeId)
        .where("capacity_released_at", "is", null)
        .executeTakeFirst();
      if (Number(held?.count ?? 0) > 0) return false;
      const moved = await this.machines.setPhase({
        name: args.name,
        phase: "stopping",
        from: ["running"],
        ...(args.at ? { at: args.at } : {}),
        transaction: trx,
      });
      if (!moved) return false;
      await trx
        .updateTable("worker_nodes")
        .set({ enabled: false })
        .where("id", "=", nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .where("authority_id", "=", this.deps.authorityId)
        .execute();
      return true;
    });
  }

  /**
   * Begin resuming a stopped machine (ADR 0350): it becomes `resuming`,
   * and its worker, which kept its credential and data directory, may
   * connect again under a new epoch.
   */
  async beginResume(args: { name: string; at: string }): Promise<boolean> {
    const nodeId = `${WORKER_NODE_PREFIX}${args.name}`;
    return this.deps.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", nodeId)
        .forUpdate()
        .executeTakeFirst();
      const moved = await this.machines.setPhase({
        name: args.name,
        phase: "resuming",
        from: ["stopped"],
        at: args.at,
        transaction: trx,
      });
      if (!moved) return false;
      const machine = await this.machines.row({
        name: args.name,
        transaction: trx,
      });
      await trx
        .updateTable("worker_nodes")
        .set({
          enabled: machine?.disabled_at === null,
          admission_revision: null,
          lease_expires_at: sql`now()`,
        })
        .where("id", "=", nodeId)
        .where("tenant_id", "=", this.deps.tenantId)
        .where("authority_id", "=", this.deps.authorityId)
        .execute();
      return true;
    });
  }

  /**
   * Allocations still holding a machine's capacity: live workspaces, and
   * ones given back whose sandboxes are not destroyed yet.
   */
  async holding(args: { name: string }): Promise<number> {
    const row = await this.deps.db
      .selectFrom("execution_allocations")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("worker_node_id", "=", `${WORKER_NODE_PREFIX}${args.name}`)
      .where("capacity_released_at", "is", null)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Workspaces still active on a worker: chats keep theirs until they idle
   * and give it back, saved to their session branch (ADR 0173).
   */
  async activeWorkspaces(args: { name: string }): Promise<number> {
    const row = await this.deps.db
      .selectFrom("execution_allocations")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("worker_node_id", "=", `${WORKER_NODE_PREFIX}${args.name}`)
      .where("status", "=", "active")
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** The worker's lease is live: an operation sent to it now runs. */
  async connected(args: { name: string }): Promise<boolean> {
    return Boolean(
      await this.deps.nodes.liveToken({
        nodeId: `${WORKER_NODE_PREFIX}${args.name}`,
      }),
    );
  }

  /**
   * A member's harness sign-in on a worker (ADRs 0213, 0342), through the
   * operation queue: the worker runs the harness's own login and answers.
   * Fails at once while the worker is not connected.
   */
  async harnessSignIn(args: {
    nodeId: string;
    request: HarnessSignInRequest;
  }): Promise<unknown> {
    const { nodeId } = args;
    return this.queue.machineHarnessSignIn({
      executor: nodeExecutor(nodeId),
      leaseToken: () => this.deps.nodes.liveToken({ nodeId }),
      leaseHeld: async (token) =>
        (await this.deps.nodes.liveToken({ nodeId })) === token,
      label: "The machine",
      request: args.request,
      attributes: { "catamorphic.worker.id": nodeId },
    });
  }

  /** A drained worker can be wiped without handing its disk to two owners. */
  async resetPlacement(args: {
    name: string;
    timeoutMs?: number;
  }): Promise<"busy" | "offline" | "done"> {
    const { name } = args;
    if (!(await this.connected({ name }))) return "offline";
    const timeoutMs = args.timeoutMs ?? 180_000;
    const claim = {
      db: this.deps.db,
      name: `machine-reset:${this.deps.tenantId}:${name}`,
      holder: randomUUID(),
    };
    if (
      !(await takeReplicaClaim({
        ...claim,
        ttlSeconds: Math.ceil(timeoutMs / 1000) + 60,
      }))
    )
      return "busy";
    try {
      const machine = await this.machines.row({ name });
      if (!machine?.reset_pending) return "done";
      if ((await this.holding({ name })) > 0) return "busy";
      await this.resetMachine({ name, timeoutMs });
      await this.machines.finishReset({ name });
      return "done";
    } finally {
      await releaseReplicaClaim(claim);
    }
  }

  /**
   * Reset a machine through the operation queue (ADRs 0205, 0349): the
   * worker destroys every sandbox it holds and deletes members' volumes
   * and sign-ins. Resolves once its receipt arrived; fails while it is not
   * connected, and once `timeoutMs` passed without a receipt.
   */
  async resetMachine(args: {
    name: string;
    timeoutMs?: number;
  }): Promise<void> {
    const nodeId = `${WORKER_NODE_PREFIX}${args.name}`;
    await this.queue.resetMachine({
      executor: nodeExecutor(nodeId),
      leaseToken: () => this.deps.nodes.liveToken({ nodeId }),
      leaseHeld: async (token) =>
        (await this.deps.nodes.liveToken({ nodeId })) === token,
      label: `Worker ${args.name}`,
      attributes: { "catamorphic.worker.id": nodeId },
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });
    // Its volumes are gone, cache copies included (ADR 0334): none is
    // mounted again, and the next workspace there queues a fill.
    await this.deps.db
      .updateTable("environment_cache_fills")
      .set({ status: "evicted" })
      .where("worker_node_id", "=", nodeId)
      .where("status", "=", "succeeded")
      .execute();
  }

  /**
   * Every machine Work knows, for the operator and administrators: its
   * facts as the plan reads them, and its worker's credential standing.
   */
  async list(): Promise<WorkerListing[]> {
    const [records, workers] = await Promise.all([
      this.machines.records(),
      this.deps.db
        .selectFrom("work_workers")
        .select([
          "name",
          "enrolled_at",
          "revoked_at",
          "credential_issued_at",
          "rotation_requested_at",
        ])
        .where("tenant_id", "=", this.deps.tenantId)
        .execute(),
    ]);
    const workerOf = new Map(workers.map((worker) => [worker.name, worker]));
    return records.map(({ facts }) => {
      const worker = workerOf.get(facts.name);
      const enrolled =
        worker && worker.revoked_at === null ? worker : undefined;
      return {
        ...facts,
        nodeId: `${WORKER_NODE_PREFIX}${facts.name}`,
        // Its lease is live: an operation sent to it now runs (ADR 0348).
        connected: facts.state === "serving" || facts.state === "draining",
        enrolledAt: enrolled?.enrolled_at.toISOString() ?? null,
        credentialIssuedAt:
          enrolled?.credential_issued_at.toISOString() ?? null,
        rotationRequested: Boolean(enrolled?.rotation_requested_at),
      };
    });
  }
}

/** A machine in the operator's and administrators' listing. */
export type WorkerListing = MachineFacts & {
  nodeId: string;
  connected: boolean;
  /** When its worker enrolled; null before it did. */
  enrolledAt: string | null;
  /** When its current credential was issued (ADR 0207). */
  credentialIssuedAt: string | null;
  /** The operator asked for a rotation the worker has not made yet. */
  rotationRequested: boolean;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The worker name in a worker node's id. */
function workerNameOf(nodeId: string): string {
  return nodeId.startsWith(WORKER_NODE_PREFIX)
    ? nodeId.slice(WORKER_NODE_PREFIX.length)
    : nodeId;
}

/** Two hex digests compared in constant time. */
function sameHash(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(actual, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isWorkerNode(nodeId: string): boolean {
  return nodeId.startsWith(WORKER_NODE_PREFIX);
}
