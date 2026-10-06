import { randomUUID } from "node:crypto";
import { type DB, migrateToLatest } from "@catamorphic/db";
import type { EnvironmentBinding } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import { environmentSandboxVolumes } from "../services/execution-environments-service.js";
import {
  holdVolumes,
  sweepVolumeHolds,
  temporaryVolumes,
} from "../services/volume-holds.js";

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
