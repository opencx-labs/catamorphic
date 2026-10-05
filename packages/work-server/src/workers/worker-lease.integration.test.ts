import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  clientExecutor,
  EXECUTOR_RESTARTED_ERROR,
  type Identity,
  openRemoteOperation,
  WorkerNodesService,
} from "@catamorphic/core";
import {
  executorPublicKey,
  generateExecutorKeyPair,
} from "@catamorphic/sandbox";
import { startClientRunner } from "@catamorphic/server-sdk";
import { sql } from "kysely";
import { expect, it } from "vitest";
import {
  executionSettingsFromEnv,
  workExecution,
} from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import {
  createTestDatabase,
  enqueue as enqueueMessage,
  testServerOptions,
} from "../test-support.js";
import { WORKER_PROTOCOL, WORKER_PROTOCOL_HEADER } from "./worker-protocol.js";
import { startWorkWorker } from "./worker-runtime.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Append, wait, append, count: a turn that is mid-sleep for a while. The
 * count lives beside the project directory, so it records every command the
 * worker ran, whatever a chat's workspace is restored to.
 */
const SLOW_TURN =
  "run printf . >> ../ops ;; run sleep 4 ;; run printf . >> ../ops ;; run wc -c < ../ops";

const MEMBER_ROLE = {
  version: 1,
  name: "Member",
  agents: ["*"],
  environments: ["build", "laptop"],
};

/**
 * Workers own their lease (ADR 0192), end to end on network Postgres: two
 * replicas behind a balancer that routes every call to either one and
 * answers some with a 502, and one worker.
 *
 * - Stopping the replica that is not running a turn leaves it running.
 * - A replica crashing (SIGKILL) while it runs a turn loses only that turn:
 *   the other replica settles it through turn-lease recovery, never replays
 *   it, and runs the chat's next turns.
 * - The worker connecting again under its epoch keeps a running turn.
 * - A restarted worker (a new epoch) fails only the operation in flight,
 *   as uncertain; its chats keep their workspaces and continue.
 * - A This machine chat continues when the replica that admitted it stops.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "any replica runs any worker's turns; replicas and workers restart independently (ADR 0192)",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-lease-"));
    const database = await createTestDatabase("work_lease");
    const servers = new Map<string, WorkServer>();
    const replicas = new Map<string, string>();
    const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];
    let runner: ReturnType<typeof startClientRunner> | undefined;
    let crashable: ChildProcess | undefined;
    const env = {
      DATABASE_URL: database.url,
      WORK_SECRET: "lease-test-secret-with-at-least-32-characters-ok",
      WORK_OPERATOR_SECRET: "lease-test-operator-secret-with-32-characters",
      WORK_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
      WORK_CONTROL_PLANE_WORKLOADS: "workflow",
      WORK_FAKE_AGENT: "1",
      PATH: process.env.PATH,
    };
    const startReplica = async (name: string) => {
      const server = await createWorkServer(
        testServerOptions({
          dataDir: path.join(root, name),
          publicBases: ["https://lease.example.test"],
          env: { ...env, WORK_MACHINE_NAME: name },
        }),
      );
      servers.set(name, server);
      await server.app.listen({ port: 0, host: "127.0.0.1" });
      const address = server.app.server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      replicas.set(name, `http://127.0.0.1:${address.port}`);
      return server;
    };
    const stopReplica = async (name: string) => {
      const server = servers.get(name);
      servers.delete(name);
      replicas.delete(name);
      await server?.shutdown();
    };
    const anyReplica = (): WorkServer => {
      const live = [...servers.values()];
      const server = live[Math.floor(Math.random() * live.length)];
      if (!server) throw new Error("No replica is running");
      return server;
    };
    /** A balancer: each call to a random replica, some answered with 502. */
    let workerCalls = { connects: 0, badGateways: 0 };
    const balanced =
      (blackhole: () => boolean): Fetch =>
      async (input, init) => {
        if (blackhole()) throw new TypeError("fetch failed: host is down");
        const url = new URL(input);
        const route = url.pathname.split("/").at(-1) ?? "";
        if (route === "connect") workerCalls.connects++;
        if (
          ["poll", "renew", "complete"].includes(route) &&
          Math.random() < 0.1
        ) {
          workerCalls.badGateways++;
          return new Response("Bad Gateway", { status: 502 });
        }
        const live = [...replicas.values()];
        const origin = live[Math.floor(Math.random() * live.length)];
        if (!origin) throw new TypeError("fetch failed: no replica");
        return globalThis.fetch(`${origin}${url.pathname}`, init);
      };
    try {
      const a = await startReplica("a");
      await startReplica("b");
      const account = await a.workAuth.createLocalUser({
        username: "leasemember",
        name: "Lease member",
        password: "lease-member-test-password",
      });
      const owner: Identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: account.id,
      };
      const project = await a.catamorphic.core.projects.create(owner, {
        name: "Worker leases",
      });
      const deployed = await a.catamorphic.core.deployment.deploy(
        SERVER_TENANT_ID,
        project.id,
        owner.externalUserId,
        {
          message: "Run agents on workers and on this machine",
          files: {
            ".work/project.json": JSON.stringify({
              environments: {
                build: { pool: { plane: "worker" }, workloads: ["agent"] },
                laptop: { device: "member", workloads: ["agent"] },
              },
              defaultEnvironment: "build",
            }),
            ".work/roles/member.json": JSON.stringify(MEMBER_ROLE),
          },
        },
      );
      expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
      await a.catamorphic.core.memberships.grant({
        identity: owner,
        projectId: project.id,
        externalUserId: owner.externalUserId,
        roles: ["member"],
      });
      const memberOn = async (server: WorkServer) => {
        const member = await server.catamorphic.core.memberships.identityFor({
          ...owner,
          projectId: project.id,
        });
        if (!member) throw new Error("Membership missing");
        return member;
      };
      const sessions = (server: WorkServer) => {
        const service = server.catamorphic.core.agentSessions;
        if (!service) throw new Error("Agent sessions are not configured");
        return service;
      };
      const db = () => anyReplica().catamorphic.core.db;

      // One worker, reaching the replicas only through the balancer.
      const enrollment = await a.operatorApp.inject({
        method: "POST",
        url: "/_work/operator/workers",
        headers: {
          authorization: `Bearer ${env.WORK_OPERATOR_SECRET}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name: "builder", trusted: true }),
      });
      expect(enrollment.statusCode).toBe(201);
      const workerDir = path.join(root, "worker");
      const execution = executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "4",
      });
      let firstWorkerDown = false;
      const firstLog: string[] = [];
      workers.push(
        await startWorkWorker({
          controlPlaneUrl: "http://127.0.0.1:1",
          dataDir: workerDir,
          enrollmentCode: enrollment.json().code,
          execution,
          fetch: balanced(() => firstWorkerDown),
          log: (line) => firstLog.push(line),
        }),
      );
      const epoch = async () =>
        (
          await db()
            .selectFrom("worker_nodes")
            .select(["lease_token", "remote"])
            .where("id", "=", "worker.builder")
            .where("lease_expires_at", ">", new Date())
            .executeTakeFirst()
        )?.lease_token;
      await expect.poll(epoch, { timeout: 20_000 }).toBeTruthy();
      const firstEpoch = await epoch();

      const openChat = async () => {
        const server = anyReplica();
        return sessions(server).create(await memberOn(server), project.id, {
          environment: "build",
        });
      };
      const turns = (sessionId: string) =>
        db()
          .selectFrom("agent_turns")
          .select(["id", "status", "attempt_count"])
          .where("session_id", "=", sessionId)
          .orderBy("created_at")
          .execute();
      /** Enqueue on a random replica; any replica may run it. */
      const enqueue = async (sessionId: string, message: string) => {
        const server = anyReplica();
        return enqueueMessage({
          sessions: sessions(server),
          identity: await memberOn(server),
          projectId: project.id,
          sessionId,
          text: message,
        });
      };
      /** The turn's settled reply, from Postgres. */
      const settled = async (turnId: string, timeout = 60_000) => {
        await expect
          .poll(
            async () =>
              (
                await db()
                  .selectFrom("agent_turns")
                  .select("status")
                  .where("id", "=", turnId)
                  .executeTakeFirstOrThrow()
              ).status,
            { timeout, interval: 250 },
          )
          .toMatch(/^(completed|failed|interrupted)$/);
        const turn = await db()
          .selectFrom("agent_turns")
          .select(["status", sql<string | null>`error->>'message'`.as("error")])
          .where("id", "=", turnId)
          .executeTakeFirstOrThrow();
        const reply = await db()
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
      };
      const count = (content: string) =>
        content.split("\n---\n").at(-1)?.trim();
      /**
       * Wait until the turn is inside its `sleep`, on the worker. Only the
       * worker's key reads a queued command (ADR 0206).
       */
      const sleeping = async (since = new Date(Date.now() - 1_000)) =>
        expect
          .poll(
            async () => {
              const privateKey = await fs.readFile(
                path.join(workerDir, "worker-key"),
                "utf8",
              );
              const running = await db()
                .selectFrom("remote_operations")
                .select(["id", "operation"])
                .where("executor", "=", "node:worker.builder")
                .where("status", "=", "running")
                .where("created_at", ">", since)
                .where(sql<string>`operation->>'kind'`, "=", "execute")
                .execute();
              return running.some((job) => {
                const operation = openRemoteOperation({
                  operationId: job.id,
                  executor: "node:worker.builder",
                  envelope: job.operation,
                  privateKeys: [privateKey],
                });
                return (
                  operation.kind === "execute" &&
                  operation.command.includes("sleep")
                );
              });
            },
            { timeout: 30_000, interval: 100 },
          )
          .toBe(true);
      /** The replica whose process is running the chat's turn. */
      const runningOn = async (sessionId: string) => {
        const turn = await db()
          .selectFrom("agent_turns")
          .select("lease_owner")
          .where("session_id", "=", sessionId)
          .where("status", "=", "running")
          .executeTakeFirst();
        for (const [name, server] of servers)
          if (sessions(server).turnWorkerId === turn?.lease_owner) return name;
        return undefined;
      };

      // 1. The replica that is not running the turn stops mid-turn.
      const chat = await openChat();
      let since = new Date();
      let turnId = await enqueue(chat.id, SLOW_TURN);
      await sleeping(since);
      const runs = await runningOn(chat.id);
      if (!runs) throw new Error("No replica runs the turn");
      await stopReplica(runs === "a" ? "b" : "a");
      let reply = await settled(turnId);
      expect(reply.status, reply.content).toBe("completed");
      expect(count(reply.content)).toBe("exit=0\n2");
      await startReplica(runs === "a" ? "b" : "a");

      // 2. The replica running the turn crashes mid-turn (SIGKILL). Only
      // that turn is lost: once its lease lapses, another replica settles
      // it as interrupted and never runs it again (ADR 0198). The crashing
      // replica is a process of its own; replica a takes no turns meanwhile,
      // so the crashing replica's poller claims the next one.
      await stopReplica("b");
      let appended = 2;
      crashable = await startReplicaProcess({
        env: {
          ...env,
          WORK_PUBLIC_URL: "https://lease.example.test",
          WORK_DATA_DIR: path.join(root, "crashable"),
          WORK_MACHINE_NAME: "crashable",
        },
      });
      const live = servers.get("a");
      if (!live) throw new Error("Replica a is not running");
      await sessions(live).stopLocalTurns({ timeoutMs: 0 });
      since = new Date();
      const crashed = await enqueue(chat.id, SLOW_TURN);
      await sleeping(since);
      expect(await runningOn(chat.id)).toBeUndefined();
      crashable.kill("SIGKILL");
      appended += 1;
      await stopReplica("a");
      await startReplica("a");
      await startReplica("b");
      reply = await settled(crashed, 120_000);
      expect(reply.status, reply.content).toBe("interrupted");
      turnId = await enqueue(chat.id, "run wc -c < ../ops");
      reply = await settled(turnId);
      // The interrupted turn's first append ran once; nothing after it ran.
      expect(count(reply.content)).toBe(`exit=0\n${appended}`);
      expect(
        (await turns(chat.id)).every((turn) => turn.attempt_count === 1),
      ).toBe(true);

      // 3. The worker connects again under its epoch mid-turn: nothing is
      // interrupted.
      since = new Date();
      turnId = await enqueue(chat.id, SLOW_TURN);
      await sleeping(since);
      const credential = (
        await fs.readFile(path.join(workerDir, "worker-credential"), "utf8")
      ).trim();
      const connected = (
        await new WorkerNodesService(anyReplica().catamorphic.core.db).list({
          tenantId: SERVER_TENANT_ID,
          authorityId: (
            await anyReplica()
              .catamorphic.core.db.selectFrom("worker_nodes")
              .select("authority_id")
              .where("id", "=", "worker.builder")
              .executeTakeFirstOrThrow()
          ).authority_id,
        })
      ).find((candidate) => candidate.id === "worker.builder");
      if (!connected?.remote)
        throw new Error("The worker's offer is not recorded");
      const reconnect = await anyReplica().app.inject({
        method: "POST",
        url: "/api/workers/connect",
        headers: {
          authorization: `Worker ${credential}`,
          [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server),
        },
        payload: {
          session: firstEpoch,
          offer: {
            isolation: connected.descriptor.isolation,
            resourceLimits: connected.descriptor.resourceLimits ?? [],
            workspaceRoot: connected.remote.workspaceRoot,
            processes: connected.remote.processes,
            capabilities: connected.descriptor.capabilities.filter(
              (capability) => capability !== "network.egress",
            ),
            capacity: connected.capacity,
            defaults: connected.defaults,
          },
          publicKey: executorPublicKey(
            await fs.readFile(path.join(workerDir, "worker-key"), "utf8"),
          ),
        },
      });
      expect(reconnect.statusCode).toBe(200);
      reply = await settled(turnId);
      expect(reply.status, reply.content).toBe("completed");
      appended += 2;
      expect(count(reply.content)).toBe(`exit=0\n${appended}`);

      // 4. The worker restarts (a new process, a new epoch) mid-turn. The
      // operation in flight fails as uncertain and is never replayed; the
      // chats keep their workspaces and continue.
      const other = await openChat();
      reply = await settled(await enqueue(other.id, "run printf . >> ../ops"));
      expect(reply.status, reply.content).toBe("completed");
      since = new Date();
      turnId = await enqueue(chat.id, SLOW_TURN);
      await sleeping(since);
      firstWorkerDown = true;
      const secondLog: string[] = [];
      workers.push(
        await startWorkWorker({
          controlPlaneUrl: "http://127.0.0.1:1",
          dataDir: workerDir,
          execution,
          fetch: balanced(() => false),
          log: (line) => secondLog.push(line),
        }),
      );
      reply = await settled(turnId);
      expect(reply.status, reply.content).toBe("failed");
      expect(reply.content).toContain(EXECUTOR_RESTARTED_ERROR);
      expect(await epoch()).not.toBe(firstEpoch);
      // The old process hears it was superseded and stops for good.
      firstWorkerDown = false;
      await expect
        .poll(() => firstLog.some((line) => line.includes("newer process")), {
          timeout: 30_000,
        })
        .toBe(true);
      reply = await settled(
        await enqueue(other.id, "run printf . >> ../ops ;; run wc -c < ../ops"),
      );
      expect(count(reply.content)).toBe("exit=0\n2");
      reply = await settled(await enqueue(chat.id, "run wc -c < ../ops"));
      // The restart cut the turn after its first append; the sleep and the
      // second append never ran again.
      expect(count(reply.content)).toBe(`exit=0\n${appended + 1}`);

      // 5. A This machine chat continues when the replica that admitted it
      // stops: it is no replica's work.
      const [admittingName, admitting] = [...servers][0] ?? [];
      if (!admittingName || !admitting) throw new Error("No replica");
      const member = await memberOn(admitting);
      const runnerId = randomUUID();
      const runnerIdentity = { ...member, clientRunnerId: runnerId };
      const runners = () => {
        const service = anyReplica().catamorphic.core.clientRunners;
        if (!service) throw new Error("Client execution is unavailable");
        return service;
      };
      const machine = workExecution({
        settings: execution,
        dataDir: path.join(root, "laptop"),
      });
      const laptopKeys = generateExecutorKeyPair();
      const lease = await runners().register({
        identity: runnerIdentity,
        projectId: project.id,
        id: runnerId,
        environment: "laptop",
        label: "Laptop",
        workspaceRoot: machine.provider.workspaceRoot ?? "/workspace",
        publicKey: laptopKeys.publicKey,
      });
      runner = startClientRunner({
        provider: machine.provider,
        keys: {
          executor: clientExecutor(runnerId),
          privateKeys: () => [laptopKeys.privateKey],
        },
        transport: {
          renew: () => runners().renew({ ...lease, identity: runnerIdentity }),
          // Like the HTTP transport, a stopping runner cancels its long poll.
          poll: ({ pollId, max, signal }) =>
            runners().poll({
              ...lease,
              identity: runnerIdentity,
              pollId,
              max,
              signal,
            }),
          complete: async (receipt) => {
            await runners().complete({
              ...lease,
              identity: runnerIdentity,
              ...receipt,
            });
          },
          disconnect: () =>
            runners().disconnect({ ...lease, identity: runnerIdentity }),
        },
      });
      const laptop = await sessions(admitting).create(
        runnerIdentity,
        project.id,
        {
          environment: "laptop",
        },
      );
      reply = await settled(
        await enqueue(
          laptop.id,
          "run printf . >> ../ops ;; run wc -c < ../ops",
        ),
      );
      expect(count(reply.content)).toBe("exit=0\n1");
      const allocationOf = () =>
        db()
          .selectFrom("agent_sessions")
          .innerJoin(
            "execution_allocations",
            "execution_allocations.id",
            "agent_sessions.allocation_id",
          )
          .select([
            "execution_allocations.id",
            "execution_allocations.worker_node_id",
            "execution_allocations.status",
          ])
          .where("agent_sessions.id", "=", laptop.id)
          .executeTakeFirstOrThrow();
      const admitted = await allocationOf();
      expect(admitted.worker_node_id).toBeNull();
      await stopReplica(admittingName);
      reply = await settled(
        await enqueue(
          laptop.id,
          "run printf . >> ../ops ;; run wc -c < ../ops",
        ),
      );
      expect(count(reply.content)).toBe("exit=0\n2");
      expect(await allocationOf()).toEqual(admitted);

      expect(workerCalls.badGateways).toBeGreaterThan(0);
      // Replicas came and went; each worker process connected once.
      expect(workerCalls.connects).toBe(2);
      expect(
        secondLog.filter((line) => line.startsWith("Worker session ended")),
      ).toEqual([]);
      workerCalls = { connects: 0, badGateways: 0 };
    } finally {
      crashable?.kill("SIGKILL");
      await runner?.stop();
      for (const worker of workers.reverse()) await worker.stop();
      for (const server of servers.values()) await server.shutdown();
      await fs.rm(root, { recursive: true, force: true });
      await database.drop();
    }
  },
  600_000,
);

/** A replica in its own process, to crash with SIGKILL (ADR 0190). */
async function startReplicaProcess(args: {
  env: Record<string, string | undefined>;
}): Promise<ChildProcess> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "..", "replica-process.fixture.ts")],
    { env: args.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout ?? process.stdin });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The replica process did not start")),
      60_000,
    );
    child.once("exit", (code) =>
      reject(new Error(`The replica process exited with ${code}`)),
    );
    lines.on("line", (line) => {
      // Its request log shares stdout: only the ready line names a node.
      if (!line.startsWith('{"node"')) return;
      clearTimeout(timer);
      resolve();
    });
  });
  return child;
}
