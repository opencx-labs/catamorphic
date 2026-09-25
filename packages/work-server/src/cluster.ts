import { createECDH, createHash } from "node:crypto";
import {
  capacityFits,
  cleanupWorkerAllocations,
  EnvironmentCapacityError,
  type WorkerCapacity,
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
import type { Kysely } from "kysely";
import {
  nodeAccess,
  servesOnePerson,
  type WorkerPlacement,
} from "./workers/placement.js";
import { isWorkerNode } from "./workers/worker-registry.js";

/** Work server deployment policy. Core only sees leased nodes and runtime bindings. */
export async function registerWorkMachine(args: {
  db: Kysely<DB>;
  tenantId: string;
  authorityId: string;
  nodeId: string;
  label: string;
  sandboxProvider: SandboxProvider;
  capacity?: WorkerCapacity;
  defaults?: { cpuMillis?: number; memoryMb?: number };
  isolation?: "process" | "sandbox";
  /** Workloads this control-plane machine accepts (ADR 0164). */
  workloads?: ("agent" | "workflow")[];
  /** Operator labels for this control-plane machine (ADR 0167). */
  labels?: Readonly<Record<string, string>>;
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
  /** Remote workers whose leases this instance holds. */
  workers?: {
    heldProvider(
      nodeId: string,
    ):
      | { provider: SandboxProvider; lease: { id: string; token: string } }
      | undefined;
  };
}) {
  const nodes = new WorkerNodesService(args.db);
  const descriptor: EnvironmentBinding = {
    id: args.nodeId,
    label: args.label,
    description: `Run on ${args.label}`,
    trust: "managed",
    isolation: args.isolation ?? "process",
    workloads: args.workloads ?? ["agent", "workflow"],
    agentTopologies: ["controller"],
    capabilities: ["network.egress"],
    resources: {
      cpuMillis: args.capacity?.cpuMillis,
      memoryMb: args.capacity?.memoryMb,
    },
    resourceLimits: args.sandboxProvider.resourceLimits,
    labels: { ...args.labels, node: args.nodeId, plane: "control" },
  };
  const lease = await nodes.register({
    tenantId: args.tenantId,
    authorityId: args.authorityId,
    descriptor,
    capacity: args.capacity,
    defaults: args.defaults,
  });
  const environmentProvider: EnvironmentProvider = {
    get: async ({
      tenantId,
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
            servesOnePerson(policy.access) ||
            node.descriptor.isolation !== "process"),
      );
      const ordered = placementOrder(
        eligible,
        ({ policy }) =>
          accessTier(
            policy ? nodeAccess(policy.access) : { everyone: true },
            owner,
          ),
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
      const remote = args.workers?.heldProvider(selected.id);
      return {
        descriptor: selected.descriptor,
        workerNodeId: selected.id,
        ...(selected.id === lease.id
          ? {
              sandboxProvider: args.sandboxProvider,
              workerLeaseToken: lease.token,
            }
          : remote
            ? {
                sandboxProvider: remote.provider,
                workerLeaseToken: remote.lease.token,
              }
            : {}),
      };
    },
  };
  let heartbeat: Promise<boolean> | undefined;
  let healthy = true;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = nodes
      .renew({ lease })
      .then((owned) => {
        healthy = owned;
        return owned;
      })
      .catch(() => {
        healthy = false;
        return false;
      })
      .finally(() => {
        heartbeat = undefined;
      });
  }, 10_000);
  timer.unref();
  let cleanup: Promise<unknown> | undefined;
  const cleanupTimer = setInterval(() => {
    if (cleanup || !healthy) return;
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
  return {
    lease,
    nodes,
    environmentProvider,
    healthy: () => healthy,
    stop: async () => {
      clearInterval(timer);
      clearInterval(cleanupTimer);
      await Promise.all([heartbeat, cleanup]);
      await nodes.release({ lease });
    },
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
