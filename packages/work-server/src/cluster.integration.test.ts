import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import {
  EncryptedCredentialVault,
  PostgresObjectStore,
} from "@catamorphic/server-sdk";
import pg from "pg";
import { expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import {
  createTestDatabase,
  enqueue,
  testServerOptions,
} from "./test-support.js";

it.skipIf(!process.env.DATABASE_URL)(
  "two Work server instances share state and execute only on the selected machine",
  async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-cluster-"),
    );
    const servers: WorkServer[] = [];
    const database = await createTestDatabase("work_cluster");
    const common = {
      publicBases: ["https://cluster.example.test"],
      env: {
        DATABASE_URL: database.url,
        WORK_SECRET: "cluster-test-secret-with-at-least-32-characters",
        WORK_OPERATOR_SECRET: "cluster-test-operator-secret-with-32-characters",
        WORK_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        // Trusted test replicas run agents as subprocesses (ADR 0164).
        WORK_TRUST_CONTROL_PLANE_AGENTS: "1",
        WORK_FAKE_AGENT: "1",
        PATH: process.env.PATH,
      },
    };
    try {
      const opened = await Promise.allSettled(
        ["a", "b"].map(async (name) => {
          const server = await createWorkServer(
            testServerOptions({
              ...common,
              dataDir: path.join(dir, name),
              env: { ...common.env, WORK_MACHINE_NAME: name },
            }),
          );
          servers.push(server);
          return server;
        }),
      );
      for (const result of opened)
        if (result.status === "rejected") throw result.reason;
      const a = servers.find((server) => server === servers[0]);
      const b = servers[1];
      if (!a || !b) throw new Error("Both machines must boot");
      const aHealth = (
        await a.app.inject({ method: "GET", url: "/healthz" })
      ).json();
      const bHealth = (
        await b.app.inject({ method: "GET", url: "/healthz" })
      ).json();
      const account = await a.workAuth.createLocalUser({
        username: "clustermember",
        name: "Cluster member",
        password: "cluster-member-test-password",
      });
      const accessToken = await crossInstanceToken(a, b);
      const identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: account.id,
      };
      const project = await a.catamorphic.core.projects.create(identity, {
        name: "Company brain",
      });
      await a.catamorphic.core.deployment.deploy(
        identity.tenantId,
        project.id,
        identity.externalUserId,
        {
          message: "Configure machine policy",
          files: {
            ".work/project.json": JSON.stringify({
              environments: {
                primary: {
                  pool: { node: aHealth.machine.id },
                  workloads: ["agent"],
                },
                secondary: {
                  pool: { node: bHealth.machine.id },
                  workloads: ["agent"],
                },
              },
              defaultEnvironment: "primary",
              defaultAgent: "researcher",
            }),
            ".work/agents/researcher.json": JSON.stringify({
              version: 1,
              name: "Researcher",
              kind: "builtin",
              environment: { allowed: ["secondary"], preferred: ["secondary"] },
            }),
            ".work/agents/researcher.md": "Use the shared company sources.",
            ".work/roles/member.json": JSON.stringify({
              version: 1,
              name: "Member",
              agents: ["researcher"],
              environments: ["primary", "secondary"],
            }),
          },
        },
      );
      await a.catamorphic.core.memberships.grant({
        identity,
        projectId: project.id,
        externalUserId: identity.externalUserId,
        roles: ["member"],
      });
      const member = await a.catamorphic.core.memberships.identityFor({
        ...identity,
        projectId: project.id,
      });
      if (!member) throw new Error("Membership missing");
      for (const server of [a, b]) {
        const me = await server.app.inject({
          method: "GET",
          url: "/api/me",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        expect(me.statusCode).toBe(200);
        expect(me.body).toContain(project.id);
      }

      const catalog = await b.catamorphic.core.agentSessions!.catalog({
        identity: member,
        projectId: project.id,
      });
      expect(catalog.defaultAgentId).toBe(`project:${project.id}:researcher`);
      expect(catalog.items).toHaveLength(1);
      expect(catalog.items[0]?.environments.defaultEnvironment).toBe(
        "secondary",
      );
      const session = await a.catamorphic.core.agentSessions!.create(
        member,
        project.id,
      );
      await enqueue({
        sessions: a.catamorphic.core.agentSessions!,
        identity: member,
        projectId: project.id,
        sessionId: session.id,
        text: "execution-location",
      });
      const answers = async (server: WorkServer) =>
        (
          await server.catamorphic.core.agentSessions!.transcript(
            member,
            project.id,
            session.id,
          )
        )
          .filter((message) => message.role === "assistant")
          .map((message) => message.content);
      await expect
        .poll(async () => (await answers(a))[0], { timeout: 15000 })
        .toContain(path.join(dir, bHealth.machine.label, "sandboxes"));
      expect(
        (
          await b.catamorphic.core.agentSessions!.get(
            member,
            project.id,
            session.id,
          )
        ).authorityHostId,
      ).toBe(
        (
          await a.catamorphic.core.agentSessions!.get(
            member,
            project.id,
            session.id,
          )
        ).authorityHostId,
      );
      const storeA = new PostgresObjectStore(a.catamorphic.core.db);
      const storeB = new PostgresObjectStore(b.catamorphic.core.db);
      const key = `tests/${randomUUID()}`;
      await storeA.put(key, new Uint8Array([0, 255, 42]), { ifNoneMatch: "*" });
      const record = await storeB.get(key);
      expect(record?.data).toEqual(new Uint8Array([0, 255, 42]));
      const races = await Promise.allSettled(
        [storeA, storeB].map((store) =>
          store.put(key, new Uint8Array([1]), { ifMatch: record?.etag }),
        ),
      );
      expect(
        races.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const vaultKey = new Uint8Array(32).fill(23);
      const vaultA = new EncryptedCredentialVault({
        store: storeA,
        keys: [vaultKey],
      });
      const vaultB = new EncryptedCredentialVault({
        store: storeB,
        keys: [vaultKey],
      });
      const ref = await vaultA.put({
        tenantId: identity.tenantId,
        material: Buffer.from("private credential"),
      });
      expect(
        await vaultB.withMaterial({
          tenantId: identity.tenantId,
          ref,
          use: (value) => Buffer.from(value).toString(),
        }),
      ).toBe("private credential");
      // A question asked through one replica is answered through the
      // other: the request and its answer live in Postgres (ADR 0197).
      await enqueue({
        sessions: a.catamorphic.core.agentSessions!,
        identity: member,
        projectId: project.id,
        sessionId: session.id,
        text: "ask Which region?",
      });
      const pendingRequest = async () =>
        (
          await b.catamorphic.core.agentSessions!.get(
            member,
            project.id,
            session.id,
          )
        ).snapshot.requests.find((request) => request.status === "pending");
      await expect
        .poll(async () => (await pendingRequest())?.answerable, {
          timeout: 15000,
        })
        .toBe(true);
      const request = await pendingRequest();
      if (!request) throw new Error("Question missing");
      const receipt = await b.catamorphic.core.agentSessions!.command(
        member,
        project.id,
        session.id,
        {
          type: "respond",
          commandId: randomUUID(),
          requestId: request.id,
          response: { kind: "question", answers: ["eu-west"] },
        },
      );
      expect(receipt.status).toBe("accepted");
      await expect
        .poll(async () => (await answers(a)).at(-1), { timeout: 15000 })
        .toBe("Answered where asked: eu-west");
      const nodes = new WorkerNodesService(a.catamorphic.core.db);
      await nodes.setEnabled({
        tenantId: identity.tenantId,
        authorityId: (
          await a.catamorphic.core.agentSessions!.get(
            member,
            project.id,
            session.id,
          )
        ).authorityHostId,
        nodeId: bHealth.machine.id,
        enabled: false,
      });
      await expect(
        a.catamorphic.core.agentSessions!.create(member, project.id),
      ).rejects.toThrow();
    } finally {
      await Promise.allSettled(servers.map((server) => server.shutdown()));
      await fs.rm(dir, { recursive: true, force: true });
      await database.drop();
    }
  },
  60000,
);

async function crossInstanceToken(
  a: WorkServer,
  b: WorkServer,
): Promise<string> {
  const login = await b.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    payload: {
      username: "clustermember",
      password: "cluster-member-test-password",
    },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.headers["set-cookie"];
  const redirectUri = "http://127.0.0.1:49152/callback";
  const registered = await a.app.inject({
    method: "POST",
    url: "/api/auth/mcp/register",
    payload: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Cluster integration",
    },
  });
  expect(registered.statusCode).toBe(201);
  const clientId = registered.json().client_id;
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "cluster-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorized = await b.app.inject({
    method: "GET",
    url: `/api/auth/mcp/authorize?${params}`,
    headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie },
  });
  expect(authorized.statusCode).toBe(302);
  const code = new URL(authorized.headers.location ?? "").searchParams.get(
    "code",
  );
  const token = await a.app.inject({
    method: "POST",
    url: "/api/auth/mcp/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: code ?? "",
      code_verifier: verifier,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  const refreshed = await b.app.inject({
    method: "POST",
    url: "/api/auth/mcp/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: token.json().refresh_token,
    }).toString(),
  });
  expect(refreshed.statusCode).toBe(200);
  return refreshed.json().access_token;
}

it.skipIf(!process.env.DATABASE_URL)(
  "a replica is a new machine at every start, gives it back on stop, and fails its health check once its lease lapsed",
  async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-replica-"),
    );
    const database = await createTestDatabase("work_replica");
    const options = testServerOptions({
      publicBases: ["https://replica.example.test"],
      dataDir: dir,
      env: {
        DATABASE_URL: database.url,
        WORK_SECRET: "replica-test-secret-with-at-least-32-characters",
        WORK_OPERATOR_SECRET: "replica-test-operator-secret-with-32-characters",
        WORK_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_FAKE_AGENT: "1",
        PATH: process.env.PATH,
      },
    });
    const servers: WorkServer[] = [];
    try {
      // A sandbox a previous process left behind belongs to no live node.
      await fs.mkdir(path.join(dir, "sandboxes", "orphan"), {
        recursive: true,
      });
      const first = await createWorkServer(options);
      servers.push(first);
      const health = await first.app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      const firstNode: string = health.json().machine.id;
      expect(firstNode).toMatch(/^node\.[0-9a-f-]{36}$/);
      // Nothing durable on disk: no machine identity, database, or origins.
      expect((await fs.readdir(dir)).sort()).toEqual(["projects", "sandboxes"]);
      expect(await fs.readdir(path.join(dir, "sandboxes"))).toEqual([]);
      const node = (id: string) =>
        (servers.at(-1) ?? first).catamorphic.core.db
          .selectFrom("worker_nodes")
          .select(["id", "disposable", "enabled"])
          .where("id", "=", id)
          .executeTakeFirst();
      expect(await node(firstNode)).toEqual({
        id: firstNode,
        disposable: true,
        enabled: true,
      });

      // Stopping gives the machine back for good; with no work on it, it
      // is gone at once.
      await first.shutdown();
      servers.pop();
      const second = await createWorkServer(options);
      servers.push(second);
      const secondNode: string = (
        await second.app.inject({ method: "GET", url: "/healthz" })
      ).json().machine.id;
      expect(secondNode).not.toBe(firstNode);
      expect(await node(firstNode)).toBeUndefined();

      const probe = async (url: "/healthz" | "/readyz") =>
        (await second.app.inject({ method: "GET", url })).statusCode;
      expect([await probe("/healthz"), await probe("/readyz")]).toEqual([
        200, 200,
      ]);

      // A database blip: renewals hang, but the lease is still valid. The
      // replica stops being ready and stays alive.
      const blocker = new pg.Client({ connectionString: database.url });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM catamorphic.worker_nodes WHERE id = $1 FOR UPDATE",
          [secondNode],
        );
        await expect
          .poll(() => probe("/readyz"), { timeout: 30_000, interval: 500 })
          .toBe(503);
        expect(await probe("/healthz")).toBe(200);
        await blocker.query("COMMIT");
      } finally {
        await blocker.end();
      }
      await expect
        .poll(() => probe("/readyz"), { timeout: 20_000, interval: 500 })
        .toBe(200);

      // Its lease lapses (the database was unreachable for too long, or an
      // operator disabled it): the lease can never be renewed.
      let lost = false;
      void second.lost.then(() => {
        lost = true;
      });
      await second.catamorphic.core.db
        .updateTable("worker_nodes")
        .set({ lease_expires_at: new Date(Date.now() - 1_000) })
        .where("id", "=", secondNode)
        .execute();
      await expect
        .poll(() => lost, { timeout: 20_000, interval: 500 })
        .toBe(true);
      const unhealthy = await second.app.inject({
        method: "GET",
        url: "/healthz",
      });
      expect(unhealthy.statusCode).toBe(503);
      expect(unhealthy.json()).toMatchObject({
        ok: false,
        machine: { id: secondNode },
      });
      expect(await probe("/readyz")).toBe(503);
    } finally {
      for (const server of servers) await server.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      await database.drop();
    }
  },
  120_000,
);

it("a Postgres deployment requires the operator credential every replica shares", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-operator-"));
  try {
    await expect(
      createWorkServer(
        testServerOptions({
          dataDir,
          env: {
            // Never contacted: configuration is checked first.
            DATABASE_URL: "postgres://127.0.0.1:1/unreachable",
            WORK_SECRET: "operator-guard-secret-with-at-least-32-chars",
            WORK_VAULT_KEY: Buffer.alloc(32, 3).toString("base64"),
            PATH: process.env.PATH,
          },
        }),
      ),
    ).rejects.toThrow(/WORK_OPERATOR_SECRET/);
    // Nothing was written into the replica's data directory.
    expect(await fs.readdir(dataDir)).toEqual([]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

it.skipIf(!process.env.DATABASE_URL)(
  "stopping a replica lets a running chat turn settle before its sandbox goes",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-sigterm-"));
    const database = await createTestDatabase("work_sigterm");
    const server = await createWorkServer(
      testServerOptions({
        publicBases: ["https://sigterm.example.test"],
        dataDir: dir,
        env: {
          DATABASE_URL: database.url,
          WORK_SECRET: "sigterm-test-secret-with-at-least-32-characters",
          WORK_OPERATOR_SECRET: "sigterm-test-operator-secret-with-32-chars",
          WORK_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
          WORK_TRUST_CONTROL_PLANE_AGENTS: "1",
          WORK_FAKE_AGENT: "1",
          PATH: process.env.PATH,
        },
      }),
    );
    let stopped = false;
    const admin = new pg.Client({ connectionString: database.url });
    try {
      const node: string = (
        await server.app.inject({ method: "GET", url: "/healthz" })
      ).json().machine.id;
      const identity = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: randomUUID(),
      };
      const core = server.catamorphic.core;
      const project = await core.projects.create(identity, { name: "Stop" });
      const sessions = core.agentSessions;
      if (!sessions) throw new Error("Agent sessions are not configured");
      const session = await sessions.create(identity, project.id);
      await enqueue({
        sessions,
        identity,
        projectId: project.id,
        sessionId: session.id,
        text: "run sleep 3 && echo finished",
      });
      await expect
        .poll(
          async () =>
            (
              await core.db
                .selectFrom("agent_turns")
                .select("status")
                .where("session_id", "=", session.id)
                .executeTakeFirst()
            )?.status,
          { timeout: 30_000, interval: 100 },
        )
        .toBe("running");

      // SIGTERM while the turn runs a command in its sandbox.
      await server.shutdown();
      stopped = true;
      await admin.connect();
      const turn = await admin.query(
        "SELECT status FROM catamorphic.agent_turns WHERE session_id = $1",
        [session.id],
      );
      expect(turn.rows).toEqual([{ status: "completed" }]);
      const reply = await admin.query(
        "SELECT text AS content FROM catamorphic.agent_items WHERE session_id = $1 AND kind = 'assistant_message'",
        [session.id],
      );
      expect(reply.rows[0]?.content).toContain("finished");
      // Only then did the machine go, and the chat's workspace with it.
      const allocation = await admin.query(
        "SELECT a.status, a.release_reason FROM catamorphic.agent_sessions s JOIN catamorphic.execution_allocations a ON a.id = s.allocation_id WHERE s.id = $1",
        [session.id],
      );
      expect(allocation.rows).toEqual([
        { status: "released", release_reason: "node_lost" },
      ]);
      const nodes = await admin.query(
        "SELECT id FROM catamorphic.worker_nodes WHERE id = $1",
        [node],
      );
      expect(nodes.rows).toEqual([]);
    } finally {
      if (!stopped) await server.shutdown();
      await admin.end().catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
      await database.drop();
    }
  },
  90_000,
);

it.skipIf(!process.env.DATABASE_URL)(
  "a replica whose renewals never settle counts its lease as lost once it could have lapsed",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-hung-"));
    const database = await createTestDatabase("work_hung");
    const server = await createWorkServer(
      testServerOptions({
        publicBases: ["https://hung.example.test"],
        dataDir: dir,
        env: {
          DATABASE_URL: database.url,
          WORK_SECRET: "hung-test-secret-with-at-least-32-characters",
          WORK_OPERATOR_SECRET: "hung-test-operator-secret-with-32-chars",
          WORK_VAULT_KEY: Buffer.alloc(32, 6).toString("base64"),
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          WORK_FAKE_AGENT: "1",
          PATH: process.env.PATH,
        },
      }),
    );
    const blocker = new pg.Client({ connectionString: database.url });
    try {
      const node: string = (
        await server.app.inject({ method: "GET", url: "/healthz" })
      ).json().machine.id;
      let lost = false;
      void server.lost.then(() => {
        lost = true;
      });
      // Every renewal from now on waits on this lock and never answers.
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM catamorphic.worker_nodes WHERE id = $1 FOR UPDATE",
        [node],
      );
      await expect
        .poll(() => lost, { timeout: 75_000, interval: 1_000 })
        .toBe(true);
      expect(
        (await server.app.inject({ method: "GET", url: "/healthz" }))
          .statusCode,
      ).toBe(503);
      await blocker.query("ROLLBACK");
    } finally {
      await blocker.end().catch(() => {});
      await server.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
      await database.drop();
    }
  },
  120_000,
);
