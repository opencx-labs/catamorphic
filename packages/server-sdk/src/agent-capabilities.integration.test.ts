import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentCapabilityOptions,
  defineAgentCapability,
  type Identity,
} from "@catamorphic/core";
import { type DB, DEFAULT_SCHEMA } from "@catamorphic/db";
import { createApp, identityFromBearer } from "@catamorphic/fastify-plugin";
import type { AgentCapabilityGateway } from "@catamorphic/sandbox";
import { HttpAgentCapabilityGateway } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { type Catamorphic, createCatamorphic } from "./catamorphic.js";
import { defineStaticEnvironments } from "./static-environments.js";

let root: string;
let db: Kysely<DB>;
let controller: ReturnType<typeof createApp>;
let http: AgentCapabilityGateway;
let allocationId: string;
let cat: Catamorphic;
let gateway: AgentCapabilityGateway;
let projectId: string;
let sessionId: string;
let permitted = true;
let revokeDuringApproval = false;
let executions = 0;
let memberIdentity: Identity | null = null;
let identityResolutions = 0;
let normalizations = 0;
let approvedInput: unknown;
let outputText = "";
let cancelOnStart: AbortController | undefined;
let revokeOnStart = false;
const events: string[] = [];
const alice: Identity = {
  tenantId: crypto.randomUUID(),
  externalUserId: "alice",
};
const options: AgentCapabilityOptions = {
  currentUser: async () => ({
    displayName: "Alice",
    timeZone: "Asia/Amman",
    secret: "must-not-appear",
  }),
  beforeInvoke: async ({ input }) => {
    approvedInput = input;
    if (revokeDuringApproval) permitted = false;
  },
  onEvent: (event) => {
    events.push(event.type);
    if (event.type === "started") {
      cancelOnStart?.abort();
      if (revokeOnStart) permitted = false;
    }
  },
  capabilities: [
    defineAgentCapability({
      name: "test.normalize",
      description: "Normalize input once before approval and execution",
      effect: "read",
      inputSchema: z.object({
        value: z.number().overwrite((value) => {
          normalizations++;
          return value + 1;
        }),
      }),
      outputSchema: z.object({ value: z.number() }),
      authorize: () => true,
      execute: async (_context, input) => input,
    }),
    defineAgentCapability({
      name: "test.output",
      description: "Return test output for the wire limit",
      effect: "read",
      inputSchema: z.object({}).strict(),
      outputSchema: z.string(),
      authorize: () => true,
      execute: async () => outputText,
    }),
    defineAgentCapability({
      name: "people.search",
      description: "Search the permitted project directory",
      effect: "read",
      inputSchema: z.object({ query: z.string() }).strict(),
      outputSchema: z.object({
        items: z.array(z.object({ id: z.string(), displayName: z.string() })),
      }),
      authorize: ({ identity }) =>
        permitted && identity.externalUserId === "alice",
      execute: async (_context, input) => {
        executions++;
        return {
          items:
            input.query === "Bob" ? [{ id: "bob", displayName: "Bob" }] : [],
        };
      },
    }),
  ],
};
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-capabilities-"));
  db = new Kysely<DB>({
    dialect: new PGliteDialect({
      pglite: new PGlite({ extensions: { pgcrypto } }),
    }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  cat = createCatamorphic({
    hostId: "controller",
    database: { db },
    storage: {
      projectsPath: path.join(root, "projects"),
      remotesPath: path.join(root, "remotes"),
    },
    projectSeeds: () => ({}),
    environmentProvider: defineStaticEnvironments([
      {
        descriptor: {
          id: "local",
          label: "Development",
          trust: "local",
          isolation: "process",
          workloads: ["agent"],
          agentTopologies: ["native"],
          capabilities: ["docker"],
          resources: {},
        },
      },
    ]),
    agentCapabilities: options,
    resolveMemberIdentity: async () => {
      identityResolutions++;
      return memberIdentity;
    },
  });
  await cat.migrate();
  await sql.raw(`SET search_path TO "${DEFAULT_SCHEMA}", public`).execute(db);
  projectId = (
    await cat.core.projects.create(alice, { name: "Shared project" })
  ).id;
  sessionId = crypto.randomUUID();
  await db
    .insertInto("agent_sessions")
    .values({
      id: sessionId,
      project_id: projectId,
      external_user_id: alice.externalUserId,
      provider: "fixture",
      agent_id: "assistant",
    })
    .execute();
  const allocation = await cat.core.executionAllocations.create({
    identity: alice,
    projectId,
    environmentName: "local",
    workloadKind: "agent",
    rootWorkloadId: sessionId,
    policy: {
      binding: {
        id: "local",
        label: "Development",
        trust: "local",
        isolation: "process",
        workloads: ["agent"],
        agentTopologies: ["native"],
        capabilities: ["docker"],
        resources: {},
      },
      requirements: { workload: "agent", topology: "native" },
    },
  });
  allocationId = allocation.id;
  await db
    .updateTable("agent_sessions")
    .set({ allocation_id: allocationId })
    .where("id", "=", sessionId)
    .execute();
  controller = createApp({
    core: cat.core,
    identity: identityFromBearer((token) =>
      token === "test-only" ? alice : null,
    ),
  });
  const base = await controller.listen({ port: 0, host: "127.0.0.1" });
  http = new HttpAgentCapabilityGateway({
    url: `${base}/api/projects/${projectId}/agent/sessions/${sessionId}/capabilities`,
    headers: () => ({ authorization: "Bearer test-only" }),
  });
  gateway = cat
    .forTenant({ tenantId: alice.tenantId })
    .forUser({ externalUserId: alice.externalUserId })
    .capabilities({ projectId, sessionId });
}, 60_000);
afterAll(async () => {
  await cat?.close();
  await controller?.close();
  await db?.destroy();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  permitted = true;
  revokeDuringApproval = false;
  executions = 0;
  events.length = 0;
  memberIdentity = null;
  identityResolutions = 0;
  normalizations = 0;
  approvedInput = undefined;
  outputText = "";
  cancelOnStart = undefined;
  revokeOnStart = false;
});

it("keeps context small and excludes other users, credentials, and permission lists", async () => {
  const value = await gateway.invoke({
    name: "context.read",
    input: {},
    requestId: "self",
  });
  expect(value).toMatchObject({
    currentUser: { id: "alice", displayName: "Alice" },
    agentLoopHost: null,
    environment: "local",
    execution: {
      declaredCapabilities: ["docker"],
      harnessSandbox: "provider_configured",
    },
  });
  expect(
    await cat.core.agentCapabilities.prompt({
      identity: alice,
      projectId,
      sessionId,
    }),
  ).toContain('"agentLoopHost":"controller"');
  expect(JSON.stringify(value)).not.toMatch(
    /must-not-appear|Bob|executionScope|connectionScope/,
  );
});
it("discovers only matching authorized schemas and rechecks visibility after revocation", async () => {
  const page = await gateway.discover({ query: "people" });
  expect(page.items.map((item) => item.name)).toEqual(["people.search"]);
  expect(page.items[0]?.inputSchema).toHaveProperty("properties.query");
  const value = await gateway.invoke({
    name: "people.search",
    input: { query: "Bob" },
    requestId: "people",
  });
  expect(value).toEqual({ items: [{ id: "bob", displayName: "Bob" }] });
  permitted = false;
  expect((await gateway.discover({ query: "people" })).items).toEqual([]);
  await expect(
    gateway.invoke({
      name: "people.search",
      input: { query: "Bob" },
      requestId: "people-again",
    }),
  ).rejects.toThrow();
  expect(executions).toBe(1);
});
it("rejects malformed and identity-spoofing input before executing", async () => {
  await expect(
    gateway.invoke({
      name: "people.search",
      input: { query: "Bob", identity: alice },
      requestId: "spoof",
    }),
  ).rejects.toThrow();
  expect(executions).toBe(0);
});
it("rechecks after approval and honors cancellation before side effects", async () => {
  revokeDuringApproval = true;
  await expect(
    gateway.invoke({
      name: "people.search",
      input: { query: "Bob" },
      requestId: "revoked",
    }),
  ).rejects.toThrow();
  permitted = true;
  revokeDuringApproval = false;
  await expect(
    gateway.invoke({
      name: "people.search",
      input: { query: "Bob" },
      requestId: "cancelled",
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(executions).toBe(0);
});
it("binds discovery to the project and session and paginates without loading the catalogue", async () => {
  const other = cat.core.agentCapabilities.forSession({
    identity: { ...alice, tenantId: crypto.randomUUID() },
    projectId,
    sessionId,
  });
  await expect(other.discover({})).rejects.toThrow();
  const wrongProject = cat.core.agentCapabilities.forSession({
    identity: alice,
    projectId: crypto.randomUUID(),
    sessionId,
  });
  await expect(wrongProject.discover({})).rejects.toThrow();
  const page = await gateway.discover({ limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeDefined();
  const next = await gateway.discover({ limit: 1, cursor: page.nextCursor });
  expect(next.items[0]?.name).not.toBe(page.items[0]?.name);
});
it("serves the same typed operations over authenticated HTTP", async () => {
  expect(
    (await http.discover({ query: "people" })).items.map((item) => item.name),
  ).toEqual(["people.search"]);
  expect(
    await http.invoke({
      name: "people.search",
      input: { query: "Bob" },
      requestId: "http-people",
    }),
  ).toEqual({ items: [{ id: "bob", displayName: "Bob" }] });
  permitted = false;
  await expect(
    http.invoke({
      name: "people.search",
      input: { query: "Bob" },
      requestId: "http-revoked",
    }),
  ).rejects.toThrow("403");
  expect(executions).toBe(1);
});
it("fences a gateway to its original Allocation", async () => {
  const stale = cat.core.agentCapabilities.forSession({
    identity: alice,
    projectId,
    sessionId,
    allocationId: crypto.randomUUID(),
  });
  await expect(stale.discover({})).rejects.toThrow();
  const pinned = cat.core.agentCapabilities.forSession({
    identity: alice,
    projectId,
    sessionId,
    allocationId,
  });
  expect((await pinned.discover({ query: "assignment" })).items).toHaveLength(
    1,
  );
});
it("advertises only the two bootstrap tools through MCP", async () => {
  const response = await controller.inject({
    method: "POST",
    url: `/api/projects/${projectId}/mcp?sessionId=${sessionId}`,
    headers: { authorization: "Bearer test-only" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(response.statusCode).toBe(200);
  const body = z
    .object({
      result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
    })
    .parse(response.json());
  const names = body.result.tools.map((tool) => tool.name);
  expect(names).toContain("discover_capabilities");
  expect(names).toContain("invoke_capability");
  expect(names).not.toContain("people.search");
  expect(names).not.toContain("environments.list");
});

it("refreshes member authority without treating host root identities as members", async () => {
  await gateway.discover({ query: "context" });
  expect(identityResolutions).toBe(0);
  const scoped: Identity = {
    ...alice,
    scope: [{ kind: "project", projectId }],
    executionScope: [{ projectId, name: "local" }],
  };
  memberIdentity = scoped;
  const memberGateway = cat.core.agentCapabilities.forSession({
    identity: scoped,
    projectId,
    sessionId,
    allocationId,
  });
  expect(
    (await memberGateway.discover({ query: "context" })).items,
  ).toHaveLength(1);
  expect(identityResolutions).toBe(1);
  memberIdentity = { ...scoped, scope: [], executionScope: [] };
  await expect(
    memberGateway.invoke({
      name: "context.read",
      input: {},
      requestId: "revoked-member",
    }),
  ).rejects.toThrow();
});

it("never widens a narrowed caller when membership refresh returns broader grants", async () => {
  const scoped: Identity = {
    ...alice,
    scope: [{ kind: "project", projectId }],
    executionScope: [],
  };
  memberIdentity = alice;
  const value = await cat.core.agentCapabilities
    .forSession({
      identity: scoped,
      projectId,
      sessionId,
    })
    .invoke({ name: "environments.list", input: {}, requestId: "no-widening" });
  expect(value).toEqual({ items: [] });
});

it("uses the same normalized input for approval and execution", async () => {
  const result = await gateway.invoke({
    name: "test.normalize",
    input: { value: 1 },
    requestId: "normalize-once",
  });
  expect(approvedInput).toEqual({ value: 2 });
  expect(result).toEqual(approvedInput);
  expect(normalizations).toBe(1);
});

it("enforces the output limit in UTF-8 bytes", async () => {
  outputText = "界".repeat(400_000);
  await expect(
    gateway.invoke({
      name: "test.output",
      input: {},
      requestId: "large-output",
    }),
  ).rejects.toThrow("1 MiB");
  expect(events).toEqual(["started", "failed"]);
  outputText = "a".repeat(400_000);
  expect(
    await gateway.invoke({
      name: "test.output",
      input: {},
      requestId: "bounded-output",
    }),
  ).toBe(outputText);
});

it("honors cancellation and revocation during awaited activity reporting", async () => {
  cancelOnStart = new AbortController();
  await expect(
    gateway.invoke({
      name: "people.search",
      input: { query: "Bob" },
      requestId: "cancel-on-start",
      signal: cancelOnStart.signal,
    }),
  ).rejects.toThrow();
  expect(executions).toBe(0);
  expect(events).toEqual(["started", "failed"]);
  cancelOnStart = undefined;
  revokeOnStart = true;
  await expect(
    gateway.invoke({
      name: "people.search",
      input: { query: "Bob" },
      requestId: "revoke-on-start",
    }),
  ).rejects.toThrow();
  expect(executions).toBe(0);
});
