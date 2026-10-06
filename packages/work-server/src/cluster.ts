import { createECDH, createHash } from "node:crypto";
import {
  capacityFits,
  cleanupWorkerAllocations,
  EnvironmentCapacityError,
  WORKER_NODE_LEASE_MS,
  type WorkerCapacity,
  WorkerNodeLeaseHeldError,
  WorkerNodesService,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import type {
  EnvironmentBinding,
  EnvironmentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import {
  accessTier,
  environmentSatisfies,
  placementOrder,
  poolMatches,
} from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import {
  nodeAccess,
  servesOneOwner,
  type WorkerPlacement,
} from "./workers/placement.js";
import { isWorkerNode } from "./workers/worker-registry.js";

/** A lease renewal that takes longer than this is abandoned and retried. */
const RENEWAL_TIMEOUT_MS = 10_000;

/** Work server deployment policy. Core only sees leased nodes and runtime bindings. */
export async function registerWorkMachine(args: {
  db: Kysely<DB>;
  tenantId: string;
  authorityId: string;
  nodeId: string;
  /**
   * The node lives as long as this process (ADR 0190): a replica on
   * network Postgres. Stopping releases it for good, and any replica
   * recovers its work once it is gone.
   */
  disposable: boolean;
  label: string;
  sandboxProvider: SandboxProvider;
  capacity?: WorkerCapacity;
  defaults?: { cpuMillis?: number; memoryMb?: number };
  isolation?: "process" | "sandbox";
  /** Workloads this control-plane machine accepts (ADR 0164). */
  workloads?: ("agent" | "workflow")[];
  /** Operator labels for this control-plane machine (ADR 0167). */
  labels?: Readonly<Record<string, string>>;
  /** What this machine offers beside its sandbox provider (ADR 0184). */
  capabilities?: readonly string[];
  /** What runs its sandboxes and why (ADR 0204), for operators. */
  backend?: EnvironmentBinding["backend"];
  /**
   * Members' sign-ins on this machine (ADR 0199), read again every few
   * seconds: a sign-in made or removed here reaches placement without a
   * restart.
   */
  signIns?: () => readonly string[];
  /**
   * Whose work each worker takes, and who owns a piece of work: an email
   * and directory groups matched against worker access (ADR 0167).
   */
  placement?: {
    workers(): Promise<Map<string, WorkerPlacement>>;
    owner(
      userId: string,
    ): Promise<{ userId: string; groups: readonly string[] } | undefined>;
  };
}) {
  const nodes = new WorkerNodesService(args.db);
  let signIns = args.signIns?.() ?? [];
  const describe = (): EnvironmentBinding => ({
    id: args.nodeId,
    label: args.label,
    description: `Run on ${args.label}`,
    trust: "managed",
    isolation: args.isolation ?? "process",
    workloads: args.workloads ?? ["agent", "workflow"],
    agentTopologies: ["controller"],
    // What this machine's sandboxes can be given (ADR 0176).
    capabilities: [
      "network.egress",
      ...(args.sandboxProvider.capabilities ?? []),
      ...(args.capabilities ?? []),
      ...signIns,
    ],
    resources: {
      cpuMillis: args.capacity?.cpuMillis,
      memoryMb: args.capacity?.memoryMb,
    },
    resourceLimits: args.sandboxProvider.resourceLimits,
    labels: { ...args.labels, node: args.nodeId, plane: "control" },
    ...(args.backend ? { backend: args.backend } : {}),
  });
  // A single server that died without releasing its lease restarts into
  // that lease: wait for it to lapse rather than refuse to boot. A
  // disposable node is new at every start, so nothing holds it.
  const deadline = Date.now() + WORKER_NODE_LEASE_MS + 5_000;
  const register = async (): Promise<{ id: string; token: string }> => {
    try {
      return await nodes.register({
        tenantId: args.tenantId,
        authorityId: args.authorityId,
        descriptor: describe(),
        capacity: args.capacity,
        defaults: args.defaults,
        disposable: args.disposable,
        // A single server holds its own lease while disabled, so its
        // operator API can enable it again.
        evenIfDisabled: !args.disposable,
      });
    } catch (error) {
      if (!(error instanceof WorkerNodeLeaseHeldError) || Date.now() > deadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return register();
    }
  };
  const lease = await register();
  const environmentProvider: EnvironmentProvider = {
    get: async ({
      tenantId,
      projectId,
      ownerUserId,
      pool,
      strict,
      workerNodeId,
      allocationBindingId,
      requirements,
    }) => {
      const candidates = await nodes.list({
        tenantId,
        authorityId: args.authorityId,
      });
      const workerPlacements =
        (await args.placement?.workers()) ?? new Map<string, WorkerPlacement>();
      const owner = ownerUserId
        ? ((await args.placement?.owner(ownerUserId)) ?? {
            userId: ownerUserId,
            groups: [],
          })
        : undefined;
      // Labels are live: the server's own plus the operator's current ones.
      const described = candidates.map((node) => {
        const worker = isWorkerNode(node.id);
        const policy = worker ? workerPlacements.get(node.id) : undefined;
        return {
          node,
          policy,
          worker,
          // A worker's labels are only the operator's current ones, so a
          // removed label stops matching at once.
          labels: {
            ...(worker ? policy?.labels : node.descriptor.labels),
            node: node.id,
            plane: worker ? "worker" : "control",
          },
        };
      });
      const eligible = described.filter(
        ({ node, policy, worker, labels }) =>
          node.available &&
          (!worker || policy) &&
          (!allocationBindingId || allocationBindingId === node.id) &&
          (!workerNodeId || workerNodeId === node.id) &&
          poolMatches(labels, pool) &&
          (!requirements ||
            environmentSatisfies(node.descriptor, requirements).compatible) &&
          // A worker serving several people runs agents in a microVM unless
          // the operator marked those people as trusting each other.
          (!policy ||
            policy.trusted ||
            servesOneOwner(policy.access) ||
            node.descriptor.isolation !== "process"),
      );
      const ordered = placementOrder(
        eligible,
        ({ policy }) =>
          accessTier({
            access: policy ? nodeAccess(policy.access) : { everyone: true },
            owner,
            ...(projectId ? { projectId } : {}),
          }),
        { strict },
      );
      const chosen = ordered.find(
        ({ node }) =>
          allocationBindingId ||
          !node.capacity ||
          capacityFits({
            capacity: node.capacity,
            usage: node.usage,
            resources: { ...node.defaults, ...requirements?.resources },
          }),
      );
      if (!chosen) {
        const full = ordered[0];
        if (full) throw new EnvironmentCapacityError(full.node.id);
        return undefined;
      }
      const selected = {
        ...chosen.node,
        descriptor: { ...chosen.node.descriptor, labels: chosen.labels },
      };
      // A worker whose access names only this owner (a member, or for a
      // project's own work that project) takes no one else's work, so it
      // may hold their personal credentials (ADR 0184) and secrets (ADR
      // 0206).
      const servesOnlyOwner = Boolean(
        chosen.policy &&
          accessTier({
            access: nodeAccess(chosen.policy.access),
            owner,
            ...(projectId ? { projectId } : {}),
          }) === 0,
      );
      return {
        descriptor: selected.descriptor,
        workerNodeId: selected.id,
        ...(servesOnlyOwner ? { servesOnlyOwner } : {}),
        // This process's own machine, or a worker any replica reaches
        // through the operation queue (ADR 0192). Another replica's own
        // machine has no provider here.
        ...(selected.id === lease.id
          ? {
              sandboxProvider: args.sandboxProvider,
              workerLeaseToken: lease.token,
            }
          : selected.remote
            ? {
                sandboxProvider: nodes.remoteProvider({
                  nodeId: selected.id,
                  offer: selected.remote,
                  label: "The worker",
                }),
              }
            : {}),
      };
    },
  };
  let heartbeat: Promise<void> | undefined;
  // Renewing: the lease is current and the node takes work. False while a
  // renewal fails or hangs, and while the node is disabled.
  // A disabled single server starts idle.
  // When the last renewal that landed was sent: the lease runs from then.
  let renewedFrom = performance.now();
  let ready = await nodes.renew({ lease });
  // A disposable node whose lease lapsed or was disabled never renews: it
  // is lost for good, and the process should stop so its orchestrator
  // starts a fresh one (ADR 0190).
  let markLost = () => {};
  const lost = new Promise<void>((resolve) => {
    markLost = resolve;
  });
  let isLost = false;
  // A renewal that never settles (a dead connection) must not hold the
  // heartbeat forever: give up on it after one interval and try again.
  const renew = () =>
    new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Lease renewal timed out")),
        RENEWAL_TIMEOUT_MS,
      );
      nodes
        .renew({ lease })
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timeout);
        });
    });
  const markNodeLost = () => {
    ready = false;
    isLost = true;
    markLost();
  };
  const beat = async (): Promise<void> => {
    const sentAt = performance.now();
    if (await renew()) {
      renewedFrom = sentAt;
      ready = true;
      return;
    }
    ready = false;
    if (args.disposable) {
      markNodeLost();
      return;
    }
    // A single server's identity outlives a lapse (a sleeping laptop, a
    // database outage): it takes its lease again once the old one lapsed,
    // under a new token every holder of `lease` reads. A disabled server
    // keeps its lease and idles until its operator enables it.
    try {
      const next = await register();
      lease.token = next.token;
      const retakenAt = performance.now();
      ready = await renew();
      if (ready) renewedFrom = retakenAt;
    } catch (error) {
      if (!(error instanceof WorkerNodeLeaseHeldError)) throw error;
    }
  };
  const timer = setInterval(() => {
    if (isLost) return;
    // Whatever the database says, a disposable node whose lease could have
    // lapsed is lost: another replica may already be recovering it.
    if (
      args.disposable &&
      performance.now() - renewedFrom > WORKER_NODE_LEASE_MS
    ) {
      markNodeLost();
      return;
    }
    if (heartbeat) {
      // The last renewal has not answered in a whole interval: the
      // database is unreachable or hung.
      ready = false;
      return;
    }
    heartbeat = beat()
      .catch(() => {
        // The database did not answer: not ready until a renewal lands.
        // The lease may still be valid, so this is not a lost node.
        ready = false;
      })
      .finally(() => {
        heartbeat = undefined;
      });
  }, 10_000);
  timer.unref();
  let cleanup: Promise<unknown> | undefined;
  const cleanupTimer = setInterval(() => {
    if (cleanup || !ready) return;
    cleanup = cleanupWorkerAllocations({
      db: args.db,
      workerNode: lease,
      provider: args.sandboxProvider,
    })
      .catch((error) =>
        console.warn("[catamorphic] Workspace cleanup deferred", error),
      )
      .finally(() => {
        cleanup = undefined;
      });
  }, 5_000);
  cleanupTimer.unref();
  // Sign-ins made or removed on this machine update its offer in place,
  // under the lease it holds.
  let refreshing: Promise<unknown> | undefined;
  const signInTimer = setInterval(() => {
    const next = args.signIns?.() ?? [];
    if (refreshing || JSON.stringify(next) === JSON.stringify(signIns)) return;
    signIns = next;
    refreshing = args.db
      .updateTable("worker_nodes")
      .set({ descriptor: JSON.stringify(describe()), updated_at: sql`now()` })
      .where("id", "=", lease.id)
      .where("lease_token", "=", lease.token)
      .execute()
      .catch((error) =>
        console.warn(
          "[catamorphic] Could not refresh this machine's sign-ins",
          error,
        ),
      )
      .finally(() => {
        refreshing = undefined;
      });
  }, 5_000);
  signInTimer.unref();
  let stopping: Promise<void> | undefined;
  return {
    lease,
    nodes,
    environmentProvider,
    /** Renewing its lease and taking work (readiness). */
    ready: () => ready,
    /** The lease is gone for good (liveness): the process should stop. */
    isLost: () => isLost,
    /** Resolves when a disposable node's lease can never be renewed. */
    lost,
    /** Stop renewing and give the lease back; later calls share the first. */
    stop: () =>
      (stopping ??= (async () => {
        clearInterval(timer);
        clearInterval(cleanupTimer);
        clearInterval(signInTimer);
        await Promise.all([heartbeat, cleanup, refreshing]);
        await nodes.release({ lease });
      })()),
  };
}

export function workAuthorityId(publicBase: string): string {
  return `work:${createHash("sha256").update(publicBase).digest("hex").slice(0, 24)}`;
}

/** Derive a separate P-256 signing key without storing private bytes in Postgres. */
export function workPushKeys(secret: string): {
  publicKey: string;
  privateKey: string;
} {
  const ecdh = createECDH("prime256v1");
  for (let counter = 0; counter < 10; counter += 1) {
    const key = createHash("sha256")
      .update(`catamorphic/push/v1/${counter}\0`)
      .update(secret)
      .digest();
    try {
      ecdh.setPrivateKey(key);
      return {
        publicKey: ecdh.getPublicKey().toString("base64url"),
        privateKey: key.toString("base64url"),
      };
    } catch {
      /* Try another derived scalar if it is outside the curve order. */
    }
  }
  throw new Error("Could not derive the deployment's notification signing key");
}
