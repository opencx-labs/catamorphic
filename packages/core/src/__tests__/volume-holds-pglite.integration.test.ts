import { randomUUID } from "node:crypto";
import { type DB, migrateToLatest } from "@catamorphic/db";
import type {
  CreateSandboxOpts,
  EnvironmentBinding,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  allocationSandboxProvider,
  cleanupWorkerAllocations,
} from "../services/allocation-sandbox-provider.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { environmentSandboxVolumes } from "../services/execution-environments-service.js";
import {
  holdVolumes,
  sweepVolumeHolds,
  temporaryVolumes,
} from "../services/volume-holds.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

/*
 * Exclusive volume holds on PGlite with a schema plugin (ADR 0208), the
 * Work server's default database: taking, refusing, taking over and
 * sweeping a hold reference the target table and `excluded` correctly.
 */

const schema = "catamorphic_holds";
const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(schema)],
});
const identity: Identity = { tenantId: randomUUID(), externalUserId: "ada" };
const projectId = randomUUID();
const binding: EnvironmentBinding = {
  id: "static",
  label: "Machine",
  trust: "managed",
  isolation: "sandbox",
  workloads: ["agent"],
  agentTopologies: ["controller"],
  capabilities: ["volumes"],
  resources: {},
};

beforeAll(async () => {
  await migrateToLatest({ db, schema });
  await db
    .insertInto("tenants")
    .values({ id: identity.tenantId, name: "Tenant" })
    .execute();
  await db
    .insertInto("projects")
    .values({ id: projectId, tenant_id: identity.tenantId, name: "Holds" })
    .execute();
}, 60_000);

afterAll(async () => {
  await db.destroy();
});

it("holds, refuses, takes over and sweeps exclusive volumes", async () => {
  const allocations = new ExecutionAllocationsService(db);
  const volumes = environmentSandboxVolumes({
    projectId,
    owner: "ada",
    volumes: { docker: { path: "/var/lib/docker", exclusive: true } },
  });
  const allocate = () =>
    allocations.create({
      identity,
      projectId,
      environmentName: "dev",
      workloadKind: "agent",
      rootWorkloadId: randomUUID(),
      policy: {
        binding,
        requirements: { workload: "agent" },
        sandbox: { volumes },
      },
    });
  const first = await allocate();
  expect((await holdVolumes({ db, allocation: first }))[0]?.temporary).toBe(
    undefined,
  );
  // Holding again for the same Allocation keeps its hold.
  expect((await holdVolumes({ db, allocation: first }))[0]?.temporary).toBe(
    undefined,
  );
  const second = await allocate();
  expect((await holdVolumes({ db, allocation: second }))[0]?.temporary).toBe(
    true,
  );
  expect(await temporaryVolumes({ db, allocation: second })).toHaveLength(1);
  // Released on a machine that keeps its own sandboxes: the hold goes.
  await allocations.release({ identity, allocationId: first.id });
  const third = await allocate();
  expect(
    (await holdVolumes({ db, allocation: third }))[0]?.temporary,
  ).toBeUndefined();
  // A hold whose Allocation is gone some other way is taken over and swept.
  await allocations.release({ identity, allocationId: third.id });
  await db
    .insertInto("volume_holds")
    .values({
      node: "binding:static",
      volume_key: volumes[0]?.key ?? "",
      allocation_id: third.id,
    })
    .execute();
  const fourth = await allocate();
  expect(
    (await holdVolumes({ db, allocation: fourth }))[0]?.temporary,
  ).toBeUndefined();
  await db
    .insertInto("volume_holds")
    .values({
      node: "binding:static",
      volume_key: "other-000000000000000000000000",
      allocation_id: third.id,
    })
    .execute();
  expect(await sweepVolumeHolds({ db })).toBe(1);
  expect(await sweepVolumeHolds({ db })).toBe(0);
});

it("takes a released workspace's exclusive volumes over on its machine once nothing runs in it", async () => {
  const allocations = new ExecutionAllocationsService(db);
  const lease = await new WorkerNodesService(db).register({
    tenantId: identity.tenantId,
    authorityId: "holds",
    descriptor: binding,
  });
  const volumes = environmentSandboxVolumes({
    projectId,
    owner: "ada",
    volumes: { docker: { path: "/var/lib/docker", exclusive: true } },
  });
  const created: CreateSandboxOpts[] = [];
  const destroyed: string[] = [];
  const machine: SandboxProvider = {
    workspaceRoot: "/workspace",
    createSandbox: async (opts) => {
      created.push(opts);
      const id = `sandbox-${created.length}`;
      return {
        id,
        providerId: id,
        sandboxType: "execution",
        status: "started",
      };
    },
    destroySandbox: async (id) => {
      destroyed.push(id);
    },
    startSandbox: async () => {},
    stopSandbox: async () => {},
    getSandboxStatus: async () => "started",
    executeCommand: async () => ({ exitCode: 0, result: "" }),
    uploadFiles: async () => {},
    downloadFile: async () => "",
    gitClone: async () => {},
    gitCheckout: async () => {},
  };
  const allocate = async () => {
    const allocation = await allocations.create({
      identity,
      projectId,
      environmentName: "dev",
      workloadKind: "agent",
      rootWorkloadId: randomUUID(),
      workerNodeId: lease.id,
      policy: {
        binding,
        requirements: { workload: "agent" },
        sandbox: { volumes },
      },
    });
    const sandbox = await allocationSandboxProvider({
      db,
      allocation,
      provider: machine,
      workerLeaseToken: lease.token,
    }).createSandbox({});
    return {
      allocation,
      sandboxId: sandbox.providerId,
      temporary: created.at(-1)?.volumes?.[0]?.temporary,
    };
  };
  const capacityReleased = async (allocationId: string) =>
    (
      await db
        .selectFrom("execution_allocations")
        .select("capacity_released_at")
        .where("id", "=", allocationId)
        .executeTakeFirstOrThrow()
    ).capacity_released_at !== null;

  const first = await allocate();
  expect(first.temporary).toBeUndefined();
  // Released while a turn still runs in it: its sandbox keeps the volume.
  const session = await db
    .insertInto("agent_sessions")
    .values({
      project_id: projectId,
      external_user_id: "ada",
      allocation_id: first.allocation.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const turn = await db
    .insertInto("agent_turns")
    .values({
      session_id: session.id,
      ordinal: 1,
      status: "running",
      lease_expires_at: sql<Date>`now() + interval '5 minutes'`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await allocations.release({
    identity,
    allocationId: first.allocation.id,
    reason: "idle",
  });
  const second = await allocate();
  expect(second.temporary).toBe(true);
  expect(destroyed).toEqual([]);

  // Once nothing runs in it, the next sandbox there destroys it first, as
  // its cleanup would in the background, and takes the volume over.
  await db
    .updateTable("agent_turns")
    .set({ status: "completed" })
    .where("id", "=", turn.id)
    .execute();
  const third = await allocate();
  expect(third.temporary).toBeUndefined();
  expect(destroyed).toEqual([first.sandboxId]);
  expect(await capacityReleased(first.allocation.id)).toBe(true);
  expect(await temporaryVolumes({ db, allocation: third.allocation })).toEqual(
    [],
  );

  // The background cleanup retires the rest the same way.
  await allocations.release({ identity, allocationId: second.allocation.id });
  expect(
    await cleanupWorkerAllocations({
      db,
      workerNode: lease,
      provider: machine,
    }),
  ).toBe(1);
  expect(destroyed).toEqual([first.sandboxId, second.sandboxId]);
  expect(await capacityReleased(second.allocation.id)).toBe(true);
});
