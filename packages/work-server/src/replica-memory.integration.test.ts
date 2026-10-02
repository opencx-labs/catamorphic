import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentTurnInProgressError, type Identity } from "@catamorphic/core";
import { expect, it } from "vitest";
import { executionSettingsFromEnv } from "./execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import {
  createTestDatabase,
  enqueue as enqueueMessage,
  testServerOptions,
} from "./test-support.js";
import { startWorkWorker } from "./workers/worker-runtime.js";

const PUBLIC_URL = "https://memory.example.test";
const OPERATOR_SECRET = "memory-test-operator-secret-with-32-characters";

const project = (environments: Record<string, unknown>) =>
  JSON.stringify({ environments, defaultEnvironment: "build" });
const BUILD = { pool: { plane: "worker" }, workloads: ["agent"] };
const LAPTOP = { device: "member", workloads: ["agent"] };
const role = (environments: string[]) =>
  JSON.stringify({ version: 1, name: "Member", agents: ["*"], environments });

/**
 * No cross-replica state in replica memory (ADR 0193), end to end on
 * network Postgres: two replicas and a worker, so either replica may run a
 * chat's turn (ADR 0192). Each request below goes to the replica that is
 * not running the turn.
 *
 * - A running turn shows as running on both replicas.
 * - Changing a chat mid-turn is refused on the replica not running it.
 * - An interrupt through the other replica stops a quiet turn within two
 *   seconds.
 * - A question a replica's harness holds is answered through either replica
 *   and continues where it was asked.
 * - Close and archive through the other replica stop the running turn
 *   before its workspace is given back.
 * - A role and an Environment a deploy just added through one replica apply
 *   on the other at once: This machine registers there, with no stale cache
 *   refusing it.
 */
it.skipIf(!process.env.DATABASE_URL)(
  "replicas share turn status, guards, stops, questions, and fresh policy",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-memory-"));
    const database = await createTestDatabase("work_memory");
    const servers: WorkServer[] = [];
    const origins: string[] = [];
    let worker: Awaited<ReturnType<typeof startWorkWorker>> | undefined;
    const start = async (name: string) => {
      const server = await createWorkServer(
        testServerOptions({
          dataDir: path.join(root, name),
          publicBases: [PUBLIC_URL],
          env: {
            DATABASE_URL: database.url,
            WORK_SECRET: "memory-test-secret-with-at-least-32-characters",
            WORK_OPERATOR_SECRET: OPERATOR_SECRET,
            WORK_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
            WORK_CONTROL_PLANE_WORKLOADS: "workflow",
            WORK_FAKE_AGENT: "1",
            WORK_MACHINE_NAME: name,
            PATH: process.env.PATH,
          },
        }),
      );
      servers.push(server);
      await server.app.listen({ port: 0, host: "127.0.0.1" });
      const address = server.app.server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      origins.push(`http://127.0.0.1:${address.port}`);
      return server;
    };
    try {
      const a = await start("a");
      const b = await start("b");
      const account = await b.workAuth.createLocalUser({
        username: "memorymember",
        name: "Memory member",
        password: "memory-member-test-password",
      });
      const owner: Identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: account.id,
      };
      const { id: projectId } = await b.catamorphic.core.projects.create(
        owner,
        { name: "Replica memory" },
      );
      const deploy = async (
        server: WorkServer,
        message: string,
        files: Record<string, string>,
      ) => {
        const deployed = await server.catamorphic.core.deployment.deploy(
          owner.tenantId,
          projectId,
          owner.externalUserId,
          { message, files },
        );
        expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
      };
      await deploy(a, "Run agents on workers", {
        ".work/project.json": project({ build: BUILD }),
        ".work/roles/member.json": role(["build"]),
      });
      await b.catamorphic.core.memberships.grant({
        identity: owner,
        projectId,
        externalUserId: owner.externalUserId,
        roles: ["member"],
      });
      const memberOn = async (server: WorkServer) => {
        const member = await server.catamorphic.core.memberships.identityFor({
          ...owner,
          projectId,
        });
        if (!member) throw new Error("Membership missing");
        return member;
      };
      const sessions = (server: WorkServer) => {
        const service = server.catamorphic.core.agentSessions;
        if (!service) throw new Error("Agent sessions are not configured");
        return service;
      };
      const db = b.catamorphic.core.db;

      // One worker, reaching a random replica on every call.
      const enrollment = await a.operatorApp.inject({
        method: "POST",
        url: "/_work/operator/workers",
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name: "builder", trusted: true }),
      });
      expect(enrollment.statusCode).toBe(201);
      worker = await startWorkWorker({
        controlPlaneUrl: "http://127.0.0.1:1",
        dataDir: path.join(root, "worker"),
        enrollmentCode: enrollment.json().code,
        execution: executionSettingsFromEnv({
          PATH: process.env.PATH,
          WORK_MAX_WORKSPACES: "4",
        }),
        fetch: async (input, init) => {
          const url = new URL(input);
          const origin = origins[Math.floor(Math.random() * origins.length)];
          return globalThis.fetch(`${origin}${url.pathname}`, init);
        },
      });
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom("worker_nodes")
                .select("id")
                .where("id", "=", "worker.builder")
                .where("lease_expires_at", ">", new Date())
                .executeTakeFirst()
            )?.id,
          { timeout: 20_000 },
        )
        .toBeTruthy();

      const turnRow = (turnId: string) =>
        db
          .selectFrom("agent_turns")
          .select(["status", "activity", "lease_owner", "completed_at"])
          .where("id", "=", turnId)
          .executeTakeFirstOrThrow();
      const enqueue = async (
        server: WorkServer,
        sessionId: string,
        message: string,
      ) =>
        enqueueMessage({
          sessions: sessions(server),
          identity: await memberOn(server),
          projectId,
          sessionId,
          text: message,
        });
      /**
       * Wait until a replica runs the turn, its harness at work, and name
       * the replica running it and the other one.
       */
      const working = async (turnId: string) => {
        await expect
          .poll(async () => (await turnRow(turnId)).status === "running", {
            timeout: 60_000,
            interval: 50,
          })
          .toBe(true);
        // The harness is inside its command, not still anchoring.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const leaseOwner = (await turnRow(turnId)).lease_owner;
        const running = servers.find(
          (server) => sessions(server).turnWorkerId === leaseOwner,
        );
        const other = servers.find((server) => server !== running);
        if (!running || !other) throw new Error("No replica runs the turn");
        return { running, other };
      };
      const settled = async (turnId: string) => {
        await expect
          .poll(async () => (await turnRow(turnId)).status, {
            timeout: 60_000,
            interval: 50,
          })
          .toMatch(/^(completed|failed|interrupted|cancelled)$/);
        const turn = await turnRow(turnId);
        const reply = await db
          .selectFrom("agent_items")
          .select("text as content")
          .where("turn_id", "=", turnId)
          .where("kind", "=", "assistant_message")
          .orderBy("position", "desc")
          .executeTakeFirst();
        return { ...turn, reply };
      };
      const runningOn = async (server: WorkServer, sessionId: string) =>
        (
          await sessions(server).get(
            await memberOn(server),
            projectId,
            sessionId,
          )
        ).running;

      // 1. A running turn is running on both replicas, and a change to the
      // chat is refused on the one not running it.
      const chat = await sessions(b).create(await memberOn(b), projectId, {});
      let turnId = await enqueue(b, chat.id, "run sleep 8");
      let { running, other } = await working(turnId);
      expect(await runningOn(running, chat.id)).toBe(true);
      expect(await runningOn(other, chat.id)).toBe(true);
      await expect(
        sessions(other).update(await memberOn(other), projectId, chat.id, {
          effort: "high",
        }),
      ).rejects.toBeInstanceOf(AgentTurnInProgressError);

      // 2. An interrupt through the other replica stops the quiet turn
      // within about a second (#155).
      const interruptedAt = Date.now();
      await sessions(other).interrupt(
        await memberOn(other),
        projectId,
        chat.id,
      );
      // The agent stops working: its harness ended and the turn saves.
      await expect
        .poll(async () => (await turnRow(turnId)).status === "running", {
          timeout: 10_000,
          interval: 20,
        })
        .toBe(false);
      const stopMs = Date.now() - interruptedAt;
      let result = await settled(turnId);
      const settleMs = Date.now() - interruptedAt;
      console.info(
        `An interrupt through the other replica stopped the agent in ${stopMs} ms; the turn settled in ${settleMs} ms`,
      );
      // About a second; the margin absorbs a loaded CI machine.
      expect(stopMs).toBeLessThan(5_000);
      expect(result.status).toBe("interrupted");
      expect(await runningOn(a, chat.id)).toBe(false);
      expect(await runningOn(b, chat.id)).toBe(false);

      // 3. A question a replica's harness holds waits there; its answer,
      // sent through either replica, continues where it was asked (ADR
      // 0198).
      const questions = await sessions(a).create(
        await memberOn(a),
        projectId,
        {},
      );
      for (const [index, color] of ["Blue", "Green", "Red"].entries()) {
        const asked = await enqueue(a, questions.id, "ask Which color?");
        // The turn waits for its person, still claimed.
        await expect
          .poll(async () => (await turnRow(asked)).status, {
            timeout: 60_000,
            interval: 50,
          })
          .toBe("waiting");
        const through = index % 2 === 0 ? a : b;
        const request = (
          await sessions(through).get(
            await memberOn(through),
            projectId,
            questions.id,
          )
        ).snapshot.requests.find((entry) => entry.status === "pending");
        if (!request) throw new Error("No question");
        const receipt = await sessions(through).command(
          await memberOn(through),
          projectId,
          questions.id,
          {
            type: "respond",
            commandId: randomUUID(),
            requestId: request.id,
            response: { kind: "question", answers: [color] },
          },
        );
        expect(receipt.status).toBe("accepted");
        result = await settled(asked);
        expect(result.reply?.content).toBe(`Answered where asked: ${color}`);
        expect(result.status).toBe("completed");
      }

      // 4. Close through the other replica mid-turn: the running turn stops
      // first, then the workspace is given back.
      const closing = await sessions(b).create(
        await memberOn(b),
        projectId,
        {},
      );
      turnId = await enqueue(b, closing.id, "run sleep 8");
      ({ running, other } = await working(turnId));
      const allocationId = (
        await db
          .selectFrom("agent_sessions")
          .select("allocation_id")
          .where("id", "=", closing.id)
          .executeTakeFirstOrThrow()
      ).allocation_id;
      if (!allocationId) throw new Error("No workspace");
      const closed = await sessions(other).close(
        await memberOn(other),
        projectId,
        closing.id,
      );
      expect(closed.status).toBe("closed");
      result = await settled(turnId);
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom("execution_allocations")
                .select("status")
                .where("id", "=", allocationId)
                .executeTakeFirstOrThrow()
            ).status,
          { timeout: 10_000 },
        )
        .toBe("released");
      const released = await db
        .selectFrom("execution_allocations")
        .select("released_at")
        .where("id", "=", allocationId)
        .executeTakeFirstOrThrow();
      expect(result.completed_at?.getTime()).toBeLessThanOrEqual(
        released.released_at?.getTime() ?? 0,
      );

      // 5. Archive through the other replica mid-turn does the same.
      const archivable = await sessions(b).create(
        await memberOn(b),
        projectId,
        {},
      );
      turnId = await enqueue(b, archivable.id, "run sleep 8");
      ({ running, other } = await working(turnId));
      const archivableAllocation = (
        await db
          .selectFrom("agent_sessions")
          .select("allocation_id")
          .where("id", "=", archivable.id)
          .executeTakeFirstOrThrow()
      ).allocation_id;
      if (!archivableAllocation) throw new Error("No workspace");
      await sessions(other).archive(
        await memberOn(other),
        projectId,
        archivable.id,
        { confirmStop: true },
      );
      result = await settled(turnId);
      const archived = await db
        .selectFrom("execution_allocations")
        .select(["status", "released_at"])
        .where("id", "=", archivableAllocation)
        .executeTakeFirstOrThrow();
      expect(archived.status).toBe("released");
      expect(result.completed_at?.getTime()).toBeLessThanOrEqual(
        archived.released_at?.getTime() ?? 0,
      );

      // 6. A deploy through a adds This machine for members; b applies it
      // at once, although it just read the old roles and program.
      const runners = b.catamorphic.core.clientRunners;
      if (!runners) throw new Error("Client execution is unavailable");
      const register = async () => {
        const member = await memberOn(b);
        const id = randomUUID();
        return runners.register({
          identity: { ...member, clientRunnerId: id },
          projectId,
          id,
          environment: "laptop",
          label: "Laptop",
          workspaceRoot: "/workspace",
        });
      };
      await expect(register()).rejects.toThrow();
      await deploy(a, "Members run agents on their own machines", {
        ".work/project.json": project({ build: BUILD, laptop: LAPTOP }),
        ".work/roles/member.json": role(["build", "laptop"]),
      });
      await expect(register()).resolves.toMatchObject({
        token: expect.any(String),
      });
    } finally {
      await worker?.stop();
      for (const server of servers.reverse()) await server.shutdown();
      await fs.rm(root, { recursive: true, force: true });
      await database.drop();
    }
  },
  300_000,
);
