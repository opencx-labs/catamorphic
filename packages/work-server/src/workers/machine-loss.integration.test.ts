import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type Identity,
  releaseReplicaClaim,
  takeReplicaClaim,
} from "@catamorphic/core";
import { sql } from "kysely";
import { expect, it } from "vitest";
import type {
  DesiredMachine,
  MachinePlanFacts,
  MachinesHook,
} from "../machines/contract.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import {
  createTestDatabase,
  enqueue as enqueueMessage,
  testExecutionSettings,
  testServerOptions,
} from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

/*
 * Every lost machine recovers (ADRs 0346, 0347), and machines stop and
 * resume (ADR 0348), end to end on network Postgres with real workers
 * running local processes, a machines hook whose plan a test writes, and a
 * fake platform. Nothing here asks the server to act: its own timers plan,
 * detect a loss, retire the machine's work, replace it and continue its
 * chats. The operator API is used to set up, to read status, and where a
 * test is about an operator's own action (a revoke, a disable).
 */

/** The runner's internal words, which no chat may ever show. */
const SANDBOX_UNKNOWN_ERROR =
  "Sandbox does not belong to this runner connection";

const OPERATOR_SECRET = "loss-test-operator-secret-with-32-characters";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Plan = (facts: MachinePlanFacts) => readonly DesiredMachine[];
type Worker = Awaited<ReturnType<typeof startWorkWorker>>;

interface PlatformEvent {
  kind: "create" | "destroy" | "stop" | "start";
  name: string;
  /** A create's enrollment code and idempotency key. */
  code?: string;
  key?: string;
}

/** A server, a member with a project, and a platform that records calls. */
async function fleet(run: (fleet: Fleet) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-loss-"));
  const database = await createTestDatabase("work_loss");
  const workers: Worker[] = [];
  const platform: PlatformEvent[] = [];
  // The host's policy is code: each test writes the plan it is about.
  const policy: { plan: Plan } = { plan: () => [] };
  const refs = new Map<string, string>();
  const hook: MachinesHook = {
    plan: async (facts) => policy.plan(facts),
    create: async ({ name, enrollment }) => {
      // Idempotent by key, as a platform's idempotency token makes it.
      const known = refs.get(enrollment.idempotencyKey);
      if (known) return { ref: known };
      platform.push({
        kind: "create",
        name,
        code: enrollment.code,
        key: enrollment.idempotencyKey,
      });
      const ref = `vm-${name}-${platform.length}`;
      refs.set(enrollment.idempotencyKey, ref);
      return { ref };
    },
    destroy: async ({ name }) => {
      platform.push({ kind: "destroy", name });
      return { done: true };
    },
    stop: async ({ name }) => {
      platform.push({ kind: "stop", name });
      return { done: true };
    },
    start: async ({ name }) => {
      platform.push({ kind: "start", name });
      return { done: true };
    },
  };
  let server: WorkServer | undefined;
  try {
    server = await createWorkServer({
      ...testServerOptions({
        dataDir: path.join(root, "control-plane"),
        publicBases: ["https://loss.example.test"],
        env: {
          DATABASE_URL: database.url,
          WORK_SECRET: "loss-test-secret-with-at-least-32-characters-ok",
          WORK_OPERATOR_SECRET: OPERATOR_SECRET,
          WORK_VAULT_KEY: Buffer.alloc(32, 9).toString("base64"),
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          WORK_FAKE_AGENT: "1",
          PATH: process.env.PATH,
        },
      }),
      hooks: { machines: hook },
    });
    const live = server;
    await live.app.listen({ port: 0, host: "127.0.0.1" });
    const address = live.app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const origin = `http://127.0.0.1:${address.port}`;
    const core = live.catamorphic.core;
    const db = core.db;
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are not configured");

    const account = await live.workAuth.createLocalUser({
      username: "ada",
      name: "Ada",
      password: "correct horse battery staple",
      email: "ada@example.com",
    });
    const owner: Identity = {
      tenantId: SERVER_TENANT_ID,
      externalUserId: account.id,
    };
    const project = await core.projects.create(owner, { name: "Loss" });
    const environment = (pool: Record<string, string>) => ({
      pool,
      workloads: ["agent"],
    });
    const deployed = await core.deployment.deploy(
      SERVER_TENANT_ID,
      project.id,
      owner.externalUserId,
      {
        message: "Run agents on machines of each kind",
        files: {
          ".work/project.json": JSON.stringify({
            environments: {
              desk: environment({ class: "desk" }),
              burst: environment({ class: "burst" }),
              bench: environment({ pool: "bench" }),
            },
            defaultEnvironment: "desk",
          }),
          ".work/roles/member.json": JSON.stringify({
            version: 1,
            name: "Member",
            agents: ["*"],
            environments: ["desk", "burst", "bench"],
          }),
        },
      },
    );
    expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
    await core.memberships.grant({
      identity: owner,
      projectId: project.id,
      externalUserId: owner.externalUserId,
      roles: ["member"],
    });
    const member = await core.memberships.identityFor({
      ...owner,
      projectId: project.id,
    });
    if (!member) throw new Error("Membership missing");

    const operator = async (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: string,
      payload?: unknown,
    ) => {
      const response = await live.operatorApp.inject({
        method,
        url: `/_work/operator${url}`,
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return response.json();
    };

    await run({
      root,
      db,
      platform,
      projectId: project.id,
      userId: account.id,
      plan: async (next) => {
        policy.plan = next;
        await operator("POST", "/machines/plan");
      },
      operator,
      worker: async ({ name, code, dir }) => {
        const state = { down: false };
        const log: string[] = [];
        const fetchThrough: Fetch = async (input, init) => {
          if (state.down) throw new TypeError("fetch failed: host is down");
          return globalThis.fetch(input, init);
        };
        const dataDir = dir ?? path.join(root, `${name}-${workers.length}`);
        const worker = await startWorkWorker({
          controlPlaneUrl: origin,
          dataDir,
          ...(code ? { enrollmentCode: code } : {}),
          execution: testExecutionSettings({
            PATH: process.env.PATH,
            WORK_MAX_WORKSPACES: "4",
          }),
          fetch: fetchThrough,
          log: (line) => log.push(line),
        });
        workers.push(worker);
        await expect
          .poll(
            async () =>
              (
                await db
                  .selectFrom("worker_nodes")
                  .select("id")
                  .where("id", "=", `worker.${name}`)
                  .where("enabled", "=", true)
                  .where("lease_expires_at", ">", sql<Date>`now()`)
                  .executeTakeFirst()
              )?.id,
            { timeout: 30_000, interval: 100 },
          )
          .toBe(`worker.${name}`);
        return {
          dataDir,
          log,
          unplug: () => {
            state.down = true;
          },
          plug: () => {
            state.down = false;
          },
          /** The machine is gone: its process, and its disk with it. */
          terminate: async () => {
            state.down = true;
            await worker.stop();
            await fs.rm(dataDir, { recursive: true, force: true });
          },
          stop: () => worker.stop(),
        };
      },
      unseen: async ({ name, minutes }) => {
        await sql`
          UPDATE worker_nodes SET lease_expires_at = now() - interval '1 second'
          WHERE id = ${`worker.${name}`}
        `.execute(db);
        await sql`
          UPDATE work_workers
          SET last_seen_at = now() - make_interval(secs => ${minutes * 60})
          WHERE name = ${name}
        `.execute(db);
      },
      chat: async (environmentName) =>
        (
          await sessions.create(member, project.id, {
            environment: environmentName,
          })
        ).id,
      send: (sessionId, text) =>
        enqueueMessage({
          sessions,
          identity: member,
          projectId: project.id,
          sessionId,
          text,
        }),
      settled: async (turnId, timeout = 90_000) => {
        await expect
          .poll(
            async () =>
              (
                await db
                  .selectFrom("agent_turns")
                  .select("status")
                  .where("id", "=", turnId)
                  .executeTakeFirstOrThrow()
              ).status,
            { timeout, interval: 250 },
          )
          .toMatch(/^(completed|failed|interrupted)$/);
        const turn = await db
          .selectFrom("agent_turns")
          .select(["status", sql<string | null>`error->>'message'`.as("error")])
          .where("id", "=", turnId)
          .executeTakeFirstOrThrow();
        const reply = await db
          .selectFrom("agent_items")
          .select("text")
          .where("turn_id", "=", turnId)
          .where("kind", "=", "assistant_message")
          .orderBy("position", "desc")
          .executeTakeFirst();
        return {
          status: turn.status,
          content: reply?.text ?? turn.error ?? "",
        };
      },
      releaseIdle: () =>
        sessions.releaseIdleWorkspaces({
          now: new Date(Date.now() + 60 * 60_000),
        }),
      allocations: (sessionId) =>
        db
          .selectFrom("execution_allocations")
          .select([
            "id",
            "status",
            "release_reason",
            "worker_node_id",
            "sandbox_provider_id",
            sql<boolean>`capacity_released_at IS NOT NULL`.as("freed"),
          ])
          .where("root_workload_id", "=", sessionId)
          .orderBy("created_at")
          .execute(),
      record: async (sessionId) => {
        const [items, turns] = await Promise.all([
          db
            .selectFrom("agent_items")
            .select(["kind", "text"])
            .where("session_id", "=", sessionId)
            .execute(),
          db
            .selectFrom("agent_turns")
            .select(sql<string | null>`error->>'message'`.as("error"))
            .where("session_id", "=", sessionId)
            .execute(),
        ]);
        return {
          notices: items
            .filter((item) => item.kind === "notice")
            .map((item) => item.text),
          // Everything a person could read in the chat.
          words: [
            ...items.map((item) => item.text),
            ...turns.map((turn) => turn.error ?? ""),
          ].join("\n"),
        };
      },
    });
  } finally {
    for (const worker of workers.reverse()) await worker.stop().catch(() => {});
    await server?.shutdown();
    await fs.rm(root, { recursive: true, force: true });
    await database.drop();
  }
}

interface Fleet {
  root: string;
  db: WorkServer["catamorphic"]["core"]["db"];
  /** Every call the platform received, in order. */
  platform: PlatformEvent[];
  projectId: string;
  /** The member's account id: what `{ user }` names. */
  userId: string;
  /** Deploy the host's plan, and plan now. */
  plan(next: Plan): Promise<void>;
  operator(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ): Promise<Record<string, unknown>>;
  /** Start a worker process and wait until it serves. */
  worker(args: { name: string; code?: string; dir?: string }): Promise<{
    dataDir: string;
    log: string[];
    unplug(): void;
    plug(): void;
    terminate(): Promise<void>;
    stop(): Promise<void>;
  }>;
  /** Move the clock: the machine's lease lapsed, unseen for `minutes`. */
  unseen(args: { name: string; minutes: number }): Promise<void>;
  chat(environment: string): Promise<string>;
  send(sessionId: string, text: string): Promise<string>;
  settled(
    turnId: string,
    timeout?: number,
  ): Promise<{ status: string; content: string }>;
  releaseIdle(): Promise<number>;
  allocations(sessionId: string): Promise<
    Array<{
      id: string;
      status: string;
      release_reason: string | null;
      worker_node_id: string | null;
      sandbox_provider_id: string | null;
      freed: boolean;
    }>
  >;
  record(sessionId: string): Promise<{ notices: string[]; words: string }>;
}

const REBUILT =
  /was lost\. This chat's workspace was rebuilt from its last save\. Work done after that save is gone\./;

/** The platform's creates so far. */
const creates = (platform: readonly PlatformEvent[]) =>
  platform.filter((event) => event.kind === "create");

/** One worker's row in the operator's listing. */
async function workerRow(fleet: Fleet, name: string) {
  const listing = await fleet.operator("GET", "/workers");
  const rows = Array.isArray(listing.workers) ? listing.workers : [];
  return rows.find(
    (
      row,
    ): row is {
      name: string;
      state: string;
      connected: boolean;
      managed: boolean;
      reason: string | null;
      notice: string | null;
    } => typeof row === "object" && row !== null && row.name === name,
  );
}

it.skipIf(!process.env.DATABASE_URL)(
  "stops only after saving a live chat, then resumes the same worker for the waiting turn",
  () =>
    fleet(async (fleet) => {
      const name = "desk-ada";
      const desk = {
        name,
        for: [{ user: fleet.userId }],
        labels: { class: "desk" },
      };
      await fleet.plan(() => [desk]);
      const [create] = creates(fleet.platform);
      if (!create?.code) throw new Error("No worker enrollment");
      const worker = await fleet.worker({ name, code: create.code });
      const original = await fleet.db
        .selectFrom("worker_nodes")
        .select("lease_token")
        .where("id", "=", `worker.${name}`)
        .executeTakeFirstOrThrow();
      const credential = await fs.readFile(
        path.join(worker.dataDir, "worker-credential"),
      );
      const chat = await fleet.chat("desk");
      const saved = await fleet.settled(
        await fleet.send(chat, "write-file note.txt saved-before-stop"),
      );
      expect(saved.status, saved.content).toBe("completed");

      await fleet.plan(({ work }) => [
        {
          ...desk,
          state: work.some((entry) => entry.user === fleet.userId)
            ? "running"
            : "stopped",
        },
      ]);
      expect(fleet.platform.some((event) => event.kind === "stop")).toBe(false);
      expect(await fleet.releaseIdle()).toBe(1);
      await expect
        .poll(async () => (await workerRow(fleet, name))?.state, {
          timeout: 30_000,
        })
        .toBe("stopped");
      await worker.stop();

      const waiting = await fleet.send(chat, "run cat note.txt");
      await expect
        .poll(
          async () =>
            (
              await fleet.db
                .selectFrom("placement_waits")
                .select("machine")
                .where("root_workload_id", "=", chat)
                .executeTakeFirst()
            )?.machine,
          { timeout: 30_000 },
        )
        .toEqual({ name, state: "resuming" });

      const resumed = await fleet.worker({ name, dir: worker.dataDir });
      expect(
        await fs.readFile(path.join(resumed.dataDir, "worker-credential")),
      ).toEqual(credential);
      const next = await fleet.db
        .selectFrom("worker_nodes")
        .select("lease_token")
        .where("id", "=", `worker.${name}`)
        .executeTakeFirstOrThrow();
      expect(next.lease_token).not.toBe(original.lease_token);
      expect(await fleet.settled(waiting)).toEqual({
        status: "completed",
        content: expect.stringContaining("saved-before-stop"),
      });
      expect(creates(fleet.platform)).toHaveLength(1);
    }),
  150_000,
);

it.skipIf(!process.env.DATABASE_URL)(
  "a member's kept machine that is lost is retired, replaced under its name, and its chats continue from their last save",
  () =>
    fleet(async (fleet) => {
      const { platform } = fleet;
      // The host's whole policy: the member has a machine of their own.
      await fleet.plan(() => [
        {
          name: "desk-ada",
          for: [{ user: fleet.userId }],
          labels: { class: "desk" },
        },
      ]);
      await expect
        .poll(() => creates(platform).length, { timeout: 30_000 })
        .toBe(1);
      const [made] = creates(platform);
      if (!made?.code) throw new Error("No machine was created");
      const { name } = made;
      const first = await fleet.worker({ name, code: made.code });
      expect(await workerRow(fleet, name)).toMatchObject({
        state: "serving",
        connected: true,
        managed: true,
      });

      // Two chats with saved work on the machine: one idle, one in the
      // middle of a turn with a message queued behind it.
      const idle = await fleet.chat("desk");
      const busy = await fleet.chat("desk");
      for (const [chat, text] of [
        [idle, "saved-idle"],
        [busy, "saved-busy"],
      ] as const) {
        const reply = await fleet.settled(
          await fleet.send(chat, `write-file note.txt ${text}`),
        );
        expect(reply.status, reply.content).toBe("completed");
      }
      const running = await fleet.send(busy, "run sleep 600");
      await expect
        .poll(
          async () =>
            (
              await fleet.db
                .selectFrom("agent_turns")
                .select("status")
                .where("id", "=", running)
                .executeTakeFirstOrThrow()
            ).status,
          { timeout: 30_000, interval: 100 },
        )
        .toBe("running");
      const queued = await fleet.send(busy, "run cat note.txt");
      const before = [
        ...(await fleet.allocations(idle)),
        ...(await fleet.allocations(busy)),
      ];
      expect(before).toHaveLength(2);
      for (const allocation of before)
        expect(allocation).toMatchObject({
          status: "active",
          worker_node_id: `worker.${name}`,
        });

      // The sequencer is held off, so each state can be read before the
      // server acts on it: what any replica does without a pass is seen
      // first, then the pass.
      const claim = {
        db: fleet.db,
        name: `machine-reconciler:${SERVER_TENANT_ID}`,
        holder: "machine-loss-test",
      };
      await expect
        .poll(() => takeReplicaClaim({ ...claim, ttlSeconds: 600 }), {
          timeout: 60_000,
        })
        .toBe(true);

      // The instance is terminated: no call, no disk.
      await first.terminate();
      await fleet.unseen({ name, minutes: 1 });
      expect(await workerRow(fleet, name)).toMatchObject({
        state: "unreachable",
        connected: false,
      });

      // Past its loss limit (five minutes unless the plan says otherwise).
      await fleet.unseen({ name, minutes: 6 });
      expect(await workerRow(fleet, name)).toMatchObject({
        state: "lost",
        connected: false,
      });

      // Its work is retired by the server's own maintenance: both
      // Allocations released as a lost machine's, their capacity freed.
      await expect
        .poll(
          async () => [
            ...(await fleet.allocations(idle)),
            ...(await fleet.allocations(busy)),
          ],
          { timeout: 60_000, interval: 500 },
        )
        .toEqual(
          before.map((allocation) =>
            expect.objectContaining({
              id: allocation.id,
              status: "released",
              release_reason: "node_lost",
              freed: true,
            }),
          ),
        );
      // The turn that was running ends saying which machine went, never
      // with the runner's internal words.
      const cut = await fleet.settled(running, 120_000);
      expect(cut.status, cut.content).toMatch(/^(failed|interrupted)$/);
      expect(cut.content).toContain(name);
      expect(cut.content).not.toContain(SANDBOX_UNKNOWN_ERROR);
      expect(platform.map((event) => event.kind)).toEqual(["create"]);

      // The pass: destroyed on its platform, then made again under a new
      // enrollment and idempotency key. Nobody asked for it.
      await releaseReplicaClaim(claim);
      await expect
        .poll(() => platform.map((event) => event.kind), {
          timeout: 120_000,
          interval: 500,
        })
        .toEqual(["create", "destroy", "create"]);
      const [, destroyed, remade] = platform;
      expect(destroyed).toMatchObject({ kind: "destroy", name });
      expect(remade).toMatchObject({ kind: "create", name });
      expect(remade?.key).not.toBe(made.key);
      expect(remade?.code).not.toBe(made.code);
      if (!remade?.code) throw new Error("No replacement was created");

      // The replacement enrolls under the same name and node, with nothing
      // of the old machine's on it.
      await fleet.worker({ name, code: remade.code });
      expect(await workerRow(fleet, name)).toMatchObject({
        state: "serving",
        connected: true,
      });

      // The queued message runs there by itself, and a new one too, with
      // the saved work present.
      const resumed = await fleet.settled(queued, 120_000);
      expect(resumed.status, resumed.content).toBe("completed");
      expect(resumed.content).toContain("saved-busy");
      const next = await fleet.settled(
        await fleet.send(idle, "run cat note.txt"),
        120_000,
      );
      expect(next.status, next.content).toBe("completed");
      expect(next.content).toContain("saved-idle");
      for (const chat of [idle, busy]) {
        const allocations = await fleet.allocations(chat);
        expect(allocations.at(-1)).toMatchObject({
          status: "active",
          worker_node_id: `worker.${name}`,
        });
        expect(allocations).toHaveLength(2);
        const record = await fleet.record(chat);
        expect(
          record.notices.filter((text) => REBUILT.test(text)),
        ).toHaveLength(1);
        expect(record.notices.join("\n")).toContain(name);
        expect(record.words).not.toContain(SANDBOX_UNKNOWN_ERROR);
      }
      // One machine was ever asked of the platform at a time.
      expect(platform).toHaveLength(3);
    }),
  600_000,
);

it.skipIf(!process.env.DATABASE_URL)(
  "a machine on demand that is lost is retired and destroyed, and waiting work gets a new one",
  () =>
    fleet(async (fleet) => {
      const { platform } = fleet;
      // A machine while work waits for one, kept while it serves work.
      await fleet.plan(({ work, machines }) => {
        const machine = machines.find((entry) => entry.name === "burst-1");
        const busy =
          machine !== undefined &&
          (machine.state === "starting" ||
            (machine.state === "serving" && machine.holding.workspaces > 0));
        const waiting = work.some((entry) => entry.pool.class === "burst");
        return busy || waiting
          ? [
              {
                name: "burst-1",
                for: [{ user: fleet.userId }],
                labels: { class: "burst" },
              },
            ]
          : [];
      });
      // Work waits, so a machine is made for it.
      const chat = await fleet.chat("burst");
      const saved = await fleet.send(chat, "write-file note.txt saved-burst");
      await expect
        .poll(() => creates(platform).length, { timeout: 60_000 })
        .toBe(1);
      const [made] = creates(platform);
      if (!made?.code) throw new Error("No machine was created");
      const { name } = made;
      const first = await fleet.worker({ name, code: made.code });
      const reply = await fleet.settled(saved, 120_000);
      expect(reply.status, reply.content).toBe("completed");
      const [held] = await fleet.allocations(chat);
      expect(held).toMatchObject({
        status: "active",
        worker_node_id: `worker.${name}`,
      });

      await first.terminate();
      await fleet.unseen({ name, minutes: 6 });
      await expect
        .poll(() => platform.map((event) => event.kind), {
          timeout: 120_000,
          interval: 500,
        })
        .toEqual(["create", "destroy"]);
      expect((await fleet.allocations(chat))[0]).toMatchObject({
        id: held?.id,
        status: "released",
        release_reason: "node_lost",
        freed: true,
      });

      // The next message waits for a machine, and gets a new one.
      const next = await fleet.send(chat, "run cat note.txt");
      await expect
        .poll(() => creates(platform).length, { timeout: 120_000 })
        .toBe(2);
      const remade = creates(platform)[1];
      if (!remade?.code) throw new Error("No replacement was created");
      expect(remade.name).toBe(name);
      expect(remade.key).not.toBe(made.key);
      await fleet.worker({ name, code: remade.code });
      const resumed = await fleet.settled(next, 120_000);
      expect(resumed.status, resumed.content).toBe("completed");
      expect(resumed.content).toContain("saved-burst");
      const record = await fleet.record(chat);
      expect(record.notices.filter((text) => REBUILT.test(text))).toHaveLength(
        1,
      );
      expect(record.words).not.toContain(SANDBOX_UNKNOWN_ERROR);
    }),
  600_000,
);

it.skipIf(!process.env.DATABASE_URL)(
  "a worker revoked and enrolled again under its name starts with nothing of the old one, and its chats continue",
  () =>
    fleet(async (fleet) => {
      const enroll = async () => {
        const enrollment = await fleet.operator("POST", "/workers", {
          name: "bench",
          labels: { pool: "bench" },
          trusted: true,
        });
        if (typeof enrollment.code !== "string") throw new Error("No code");
        return enrollment.code;
      };
      const first = await fleet.worker({ name: "bench", code: await enroll() });
      const chat = await fleet.chat("bench");
      const saved = await fleet.settled(
        await fleet.send(chat, "write-file note.txt saved-bench"),
      );
      expect(saved.status, saved.content).toBe("completed");
      const [held] = await fleet.allocations(chat);
      expect(held).toMatchObject({
        status: "active",
        worker_node_id: "worker.bench",
      });

      // The operator revokes it: what it held is retired at once.
      await fleet.operator("DELETE", "/workers/bench");
      expect((await fleet.allocations(chat))[0]).toMatchObject({
        id: held?.id,
        status: "released",
        release_reason: "node_lost",
        freed: true,
      });
      await first.terminate();

      // A message sent meanwhile waits for a machine open to its owner.
      const next = await fleet.send(chat, "run cat note.txt");
      await fleet.worker({ name: "bench", code: await enroll() });
      const resumed = await fleet.settled(next, 120_000);
      expect(resumed.status, resumed.content).toBe("completed");
      expect(resumed.content).toContain("saved-bench");
      const allocations = await fleet.allocations(chat);
      expect(allocations).toHaveLength(2);
      expect(allocations[1]).toMatchObject({
        status: "active",
        worker_node_id: "worker.bench",
      });
      // The new machine holds one workspace, not the old one's too.
      const machines = await fleet.operator("GET", "/machines");
      const node = (Array.isArray(machines.machines) ? machines.machines : [])
        .filter(
          (row): row is { id: string; usage: { workspaces: number } } =>
            typeof row === "object" && row !== null && "usage" in row,
        )
        .find((row) => row.id === "worker.bench");
      expect(node?.usage.workspaces).toBe(1);
      const record = await fleet.record(chat);
      expect(record.notices.filter((text) => REBUILT.test(text))).toHaveLength(
        1,
      );
      expect(record.words).not.toContain(SANDBOX_UNKNOWN_ERROR);
    }),
  300_000,
);

it.skipIf(!process.env.DATABASE_URL)(
  "a runner that no longer holds a chat's sandbox costs one retired Allocation, and the message runs",
  () =>
    fleet(async (fleet) => {
      const enrollment = await fleet.operator("POST", "/workers", {
        name: "bench",
        labels: { pool: "bench" },
        trusted: true,
      });
      if (typeof enrollment.code !== "string") throw new Error("No code");
      const first = await fleet.worker({
        name: "bench",
        code: enrollment.code,
      });
      const chat = await fleet.chat("bench");
      const saved = await fleet.settled(
        await fleet.send(chat, "write-file note.txt saved-typed"),
      );
      expect(saved.status, saved.content).toBe("completed");
      const [held] = await fleet.allocations(chat);

      // Its disk is replaced under it: the worker comes back with its
      // credential and no record of the sandboxes it made.
      await first.stop();
      await fs.rm(path.join(first.dataDir, "sandboxes.json"), { force: true });
      await fleet.worker({ name: "bench", dir: first.dataDir });

      const reply = await fleet.settled(
        await fleet.send(chat, "run cat note.txt"),
        120_000,
      );
      expect(reply.status, reply.content).toBe("completed");
      expect(reply.content).toContain("saved-typed");
      const allocations = await fleet.allocations(chat);
      expect(allocations).toHaveLength(2);
      expect(allocations[0]).toMatchObject({
        id: held?.id,
        status: "released",
        release_reason: "node_lost",
        freed: true,
      });
      expect(allocations[1]).toMatchObject({
        status: "active",
        worker_node_id: "worker.bench",
      });
      const record = await fleet.record(chat);
      expect(record.notices.filter((text) => REBUILT.test(text))).toHaveLength(
        1,
      );
      expect(record.words).not.toContain(SANDBOX_UNKNOWN_ERROR);
    }),
  300_000,
);

it.skipIf(!process.env.DATABASE_URL)(
  "a hand-enrolled worker's long outage retires its work; back, it takes its chats again and drops the old sandboxes",
  () =>
    fleet(async (fleet) => {
      const enrollment = await fleet.operator("POST", "/workers", {
        name: "bench",
        labels: { pool: "bench" },
        trusted: true,
      });
      if (typeof enrollment.code !== "string") throw new Error("No code");
      const worker = await fleet.worker({
        name: "bench",
        code: enrollment.code,
      });
      const chat = await fleet.chat("bench");
      const saved = await fleet.settled(
        await fleet.send(chat, "write-file note.txt saved-outage"),
      );
      expect(saved.status, saved.content).toBe("completed");
      const [held] = await fleet.allocations(chat);
      if (!held?.sandbox_provider_id) throw new Error("No sandbox was made");
      const ownedSandboxes = async () =>
        JSON.parse(
          await fs.readFile(
            path.join(worker.dataDir, "sandboxes.json"),
            "utf8",
          ),
        ) as unknown;
      expect(await ownedSandboxes()).toContain(held.sandbox_provider_id);

      // The network between them goes for longer than the loss limit.
      worker.unplug();
      await fleet.unseen({ name: "bench", minutes: 6 });
      await expect
        .poll(async () => (await fleet.allocations(chat))[0], {
          timeout: 60_000,
          interval: 500,
        })
        .toMatchObject({
          id: held.id,
          status: "released",
          release_reason: "node_lost",
          freed: true,
        });
      // Nobody replaces a machine the hook did not make: it stays enrolled, lost.
      expect(await workerRow(fleet, "bench")).toMatchObject({
        state: "lost",
        connected: false,
        managed: false,
      });
      expect(fleet.platform).toEqual([]);

      // A message sent meanwhile waits: no machine open to its owner is up.
      const next = await fleet.send(chat, "run cat note.txt");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(
        (
          await fleet.db
            .selectFrom("agent_turns")
            .select("status")
            .where("id", "=", next)
            .executeTakeFirstOrThrow()
        ).status,
      ).toMatch(/^(queued|preparing)$/);

      // It comes back with its disk: the chat runs there again from its
      // last save, and the sandbox whose Allocation is gone is removed.
      worker.plug();
      const resumed = await fleet.settled(next, 180_000);
      expect(resumed.status, resumed.content).toBe("completed");
      expect(resumed.content).toContain("saved-outage");
      await expect
        .poll(async () => (await fleet.allocations(chat))[0], {
          timeout: 60_000,
          interval: 500,
        })
        .toMatchObject({ id: held.id, sandbox_provider_id: null });
      expect(await ownedSandboxes()).not.toContain(held.sandbox_provider_id);
      expect(await workerRow(fleet, "bench")).toMatchObject({
        state: "serving",
        connected: true,
      });
      const record = await fleet.record(chat);
      expect(record.notices.filter((text) => REBUILT.test(text))).toHaveLength(
        1,
      );
      expect(record.words).not.toContain(SANDBOX_UNKNOWN_ERROR);
    }),
  300_000,
);
