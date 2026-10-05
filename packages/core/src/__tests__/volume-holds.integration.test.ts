import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import {
  type CreateSandboxOpts,
  type EnvironmentBinding,
  type EnvironmentRuntimeBinding,
  environmentSatisfies,
  SANDBOX_CAPABILITIES,
  type SandboxProvider,
  type SandboxVolume,
  volumeKey,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Identity, PROJECT_PRINCIPAL_ID } from "../identity.js";
import {
  allocationSandboxProvider,
  cleanupWorkerAllocations,
  withAllocationSandboxPolicy,
} from "../services/allocation-sandbox-provider.js";
import {
  type EnvironmentSandbox,
  type ExecutionAllocation,
  ExecutionAllocationsService,
} from "../services/execution-allocations-service.js";
import {
  admissionPolicy,
  EnvironmentIncompatibleError,
  ExecutionEnvironmentsService,
} from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import {
  sweepVolumeHolds,
  temporaryVolumes,
  volumeHoldNode,
} from "../services/volume-holds.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

/**
 * Volumes from admission to the sandbox (ADR 0207): keyed per project,
 * owner and name; placed only where machines keep volumes; an exclusive
 * one held for one sandbox per machine at a time, in Postgres, until that
 * sandbox is gone.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_volumes_${randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 4 })
  : undefined;

const tenantId = randomUUID();
const ada: Identity = { tenantId, externalUserId: "ada" };
const bob: Identity = { tenantId, externalUserId: "bob" };

/** A machine recording what each sandbox is created with. */
function recordingProvider() {
  const created: CreateSandboxOpts[] = [];
  const destroyed: string[] = [];
  const provider: SandboxProvider = {
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
  return { provider, created, destroyed };
}

function descriptor(capabilities: string[]): EnvironmentBinding {
  return {
    id: `machine-${capabilities.join("-") || "plain"}`,
    label: "Machine",
    trust: "managed",
    isolation: "sandbox",
    workloads: ["agent"],
    agentTopologies: ["controller"],
    capabilities,
    resources: {},
  };
}

describeIf("volumes and exclusive holds (ADR 0207)", () => {
  let tmpDir: string;
  let projectId: string;
  let projectManager: ProjectManager;
  const allocations = () => new ExecutionAllocationsService(db!);

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-volumes-"));
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "projects")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(ada, { name: "Volumes" })).id;
    const repo = await projectManager.open(tenantId, projectId);
    try {
      await repo.writeFile(
        PROJECT_MANIFEST_PATH,
        JSON.stringify({
          environments: {
            dev: {
              workloads: ["agent"],
              volumes: {
                pnpm: "~/.local/share/pnpm/store",
                docker: {
                  path: "/var/lib/docker",
                  exclusive: true,
                  sizeMb: 20480,
                },
              },
            },
          },
          defaultEnvironment: "dev",
        }),
      );
      await repo.commit("Volumes", {
        name: "Test",
        email: "test@example.com",
      });
    } finally {
      await repo.dispose();
    }
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const environments = (bindings: EnvironmentRuntimeBinding[]) =>
    new ExecutionEnvironmentsService(
      new ProjectEnvironmentsService(db!, projectManager),
      {
        get: ({ requirements }) =>
          bindings.find(
            (binding) =>
              !requirements ||
              environmentSatisfies(binding.descriptor, requirements).compatible,
          ),
      },
    );

  const admit = (
    bindings: EnvironmentRuntimeBinding[],
    identity: Identity,
    owner?: string | null,
  ) =>
    environments(bindings).admit({
      identity,
      projectId,
      environment: "dev",
      ...(owner !== undefined ? { owner } : {}),
      requirements: { workload: "agent", topology: "controller" },
    });

  it("places an Environment with volumes only on a machine that keeps them", async () => {
    const plain = { descriptor: descriptor([]) };
    await expect(admit([plain], ada)).rejects.toSatisfy(
      (error) =>
        error instanceof EnvironmentIncompatibleError ||
        (error instanceof Error && /No machine/.test(error.message)),
    );
    const keeping = { descriptor: descriptor([SANDBOX_CAPABILITIES.volumes]) };
    const admission = await admit([plain, keeping], ada);
    expect(admission.binding.id).toBe(keeping.descriptor.id);
    expect(admission.effectiveRequirements.capabilities).toContain("volumes");
  });

  it("keys volumes by project, owner and name", async () => {
    const keeping = { descriptor: descriptor([SANDBOX_CAPABILITIES.volumes]) };
    const first = await admit([keeping], ada);
    const again = await admit([keeping], ada);
    const bobs = await admit([keeping], bob);
    const projects = await admit([keeping], ada, null);
    expect(first.sandbox.volumes).toEqual([
      {
        name: "docker",
        key: volumeKey({ projectId, owner: "ada", name: "docker" }),
        path: "/var/lib/docker",
        exclusive: true,
        sizeMb: 20480,
      },
      {
        name: "pnpm",
        key: volumeKey({ projectId, owner: "ada", name: "pnpm" }),
        path: "~/.local/share/pnpm/store",
      },
    ]);
    expect(again.sandbox.volumes).toEqual(first.sandbox.volumes);
    const keys = (sandbox: EnvironmentSandbox) =>
      (sandbox.volumes ?? []).map((volume) => volume.key);
    for (const other of [bobs, projects])
      for (const key of keys(other.sandbox))
        expect(keys(first.sandbox)).not.toContain(key);
    expect(keys(projects.sandbox)).toContain(
      volumeKey({ projectId, owner: PROJECT_PRINCIPAL_ID, name: "pnpm" }),
    );
    // The admitted policy keeps them, as every Allocation's snapshot does.
    expect(
      admissionPolicy({ admission: first, connections: [] }).sandbox?.volumes,
    ).toEqual(first.sandbox.volumes);
  });

  it("holds an exclusive volume for one sandbox per machine until that sandbox is destroyed", async () => {
    if (!db) return;
    const keeping = descriptor([SANDBOX_CAPABILITIES.volumes]);
    const nodes = new WorkerNodesService(db);
    const lease = await nodes.register({
      tenantId,
      authorityId: "volumes",
      descriptor: keeping,
    });
    const machine = recordingProvider();
    const adas = (await admit([{ descriptor: keeping }], ada)).sandbox;
    const bobs = (await admit([{ descriptor: keeping }], bob)).sandbox;
    const allocate = async (sandbox: EnvironmentSandbox) => {
      const allocation = await allocations().create({
        identity: ada,
        projectId,
        environmentName: "dev",
        workloadKind: "agent",
        rootWorkloadId: randomUUID(),
        workerNodeId: lease.id,
        policy: {
          binding: keeping,
          requirements: { workload: "agent" },
          sandbox,
        },
      });
      const provider = allocationSandboxProvider({
        db,
        allocation,
        provider: machine.provider,
        workerLeaseToken: lease.token,
      });
      await provider.createSandbox({});
      return allocation;
    };
    const created = () => machine.created.at(-1)?.volumes ?? [];
    const docker = (volumes: readonly SandboxVolume[]) =>
      volumes.find((volume) => volume.path === "/var/lib/docker");

    const first = await allocate(adas);
    expect(created()).toEqual([
      {
        key: volumeKey({ projectId, owner: "ada", name: "docker" }),
        path: "/var/lib/docker",
        exclusive: true,
        sizeMb: 20480,
      },
      {
        key: volumeKey({ projectId, owner: "ada", name: "pnpm" }),
        path: "~/.local/share/pnpm/store",
      },
    ]);
    expect(await temporaryVolumes({ db, allocation: first })).toEqual([]);

    // A second concurrent sandbox of the same owner on the same machine
    // gets an empty temporary copy; the shared one is mounted as usual.
    const second = await allocate(adas);
    expect(docker(created())).toMatchObject({ temporary: true });
    expect(
      created().find((volume) => volume.path.startsWith("~"))?.temporary,
    ).toBeUndefined();
    expect(
      (await temporaryVolumes({ db, allocation: second })).map(
        (volume) => volume.name,
      ),
    ).toEqual(["docker"]);

    // Someone else's volume is their own.
    await allocate(bobs);
    expect(docker(created())?.temporary).toBeUndefined();

    // Released but not yet destroyed, the sandbox may still use it.
    await allocations().release({
      identity: ada,
      allocationId: first.id,
      reason: "idle",
    });
    await allocate(adas);
    expect(docker(created())).toMatchObject({ temporary: true });

    // Cleanup destroys the sandbox and releases its capacity: the hold
    // goes with it, and the next sandbox takes the volume.
    await cleanupWorkerAllocations({
      db,
      workerNode: lease,
      provider: machine.provider,
    });
    expect(machine.destroyed).toContain(
      (
        await db
          .selectFrom("execution_allocations")
          .select("sandbox_provider_id")
          .where("id", "=", first.id)
          .executeTakeFirstOrThrow()
      ).sandbox_provider_id,
    );
    expect(
      await db
        .selectFrom("volume_holds")
        .select("allocation_id")
        .where("allocation_id", "=", first.id)
        .execute(),
    ).toEqual([]);
    const next = await allocate(adas);
    expect(docker(created())?.temporary).toBeUndefined();
    expect(await temporaryVolumes({ db, allocation: next })).toEqual([]);
  });

  it("releases a member machine's hold when its Allocation is released, and sweeps holds whose sandbox is gone", async () => {
    if (!db) return;
    const keeping = descriptor([SANDBOX_CAPABILITIES.volumes]);
    const sandbox = (await admit([{ descriptor: keeping }], ada)).sandbox;
    const runner = randomUUID();
    const machine = recordingProvider();
    const allocate = async (token: string) => {
      const allocation = await allocations().create({
        identity: ada,
        projectId,
        environmentName: "dev",
        workloadKind: "agent",
        rootWorkloadId: randomUUID(),
        policy: {
          binding: { ...keeping, id: `client:${runner}:${token}` },
          requirements: { workload: "agent" },
          sandbox,
        },
      });
      await withAllocationSandboxPolicy({
        db,
        allocation,
        provider: machine.provider,
      }).createSandbox({});
      return allocation;
    };
    const exclusive = () =>
      machine.created.at(-1)?.volumes?.find((volume) => volume.exclusive);

    // A member's runner is one machine, whatever connection it came on.
    const first = await allocate("one");
    expect(volumeHoldNode(first)).toBe(`client:${runner}`);
    expect(exclusive()?.temporary).toBeUndefined();
    await allocate("two");
    expect(exclusive()?.temporary).toBe(true);
    await allocations().release({
      identity: ada,
      allocationId: first.id,
      reason: "connection_ended",
    });
    const after = await allocate("three");
    expect(exclusive()?.temporary).toBeUndefined();

    // A hold left behind by an Allocation whose sandbox is gone (written
    // around the trigger here) is swept, and never blocks a new sandbox.
    const stale: ExecutionAllocation = await allocations().create({
      identity: ada,
      projectId,
      environmentName: "dev",
      workloadKind: "agent",
      rootWorkloadId: randomUUID(),
      policy: {
        binding: { ...keeping, id: "static" },
        requirements: { workload: "agent" },
        sandbox,
      },
    });
    await allocations().release({ identity: ada, allocationId: stale.id });
    await db
      .insertInto("volume_holds")
      .values({
        node: volumeHoldNode(stale),
        volume_key: "stale-000000000000000000000000",
        allocation_id: stale.id,
      })
      .execute();
    expect(await sweepVolumeHolds({ db, node: volumeHoldNode(stale) })).toBe(1);
    expect(await sweepVolumeHolds({ db })).toBe(0);
    // The live hold stays.
    expect(
      await db
        .selectFrom("volume_holds")
        .select("allocation_id")
        .where("allocation_id", "=", after.id)
        .execute(),
    ).toHaveLength(1);
  });
});
