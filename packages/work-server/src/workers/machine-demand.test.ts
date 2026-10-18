import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Identity,
  projectChatIdentity,
  WorkerNodesService,
} from "@catamorphic/core";
import { generateExecutorKeyPair } from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";
import { installTarget } from "./install-script.js";
import {
  demandName,
  type MachineProvisioner,
  MachineReconciler,
} from "./machine-rules.js";
import {
  type WorkerOffer,
  WorkerOfferSchema,
  WorkWorkerRegistry,
} from "./worker-registry.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * Machines on demand (ADR 0258): a rule creates machines for the work
 * waiting for one, up to its maximum, keeps those holding work, and
 * destroys them once idle. A fake platform records what it was asked;
 * machines enroll and connect through the registry, as a worker does.
 */
let root: string;
let server: WorkServer;
let base: string;
let operatorSecret: string;
let projectId: string;
let registry: WorkWorkerRegistry;
const owner: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "machine-demand-test",
};
type Created = Parameters<MachineProvisioner["create"]>[0];
const platform = {
  created: [] as Created[],
  destroyed: [] as string[],
  /** Machines whose destruction stays under way while listed here. */
  unfinished: new Set<string>(),
};
const provisioner: MachineProvisioner = {
  create: async (args) => {
    platform.created.push(args);
    return { ref: `i-${args.name}` };
  },
  destroy: async ({ name }) => {
    platform.destroyed.push(name);
    return { done: !platform.unfinished.has(name) };
  },
};
const OPTIONS = { instanceType: "m7i.4xlarge", subnet: "subnet-review" };

function operator(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  body?: unknown,
) {
  return server.operatorApp.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}

/**
 * Passes until nothing is left to do: a pass a rule's change or the demand
 * check started may have looked before the test changed something.
 */
async function reconcile() {
  for (let pass = 0; pass < 2; pass += 1) {
    const response = await operator(
      "POST",
      "/_work/operator/machine-rules/reconcile",
    );
    expect(response.statusCode).toBe(200);
  }
}

async function putRule(name: string, rule: unknown) {
  const response = await operator(
    "PUT",
    `/_work/operator/machine-rules/${name}`,
    rule,
  );
  expect(response.statusCode, response.body).toBe(200);
}

async function status() {
  return (await operator("GET", "/_work/operator/machine-rules")).json().status;
}

async function workers(): Promise<
  Array<{ name: string; state: string; revoked: boolean }>
> {
  return (await operator("GET", "/_work/operator/workers")).json().workers;
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const db = () => server.catamorphic.core.db;

/**
 * A chat waiting for a machine, as core records it: its session (served
 * by another replica, so this one's sweep leaves it alone), a queued turn
 * unless `queued` is false, and its wait.
 */
async function waiting(args: {
  pool: Record<string, string>;
  owner?: string;
  requirements?: unknown;
  queued?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await db()
    .insertInto("agent_sessions")
    .values({
      id,
      project_id: projectId,
      external_user_id: args.owner ?? "project",
      authority_host_id: "another-replica",
    })
    .execute();
  if (args.queued !== false)
    await db()
      .insertInto("agent_turns")
      .values({ session_id: id, ordinal: 1, status: "queued" })
      .execute();
  await db()
    .insertInto("placement_waits")
    .values({
      root_workload_id: id,
      tenant_id: SERVER_TENANT_ID,
      project_id: projectId,
      workload_kind: "agent",
      environment_name: "review",
      pool: JSON.stringify(args.pool),
      owner: args.owner ?? null,
      requirements: JSON.stringify(
        args.requirements ?? { resources: {}, capabilities: [] },
      ),
      reason: "capacity",
    })
    .execute();
  return id;
}

async function forgetWaits() {
  await db().deleteFrom("placement_waits").execute();
}

const createdFor = (name: string) =>
  platform.created.find((machine) => machine.name === name);

const nameOf = (rule: string, machineClass: string, index: number) =>
  demandName({
    rule,
    machineClass,
    scope: { projects: [projectId] },
    index,
  });

/** A worker process's epoch: a UUIDv7 (ADR 0192). */
function epoch(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(6) & 0x0f) | 0x70) >>> 0, 6);
  bytes.writeUInt8(((bytes.readUInt8(8) & 0x3f) | 0x80) >>> 0, 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The created machine enrolls with its code, as its worker does first. */
async function enroll(name: string) {
  const made = createdFor(name);
  if (!made) throw new Error(`No machine ${name} was made`);
  const { publicKey } = generateExecutorKeyPair();
  const { nodeId } = await registry.enroll({
    code: made.enrollment.code,
    publicKey,
  });
  return { nodeId, publicKey };
}

/** It enrolls and its worker connects, offering what it says. */
async function connect(name: string, offer: Partial<WorkerOffer> = {}) {
  const { nodeId, publicKey } = await enroll(name);
  await registry.connect({
    nodeId,
    name,
    session: epoch(),
    offer: WorkerOfferSchema.parse({
      isolation: "sandbox",
      workspaceRoot: "/workspaces",
      capacity: { workspaces: 2 },
      ...offer,
    }),
    publicKey,
  });
}

/** Work on a machine: an Allocation holding its capacity. */
async function holdWork(
  name: string,
  reserved: { memoryMb?: number } = {},
): Promise<string> {
  const row = await db()
    .insertInto("execution_allocations")
    .values({
      tenant_id: SERVER_TENANT_ID,
      project_id: projectId,
      environment_name: "review",
      binding_id: `worker.${name}`,
      workload_kind: "agent",
      root_workload_id: randomUUID(),
      worker_node_id: `worker.${name}`,
      policy_snapshot: JSON.stringify({}),
      reserved_memory_mb: reserved.memoryMb ?? 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * The machine's work ended this many minutes ago (and it enrolled before
 * that), by the database's clock.
 */
async function idleFor(name: string, minutes: number) {
  await sql`
    UPDATE execution_allocations
    SET status = 'released', released_at = now() - make_interval(mins => ${minutes}),
        capacity_released_at = now() - make_interval(mins => ${minutes})
    WHERE worker_node_id = ${`worker.${name}`}
  `.execute(db());
  await sql`
    UPDATE work_workers
    SET enrolled_at = now() - make_interval(mins => ${minutes + 1})
    WHERE name = ${name}
  `.execute(db());
}

async function deleteRule(name: string) {
  await operator("DELETE", `/_work/operator/machine-rules/${name}`);
  await forgetWaits();
  await reconcile();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-demand-"));
  const machinesFile = path.join(root, "machines.json");
  fs.writeFileSync(
    machinesFile,
    JSON.stringify({
      classes: {
        "review-16": { platform: "custom", options: OPTIONS },
        "plain-16": { platform: "custom" },
        "small-8": { platform: "custom" },
        "big-64": { platform: "custom" },
        office: { platform: "pool" },
      },
    }),
  );
  const dataDir = path.join(root, "control-plane");
  server = await createWorkServer({
    ...testServerOptions({
      dataDir,
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_MACHINES_CONFIG: machinesFile,
        PATH: process.env.PATH,
      },
    }),
    hooks: { machineProvisioner: provisioner },
  });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  base = `http://127.0.0.1:${address.port}`;
  operatorSecret = fs
    .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
    .trim();
  registry = new WorkWorkerRegistry({
    db: db(),
    nodes: new WorkerNodesService(db()),
    tenantId: SERVER_TENANT_ID,
    authorityId: fs.readFileSync(path.join(dataDir, "host-id"), "utf8").trim(),
  });
  const project = await server.catamorphic.core.projects.create(owner, {
    name: "Reviews",
  });
  projectId = project.id;
  await server.catamorphic.core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    owner.externalUserId,
    {
      message: "Review machines",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            review: {
              pool: { pool: "live" },
              workloads: ["agent"],
              waitMinutes: 30,
            },
          },
          defaultEnvironment: "review",
        }),
      },
    },
  );
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("machines on demand (ADR 0258)", () => {
  it("refuses rules that cannot scale with demand", async () => {
    const put = (rule: unknown) =>
      operator("PUT", "/_work/operator/machine-rules/bad", rule);
    const demand = { demand: { max: 2 } };
    const refused = [
      // Pooled machines are enrolled by an operator, not created.
      [{ projects: [randomUUID()], machines: demand, class: "office" }, "pool"],
      [
        {
          group: "eng@example.com",
          projects: [randomUUID()],
          machines: demand,
          class: "review-16",
        },
        "either a group or projects",
      ],
      [{ machines: demand, class: "review-16" }, "either a group or projects"],
      [
        {
          projects: [randomUUID()],
          machines: { shared: 1 },
          class: "review-16",
        },
        "Only machines on demand serve projects",
      ],
      [
        {
          projects: [randomUUID()],
          machines: demand,
          class: "review-16",
          retainDays: 3,
        },
        "leave out retainDays",
      ],
      [
        {
          projects: [randomUUID()],
          machines: { demand: { max: 1, min: 2 } },
          class: "review-16",
        },
        "min may not be more than max",
      ],
      [
        {
          projects: [randomUUID()],
          machines: { demand: { max: 101 } },
          class: "review-16",
        },
        "max",
      ],
    ] as const;
    for (const [rule, why] of refused) {
      const response = await put(rule);
      expect(response.statusCode, JSON.stringify(rule)).toBe(400);
      expect(response.json().error).toContain(why);
    }
  });

  it("refuses an untrusted rule for several owners on machines known to run plain processes", async () => {
    // A machine of the class serving one project connects with processes.
    await putRule("plain", {
      projects: [projectId],
      machines: { demand: { max: 1, min: 1 } },
      class: "plain-16",
      labels: { pool: "plain" },
    });
    await reconcile();
    await connect(nameOf("plain", "plain-16", 1), { isolation: "process" });
    const group = await operator("PUT", "/_work/operator/machine-rules/team", {
      group: "eng@example.com",
      machines: { demand: { max: 2 } },
      class: "plain-16",
    });
    expect(group.statusCode).toBe(400);
    expect(group.json().error).toContain("plain processes");
    await putRule("team", {
      group: "eng@example.com",
      machines: { demand: { max: 2 } },
      class: "plain-16",
      trusted: true,
    });
    await operator("DELETE", "/_work/operator/machine-rules/team");
    await deleteRule("plain");
  });

  it("creates machines for waiting work up to its maximum, sized for that work", async () => {
    await putRule("burst", {
      projects: [projectId],
      machines: { demand: { max: 2 } },
      class: "review-16",
      labels: { pool: "burst" },
    });
    expect(
      (await operator("GET", "/_work/operator/machine-rules")).json().rules
        .burst,
    ).toMatchObject({
      machines: {
        demand: { max: 2, min: 0, idleMinutes: 10, enrollMinutes: 15 },
      },
      retainDays: 0,
    });
    const needs = {
      resources: { cpuMillis: 16_000, memoryMb: 65_536 },
      capabilities: ["containers"],
    };
    for (let index = 0; index < 3; index += 1)
      await waiting({ pool: { pool: "burst" }, requirements: needs });
    // Neither another pool's work nor a member's is this rule's, nor work
    // with nothing queued any more.
    await waiting({ pool: { pool: "other" } });
    await waiting({ pool: { pool: "burst" }, owner: "someone" });
    await waiting({ pool: { pool: "burst" }, queued: false });
    await reconcile();

    const names = [1, 2].map((index) => nameOf("burst", "review-16", index));
    expect(
      platform.created
        .filter((machine) => machine.rule === "burst")
        .map((machine) => machine.name),
    ).toEqual(names);
    const first = createdFor(names[0] ?? "");
    expect(first).toMatchObject({
      rule: "burst",
      class: "review-16",
      options: OPTIONS,
      waiting: needs,
      labels: { pool: "burst", class: "review-16" },
    });
    // Idempotent per code, never per name, which a later machine reuses.
    expect(first?.enrollment.idempotencyKey).toBe(
      createHash("sha256")
        .update(first?.enrollment.code ?? "")
        .digest("hex"),
    );
    expect((await status()).burst).toMatchObject({
      desired: 2,
      starting: 2,
      queued: 3,
    });
    // A machine still enrolling covers one piece of work; at the maximum
    // nothing more is made.
    await reconcile();
    expect(
      platform.created.filter((machine) => machine.rule === "burst"),
    ).toHaveLength(2);
    await deleteRule("burst");
  });

  it("waits for a machine that enrolled to connect, and stops making machines when one never does", async () => {
    await putRule("slow", {
      projects: [projectId],
      machines: { demand: { max: 3, enrollMinutes: 5 } },
      class: "review-16",
      labels: { pool: "slow" },
    });
    await waiting({ pool: { pool: "slow" } });
    await reconcile();
    const made = () =>
      platform.created.filter((machine) => machine.rule === "slow").length;
    const [first, second] = [1, 2].map((index) =>
      nameOf("slow", "review-16", index),
    );
    if (!first || !second) throw new Error("Two names");
    // Enrolled, its worker is still starting: neither lost nor replaced,
    // and its work gets no second machine.
    await enroll(first);
    await reconcile();
    expect(platform.destroyed).not.toContain(first);
    expect(createdFor(second)).toBeUndefined();

    // Six minutes pass and it never connects, within the rule's five.
    await sql`
      UPDATE work_machine_rules SET updated_at = now() - interval '10 minutes'
      WHERE name = 'slow'
    `.execute(db());
    await sql`
      UPDATE work_workers SET enrolled_at = now() - interval '6 minutes'
      WHERE name = ${first}
    `.execute(db());
    await reconcile();
    expect(platform.destroyed).toContain(first);
    expect(made()).toBe(1);
    expect((await status()).slow.problem).toContain(
      `Machine ${first} enrolled but did not connect within 5 minutes`,
    );
    // Written again (its cause fixed), the rule makes machines again.
    await putRule("slow", {
      projects: [projectId],
      machines: { demand: { max: 3, enrollMinutes: 5 } },
      class: "review-16",
      labels: { pool: "slow" },
    });
    await reconcile();
    expect(made()).toBe(2);
    await deleteRule("slow");
  });

  it("keeps a machine while it holds work, and destroys it once idle", async () => {
    await putRule("busy", {
      projects: [projectId],
      machines: { demand: { max: 1 } },
      class: "review-16",
      labels: { pool: "busy" },
    });
    await waiting({ pool: { pool: "busy" } });
    await reconcile();
    const name = nameOf("busy", "review-16", 1);
    await connect(name);
    // Its work landed: nothing waits, and the machine holds it.
    await forgetWaits();
    await holdWork(name);
    await reconcile();
    expect(platform.destroyed).not.toContain(name);
    expect((await status()).busy).toMatchObject({ desired: 1, ready: 1 });

    // Idle for less than its rule's ten minutes: kept.
    await idleFor(name, 5);
    await reconcile();
    expect(platform.destroyed).not.toContain(name);

    await idleFor(name, 11);
    await reconcile();
    expect(platform.destroyed).toContain(name);
    expect(await workers()).toContainEqual(
      expect.objectContaining({ name, revoked: true, state: "revoked" }),
    );
    expect((await status()).busy).toMatchObject({ desired: 0, queued: 0 });
    await deleteRule("busy");
  });

  it("keeps the most recently idle machines warm up to its minimum", async () => {
    await putRule("warm", {
      projects: [projectId],
      machines: { demand: { max: 3, min: 1 } },
      class: "review-16",
      labels: { pool: "warm" },
    });
    // Nothing waits: one machine is made, to be ready.
    await reconcile();
    const [first, second] = [1, 2].map((index) =>
      nameOf("warm", "review-16", index),
    );
    if (!first || !second) throw new Error("Two names");
    expect(createdFor(first)?.waiting).toBeUndefined();
    await connect(first);
    // Work comes, and more than it has room for: a second machine.
    await holdWork(first);
    await holdWork(first);
    await waiting({ pool: { pool: "warm" } });
    await reconcile();
    await connect(second);
    await forgetWaits();
    // Both idle long past ten minutes: the one idle for less time stays.
    await idleFor(first, 40);
    await idleFor(second, 20);
    await reconcile();
    expect(platform.destroyed).toContain(first);
    expect(platform.destroyed).not.toContain(second);
    expect((await status()).warm).toMatchObject({ desired: 1, ready: 1 });
    await deleteRule("warm");
    expect(platform.destroyed).toContain(second);
  });

  it("replaces a machine that does not enroll in time", async () => {
    await putRule("late", {
      projects: [projectId],
      machines: { demand: { max: 1, enrollMinutes: 5 } },
      class: "review-16",
      labels: { pool: "late" },
    });
    await waiting({ pool: { pool: "late" } });
    await reconcile();
    const [first, second] = [1, 2].map((index) =>
      nameOf("late", "review-16", index),
    );
    if (!first || !second) throw new Error("Two names");
    const code = await db()
      .selectFrom("work_worker_enrollments")
      .select(
        sql<number>`extract(epoch from (expires_at - now())) / 60`.as(
          "minutes",
        ),
      )
      .where("name", "=", first)
      .executeTakeFirstOrThrow();
    expect(Number(code.minutes)).toBeCloseTo(5, 0);
    await sql`
      UPDATE work_worker_enrollments SET expires_at = now() - interval '1 second'
      WHERE name = ${first}
    `.execute(db());
    await reconcile();
    expect(platform.destroyed).toContain(first);
    expect(createdFor(second)).toBeDefined();
    await deleteRule("late");
  });

  it("keeps destroying a machine until its platform says it is gone", async () => {
    await putRule("gone", {
      projects: [projectId],
      machines: { demand: { max: 1 } },
      class: "review-16",
      labels: { pool: "gone" },
    });
    await waiting({ pool: { pool: "gone" } });
    await reconcile();
    const name = nameOf("gone", "review-16", 1);
    expect(createdFor(name)).toBeDefined();
    // No work waits any more and the platform is slow to let the machine go.
    platform.unfinished.add(name);
    await forgetWaits();
    await operator("DELETE", "/_work/operator/machine-rules/gone");
    await reconcile();
    const listed = async () =>
      (await registry.machines()).some((machine) => machine.name === name);
    // Asked on every pass, and kept until it is done.
    expect(
      platform.destroyed.filter((entry) => entry === name).length,
    ).toBeGreaterThan(1);
    expect(await listed()).toBe(true);
    platform.unfinished.delete(name);
    await reconcile();
    expect(await listed()).toBe(false);
  });

  it("leaves work its machines cannot take to a rule whose machines can", async () => {
    // A rule of small machines, first by name, and one of big machines.
    for (const [rule, machineClass] of [
      ["fit-a", "small-8"],
      ["fit-b", "big-64"],
    ] as const)
      await putRule(rule, {
        projects: [projectId],
        machines: { demand: { max: 4 } },
        class: machineClass,
        labels: { pool: "fit" },
      });
    await waiting({
      pool: { pool: "fit" },
      requirements: { resources: { memoryMb: 65_536 }, capabilities: [] },
    });
    await reconcile();
    const small = nameOf("fit-a", "small-8", 1);
    expect(createdFor(small)).toBeDefined();
    // The small machine comes up with 8 GB: the work is not its rule's.
    await connect(small, {
      capacity: { workspaces: 2, memoryMb: 8_192 },
      resourceLimits: ["memoryMb"],
    });
    await reconcile();
    expect(createdFor(nameOf("fit-a", "small-8", 2))).toBeUndefined();
    const current = await status();
    expect(current["fit-a"]).toMatchObject({ queued: 0 });
    expect(current["fit-a"].problem).toContain("do not offer");
    expect(current["fit-b"]).toMatchObject({ queued: 1, desired: 1 });
    expect(createdFor(nameOf("fit-b", "big-64", 1))).toBeDefined();
    await operator("DELETE", "/_work/operator/machine-rules/fit-a");
    await deleteRule("fit-b");
  });

  it("charges work that names no resources what its machine charges by default", async () => {
    await putRule("dflt", {
      projects: [projectId],
      machines: { demand: { max: 3 } },
      class: "review-16",
      labels: { pool: "dflt" },
    });
    await waiting({ pool: { pool: "dflt" } });
    await reconcile();
    const [first, second] = [1, 2].map((index) =>
      nameOf("dflt", "review-16", index),
    );
    if (!first || !second) throw new Error("Two names");
    // Its one workspace's worth of memory is taken: room for no more.
    await connect(first, {
      capacity: { workspaces: 4, memoryMb: 16_384 },
      defaults: { memoryMb: 16_384 },
    });
    await holdWork(first, { memoryMb: 16_384 });
    await reconcile();
    expect(createdFor(second)).toBeDefined();
    await deleteRule("dflt");
  });

  it("counts the machines a rule served before against its maximum", async () => {
    await putRule("scope", {
      projects: [projectId],
      machines: { demand: { max: 2 } },
      class: "review-16",
      labels: { pool: "scope" },
    });
    await waiting({ pool: { pool: "scope" } });
    await waiting({ pool: { pool: "scope" } });
    await reconcile();
    const before = [1, 2].map((index) => nameOf("scope", "review-16", index));
    for (const name of before) {
      await connect(name);
      await holdWork(name);
    }
    // It now serves another project too: the old machines finish their
    // work, and until they go no more than two machines exist.
    const other = randomUUID();
    await putRule("scope", {
      projects: [projectId, other],
      machines: { demand: { max: 2 } },
      class: "review-16",
      labels: { pool: "scope" },
    });
    await reconcile();
    const after = demandName({
      rule: "scope",
      machineClass: "review-16",
      scope: { projects: [projectId, other] },
      index: 1,
    });
    expect(createdFor(after)).toBeUndefined();
    for (const name of before) await idleFor(name, 1);
    await reconcile();
    expect(platform.destroyed).toEqual(expect.arrayContaining(before));
    expect(createdFor(after)).toBeDefined();
    await deleteRule("scope");
  });

  it("starts a pass when demand changed since a pass last looked", async () => {
    const reconciler = new MachineReconciler({
      db: db(),
      tenantId: SERVER_TENANT_ID,
      workers: registry,
      classes: { "review-16": { platform: "custom" } },
      provisioner,
      install: installTarget({ publicBase: base }),
      controlPlaneUrl: base,
      emailOf: async () => undefined,
    });
    const passes = vi
      .spyOn(reconciler, "reconcileSoon")
      .mockImplementation(() => {});
    /** A pass of this reconciler, once the server's is out of the way. */
    const pass = async () => {
      for (;;) {
        if (!(await reconciler.reconcile()).busy) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    // Without a rule on demand, nothing is watched.
    await waiting({ pool: { pool: "quiet" } });
    await reconciler.checkDemand();
    expect(passes).not.toHaveBeenCalled();
    await db()
      .insertInto("work_machine_rules")
      .values({
        name: "quiet",
        tenant_id: SERVER_TENANT_ID,
        definition: JSON.stringify({
          projects: [projectId],
          machines: { demand: { max: 1 } },
          class: "review-16",
          labels: { pool: "quiet" },
        }),
      })
      .execute();
    await pass();
    // Nothing changed since that pass: no pass.
    await reconciler.checkDemand();
    expect(passes).not.toHaveBeenCalled();
    // More work waits. Until a pass sees it, every look asks for one: a
    // pass already running, or another replica's, may have missed it.
    await waiting({ pool: { pool: "quiet" } });
    await reconciler.checkDemand();
    await reconciler.checkDemand();
    expect(passes).toHaveBeenCalledTimes(2);
    await pass();
    await reconciler.checkDemand();
    expect(passes).toHaveBeenCalledTimes(2);
    await deleteRule("quiet");
  });

  it("serves a group's members, and nobody else", async () => {
    const created = await operator("POST", "/_work/operator/users", {
      username: "ada",
      name: "Ada",
      password: "correct horse battery staple",
      email: "ada@example.com",
      memberships: [],
    });
    const ada: string = created.json().user.id;
    await sql`
      INSERT INTO work_accounts (user_id, directory_groups, directory_checked_at)
      VALUES (${ada}, ${JSON.stringify(["eng@example.com"])}::jsonb, now())
    `.execute(db());
    await putRule("desks", {
      group: "eng@example.com",
      machines: { demand: { max: 4 } },
      class: "review-16",
      labels: { pool: "desks" },
    });
    await waiting({ pool: { pool: "desks" }, owner: ada });
    await waiting({ pool: { pool: "desks" }, owner: "not-in-the-group" });
    // A project's own work is not a group's.
    await waiting({ pool: { pool: "desks" } });
    await reconcile();
    expect((await status()).desks).toMatchObject({ queued: 1, desired: 1 });
    const name = demandName({
      rule: "desks",
      machineClass: "review-16",
      scope: { group: "eng@example.com" },
      index: 1,
    });
    expect(createdFor(name)).toMatchObject({
      labels: { pool: "desks", class: "review-16" },
    });
    await deleteRule("desks");
  });

  it("creates a machine for a waiting project chat, runs the chat there, and destroys the machine once idle", async () => {
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    await putRule("live", {
      projects: [projectId],
      machines: { demand: { max: 1, idleMinutes: 1 } },
      class: "review-16",
      labels: { pool: "live" },
    });
    // No machine is open to the project's chats: the chat waits.
    const project = projectChatIdentity({
      tenantId: SERVER_TENANT_ID,
      projectId,
    });
    const chat = await sessions.chatForKey(project, projectId, {
      key: "pr-42",
      environment: "review",
    });
    expect(
      (await sessions.get(project, projectId, chat.sessionId)).allocationId,
    ).toBeNull();
    const sent = await sessions.command(project, projectId, chat.sessionId, {
      type: "send",
      commandId: randomUUID(),
      text: "execution-location",
    });
    const turnId = String(sent.result?.turnId ?? "");
    const name = nameOf("live", "review-16", 1);
    await waitFor(async () => {
      await reconcile();
      return Boolean(createdFor(name));
    }, "the machine to be created");
    const made = createdFor(name);
    if (!made) throw new Error("No machine was made");

    // The machine comes up and enrolls with its code, as cloud-init would.
    const dataDir = path.join(root, name);
    const worker = await startWorkWorker({
      controlPlaneUrl: base,
      dataDir,
      enrollmentCode: made.enrollment.code,
      execution: executionSettingsFromEnv({
        WORK_SANDBOX: "local-process",
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "1",
      }),
    });
    try {
      await waitFor(async () => {
        const row = await db()
          .selectFrom("agent_turns")
          .select("status")
          .where("id", "=", turnId)
          .executeTakeFirstOrThrow();
        return row.status === "completed";
      }, "the chat's turn to run on the new machine");
      const reply = await db()
        .selectFrom("agent_items")
        .select("text")
        .where("turn_id", "=", turnId)
        .where("kind", "=", "assistant_message")
        .orderBy("position", "desc")
        .executeTakeFirstOrThrow();
      expect(reply.text).toContain(path.join(dataDir, "sandboxes"));
      // Holding the chat's workspace, it stays.
      await reconcile();
      expect(platform.destroyed).not.toContain(name);

      // The pull request merged: its chat closes and gives the machine back.
      await sessions.close(project, projectId, chat.sessionId);
      await waitFor(async () => {
        const held = await db()
          .selectFrom("execution_allocations")
          .select("id")
          .where("worker_node_id", "=", `worker.${name}`)
          .where("capacity_released_at", "is", null)
          .execute();
        return held.length === 0;
      }, "the workspace to be given back");
      await idleFor(name, 2);
      await waitFor(async () => {
        await reconcile();
        return platform.destroyed.includes(name);
      }, "the idle machine to be destroyed");
      expect(await workers()).toContainEqual(
        expect.objectContaining({ name, revoked: true }),
      );
    } finally {
      await worker.stop();
    }
  }, 120_000);
});
