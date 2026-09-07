import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DurableToolPermissionBroker,
  WorkerNodesService,
} from "@catamorphic/core";
import {
  EncryptedCredentialVault,
  PostgresObjectStore,
} from "@catamorphic/server-sdk";
import { expect, it } from "vitest";
import {
  buildStockServer,
  SERVER_TENANT_ID,
  type StockServer,
} from "./server.js";

it.skipIf(!process.env.DATABASE_URL)(
  "two stock instances share state and execute only on the selected machine",
  async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "catamorphic-cluster-"),
    );
    const servers: StockServer[] = [];
    const common = {
      publicBases: ["https://cluster.example.test"],
      env: {
        DATABASE_URL: process.env.DATABASE_URL,
        BETTER_AUTH_SECRET: "cluster-test-secret-with-at-least-32-characters",
        CATAMORPHIC_FAKE_AGENT: "1",
        PATH: process.env.PATH,
      },
    };
    try {
      const opened = await Promise.allSettled(
        ["a", "b"].map(async (name) => {
          const server = await buildStockServer({
            ...common,
            dataDir: path.join(dir, name),
            env: { ...common.env, CATAMORPHIC_MACHINE_NAME: name },
          });
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
      const account = await a.stockAuth.createLocalUser({
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
            ".catamorphic/project.json": JSON.stringify({
              environments: {
                primary: { binding: aHealth.machine.id, workloads: ["agent"] },
                secondary: {
                  binding: bHealth.machine.id,
                  workloads: ["agent"],
                },
              },
              defaultEnvironment: "primary",
              defaultAgent: "researcher",
            }),
            "agents/researcher.json": JSON.stringify({
              version: 1,
              name: "Researcher",
              kind: "builtin",
              environment: { allowed: ["secondary"], preferred: ["secondary"] },
            }),
            "agents/researcher.md": "Use the shared company sources.",
            "roles/member.json": JSON.stringify({
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
      await a.catamorphic.core.agentSessions!.enqueueMessage(
        member,
        project.id,
        session.id,
        "execution-location",
      );
      await expect
        .poll(
          async () =>
            (
              await a.catamorphic.core.agentSessions!.get(
                member,
                project.id,
                session.id,
              )
            ).messages.find((message) => message.role === "assistant")?.content,
          { timeout: 15000 },
        )
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
        key: vaultKey,
      });
      const vaultB = new EncryptedCredentialVault({
        store: storeB,
        key: vaultKey,
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
      const brokerA = new DurableToolPermissionBroker(
        a.catamorphic.core.db,
        5000,
      );
      const brokerB = new DurableToolPermissionBroker(
        b.catamorphic.core.db,
        5000,
      );
      const permission = brokerA.handlerFor("Researcher")({
        sessionId: session.id,
        server: "crm",
        tool: "update",
        input: {},
      });
      await expect
        .poll(async () => (await brokerB.list(session.id)).length)
        .toBe(1);
      const pending = (await brokerB.list(session.id))[0];
      if (!pending) throw new Error("Permission request missing");
      expect(
        await brokerB.answer(pending.id, { decision: "allow" }, member),
      ).toBe(true);
      expect(await permission).toEqual({ decision: "allow" });
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
    }
  },
  60000,
);

async function crossInstanceToken(
  a: StockServer,
  b: StockServer,
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
