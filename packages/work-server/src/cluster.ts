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
      // `local` is the control plane's own machines, `workers` any enrolled
      // remote worker, and a node id exactly that machine (ADR 0164).
      const bound = (nodeId: string) =>
        bindingId === nodeId ||
        (bindingId === "local" && !isWorkerNode(nodeId)) ||
        (bindingId === "workers" && isWorkerNode(nodeId));
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
          bound(node.id) &&
          (!workerNodeId || workerNodeId === node.id),
      );
      if (!selected) {
        const full = candidates.find(
          (node) =>
            node.available &&
            bound(node.id) &&
            (!workerNodeId || workerNodeId === node.id) &&
            (!requirements ||
              environmentSatisfies(node.descriptor, requirements).compatible),
        );
        if (full) throw new EnvironmentCapacityError(full.id);
        return undefined;
      }
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
