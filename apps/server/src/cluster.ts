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
import { environmentSatisfies } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";

/** Stock deployment policy. Core only sees leased nodes and runtime bindings. */
export async function registerStockMachine(args: {
  db: Kysely<DB>;
  tenantId: string;
  authorityId: string;
  nodeId: string;
  label: string;
  sandboxProvider: SandboxProvider;
  capacity?: WorkerCapacity;
  defaults?: { cpuMillis?: number; memoryMb?: number };
  isolation?: "process" | "sandbox";
}) {
  const nodes = new WorkerNodesService(args.db);
  const descriptor: EnvironmentBinding = {
    id: args.nodeId,
    label: args.label,
    description: `Run on ${args.label}`,
    trust: "managed",
    isolation: args.isolation ?? "process",
    workloads: ["agent", "workflow"],
    agentTopologies: ["controller"],
    capabilities: ["network.egress"],
    resources: {
      cpuMillis: args.capacity?.cpuMillis,
      memoryMb: args.capacity?.memoryMb,
    },
    resourceLimits: args.sandboxProvider.resourceLimits,
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
      bindingId,
      workerNodeId,
      allocationBindingId,
      requirements,
    }) => {
      const candidates = await nodes.list({
        tenantId,
        authorityId: args.authorityId,
      });
      const selected = candidates.find(
        (node) =>
          node.available &&
          (!requirements ||
            environmentSatisfies(node.descriptor, requirements).compatible) &&
          (allocationBindingId ||
            !node.capacity ||
            capacityFits({
              capacity: node.capacity,
              usage: node.usage,
              resources: { ...node.defaults, ...requirements?.resources },
            })) &&
          (bindingId === "local" || bindingId === node.id) &&
          (!workerNodeId || workerNodeId === node.id),
      );
      if (!selected) {
        const full = candidates.find(
          (node) =>
            node.available &&
            (bindingId === "local" || bindingId === node.id) &&
            (!workerNodeId || workerNodeId === node.id) &&
            (!requirements ||
              environmentSatisfies(node.descriptor, requirements).compatible),
        );
        if (full) throw new EnvironmentCapacityError(full.id);
        return undefined;
      }
      return {
        descriptor: selected.descriptor,
        workerNodeId: selected.id,
        ...(selected.id === lease.id
          ? {
              sandboxProvider: args.sandboxProvider,
              workerLeaseToken: lease.token,
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

export function stockAuthorityId(publicBase: string): string {
  return `stock:${createHash("sha256").update(publicBase).digest("hex").slice(0, 24)}`;
}

export function stockVaultKey(secret: string): Buffer {
  return createHash("sha256")
    .update("catamorphic/vault/v1\0")
    .update(secret)
    .digest();
}

/** Derive a separate P-256 signing key without storing private bytes in Postgres. */
export function stockPushKeys(secret: string): {
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
