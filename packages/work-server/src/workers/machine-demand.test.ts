import { randomUUID } from "node:crypto";
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
import { WORKER_PROTOCOL, WORKER_PROTOCOL_HEADER } from "./worker-protocol.js";
import { WorkWorkerRegistry } from "./worker-registry.js";
import { startWorkWorker } from "./worker-runtime.js";

/** What every worker call states (ADR 0198). */
const PROTOCOL = { [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server) };

/**
 * Machines on demand (ADR 0258): a rule creates machines for the work
 * waiting for one, up to its maximum, keeps those holding work, and
 * destroys them once idle. A fake platform records what it was asked.
 */
let root: string;
let server: WorkServer;
let base: string;
let operatorSecret: string;
let projectId: string;
const owner: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "machine-demand-test",
};
type Created = Parameters<MachineProvisioner["create"]>[0];
const platform = { created: [] as Created[], destroyed: [] as string[] };
const provisioner: MachineProvisioner = {
  create: async (args) => {
    platform.created.push(args);
    return { ref: `i-${args.name}` };
  },
  destroy: async ({ name }) => {
    platform.destroyed.push(name);
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

/** A piece of work waiting for a machine, as core records it. */
async function waiting(args: {
  pool: Record<string, string>;
  owner?: string;
  requirements?: unknown;
}): Promise<string> {
  const id = randomUUID();
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

async function enroll(code: string) {
  const enrolled = await server.app.inject({
    method: "POST",
    url: "/api/workers/enroll",
    headers: PROTOCOL,
    payload: { code, publicKey: generateExecutorKeyPair().publicKey },
  });
  expect(enrolled.statusCode).toBe(200);
}

const createdFor = (name: string) =>
  platform.created.find((machine) => machine.name === name);

/** Work on a machine: an Allocation holding its capacity. */
async function holdWork(name: string): Promise<string> {
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
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The machine has been idle this long, by the database's clock. */
async function idleFor(name: string, minutes: number) {
  await sql`
    UPDATE execution_allocations
    SET status = 'released', released_at = now() - make_interval(mins => ${minutes}),
        capacity_released_at = now() - make_interval(mins => ${minutes})
    WHERE worker_node_id = ${`worker.${name}`}
  `.execute(db());
  await sql`
    UPDATE work_workers
    SET enrolled_at = now() - make_interval(mins => ${minutes + 60}),
        last_seen_at = now()
    WHERE name = ${name}
  `.execute(db());
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-demand-"));
  const machinesFile = path.join(root, "machines.json");
  fs.writeFileSync(
    machinesFile,
    JSON.stringify({
      classes: {
        "review-16": { platform: "custom", options: OPTIONS },
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

  it("creates machines for waiting work up to its maximum, sized for that work", async () => {
    const stored = await operator(
      "PUT",
      "/_work/operator/machine-rules/burst",
      {
        projects: [projectId],
        machines: { demand: { max: 2 } },
        class: "review-16",
        labels: { pool: "burst" },
      },
    );
    expect(stored.statusCode).toBe(200);
    expect(stored.json().rule).toMatchObject({
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
    // Neither another pool's work nor a member's is this rule's.
    await waiting({ pool: { pool: "other" } });
    await waiting({ pool: { pool: "burst" }, owner: "someone" });
    await reconcile();

    const names = [1, 2].map((index) =>
      demandName({
        rule: "burst",
        machineClass: "review-16",
        scope: { projects: [projectId] },
        index,
      }),
    );
    expect(platform.created.map((machine) => machine.name)).toEqual(names);
    expect(createdFor(names[0] ?? "")).toMatchObject({
      rule: "burst",
      class: "review-16",
      options: OPTIONS,
      waiting: needs,
      labels: { pool: "burst", class: "review-16" },
    });
    expect((await status()).burst).toMatchObject({
      desired: 2,
      starting: 2,
      queued: 3,
    });
    // A machine still enrolling covers one piece of work; at the maximum
    // nothing more is made.
    await reconcile();
    expect(platform.created).toHaveLength(2);
    await operator("DELETE", "/_work/operator/machine-rules/burst");
    await forgetWaits();
    await reconcile();
  });

  it("keeps a machine while it holds work, and destroys it once idle", async () => {
    await operator("PUT", "/_work/operator/machine-rules/busy", {
      projects: [projectId],
      machines: { demand: { max: 1 } },
      class: "review-16",
      labels: { pool: "busy" },
    });
    await waiting({ pool: { pool: "busy" } });
    await reconcile();
    const name = demandName({
      rule: "busy",
      machineClass: "review-16",
      scope: { projects: [projectId] },
      index: 1,
    });
    const made = createdFor(name);
    if (!made) throw new Error("No machine was made");
    await enroll(made.enrollment.code);
    // Its work landed: nothing waits, and the machine holds it.
    await forgetWaits();
    await holdWork(name);
    await sql`UPDATE work_workers SET last_seen_at = now() WHERE name = ${name}`.execute(
      db(),
    );
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
    await operator("DELETE", "/_work/operator/machine-rules/busy");
  });

  it("keeps the most recently idle machines warm up to its minimum", async () => {
    await operator("PUT", "/_work/operator/machine-rules/warm", {
      projects: [projectId],
      machines: { demand: { max: 3, min: 1 } },
      class: "review-16",
      labels: { pool: "warm" },
    });
    // Nothing waits: one machine is made, to be ready.
    await reconcile();
    const [first, second] = [1, 2].map((index) =>
      demandName({
        rule: "warm",
        machineClass: "review-16",
        scope: { projects: [projectId] },
        index,
      }),
    );
    if (!first || !second) throw new Error("Two names");
    const warm = createdFor(first);
    expect(warm).toBeDefined();
    expect(warm?.waiting).toBeUndefined();
    await enroll(warm?.enrollment.code ?? "");
    // Work comes: a second machine.
    await waiting({ pool: { pool: "warm" } });
    await reconcile();
    const extra = createdFor(second);
    if (!extra) throw new Error("No second machine");
    await enroll(extra.enrollment.code);
    await forgetWaits();
    // Both idle long past ten minutes: the one idle for less time stays.
    await idleFor(first, 40);
    await idleFor(second, 20);
    await reconcile();
    expect(platform.destroyed).toContain(first);
    expect(platform.destroyed).not.toContain(second);
    expect((await status()).warm).toMatchObject({ desired: 1, ready: 1 });
    await operator("DELETE", "/_work/operator/machine-rules/warm");
    await reconcile();
    expect(platform.destroyed).toContain(second);
  });

  it("replaces a machine that does not enroll in time", async () => {
    await operator("PUT", "/_work/operator/machine-rules/late", {
      projects: [projectId],
      machines: { demand: { max: 1, enrollMinutes: 5 } },
      class: "review-16",
      labels: { pool: "late" },
    });
    await waiting({ pool: { pool: "late" } });
    await reconcile();
    const [first, second] = [1, 2].map((index) =>
      demandName({
        rule: "late",
        machineClass: "review-16",
        scope: { projects: [projectId] },
        index,
      }),
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
    await operator("DELETE", "/_work/operator/machine-rules/late");
    await forgetWaits();
    await reconcile();
  });

  it("starts a pass only when demand changed", async () => {
    const reconciler = new MachineReconciler({
      db: db(),
      tenantId: SERVER_TENANT_ID,
      workers: new WorkWorkerRegistry({
        db: db(),
        nodes: new WorkerNodesService(db()),
        tenantId: SERVER_TENANT_ID,
        authorityId: "demand-check",
      }),
      classes: { "review-16": { platform: "custom" } },
      provisioner,
      install: installTarget({ publicBase: base }),
      controlPlaneUrl: base,
      emailOf: async () => undefined,
    });
    const passes = vi
      .spyOn(reconciler, "reconcileSoon")
      .mockImplementation(() => {});
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
    await reconciler.checkDemand();
    expect(passes).toHaveBeenCalledTimes(1);
    // Nothing changed: no pass.
    await reconciler.checkDemand();
    expect(passes).toHaveBeenCalledTimes(1);
    // More work waits.
    await waiting({ pool: { pool: "quiet" } });
    await reconciler.checkDemand();
    expect(passes).toHaveBeenCalledTimes(2);
    // Work was placed.
    await forgetWaits();
    await reconciler.checkDemand();
    expect(passes).toHaveBeenCalledTimes(3);
    await db()
      .deleteFrom("work_machine_rules")
      .where("name", "=", "quiet")
      .execute();
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
    await operator("PUT", "/_work/operator/machine-rules/desks", {
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
    await operator("DELETE", "/_work/operator/machine-rules/desks");
    await forgetWaits();
    await reconcile();
  });

  it("creates a machine for a waiting project chat, runs the chat there, and destroys the machine once idle", async () => {
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    await operator("PUT", "/_work/operator/machine-rules/live", {
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
    const name = demandName({
      rule: "live",
      machineClass: "review-16",
      scope: { projects: [projectId] },
      index: 1,
    });
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
