import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import type { AgentMode } from "@catamorphic/sandbox";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  ConnectionActionDeniedError,
  ConnectionBroker,
} from "../services/connection-broker.js";
import {
  type ConnectionProvider,
  ConnectionProviderRegistry,
} from "../services/connection-providers.js";
import { ConnectionsService } from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";

const db = new Kysely<DB>({
  dialect: new PGliteDialect({
    pglite: new PGlite({ extensions: { pgcrypto } }),
  }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const admin: Identity = { tenantId, externalUserId: "admin" };

const invoked: string[] = [];
/** Declares which actions read, like the HTTP and Postgres providers. */
const declared: ConnectionProvider = {
  kind: "declared",
  displayName: "Declared",
  readOnly: (action) => action === "users.list",
  invoke: async ({ action }) => {
    invoked.push(`declared:${action}`);
    return { ok: true };
  },
};
/** Says so only through tool annotations, like an MCP connection. */
const annotated: ConnectionProvider = {
  kind: "annotated",
  displayName: "Annotated",
  listActions: async () => [
    {
      name: "search",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    { name: "post", inputSchema: {} },
  ],
  invoke: async ({ action }) => {
    invoked.push(`annotated:${action}`);
    return { ok: true };
  },
};

describe("connection actions by agent mode (ADR 0176)", () => {
  const providers = new ConnectionProviderRegistry([declared, annotated]);
  const connections = new ConnectionsService(
    db,
    new MemoryCredentialVault(),
    providers,
  );
  const allocations = new ExecutionAllocationsService(db);
  let mode: AgentMode | undefined = "read-only";
  const broker = new ConnectionBroker(
    connections,
    providers,
    allocations,
    undefined,
    { guards: [], sessionMode: async () => mode },
  );
  let allocationId = "";

  beforeAll(async () => {
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "P" })
      .execute();
    for (const [alias, kind, capabilities] of [
      ["directory", "declared", ["users.list", "users.disable"]],
      ["chat", "annotated", ["search", "post"]],
    ] as const) {
      const service = await connections.create({
        identity: admin,
        projectId,
        providerKind: kind,
        principalKind: "project_service",
        label: alias,
        material: new TextEncoder().encode(`${alias}-token`),
        capabilities: [...capabilities],
      });
      await connections.bind({
        identity: admin,
        projectId,
        environment: "review",
        alias,
        providerKind: kind,
        principalKinds: ["project_service"],
        serviceConnectionId: service.id,
        capabilities: [...capabilities],
      });
    }
    const resolved = await connections.resolve({
      identity: admin,
      projectId,
      environment: "review",
      aliases: ["directory", "chat"],
      principalsByAlias: { directory: "service", chat: "service" },
    });
    allocationId = (
      await allocations.create({
        identity: admin,
        projectId,
        environmentName: "review",
        workloadKind: "agent",
        rootWorkloadId: crypto.randomUUID(),
        policy: {
          binding: {
            id: "managed",
            label: "Managed",
            trust: "managed",
            isolation: "sandbox",
            workloads: ["agent"],
            agentTopologies: ["controller"],
            capabilities: [],
            resources: {},
          },
          requirements: { workload: "agent", topology: "controller" },
          connections: resolved,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
  });

  const call = (alias: string, action: string, caller = "agent" as const) =>
    broker.invoke({
      identity: admin,
      allocationId,
      alias,
      action,
      input: {},
      caller,
      agentSessionId: "session-1",
    });

  it("lets a read-only agent read and refuses what could change the system", async () => {
    mode = "read-only";
    invoked.length = 0;
    await expect(call("directory", "users.list")).resolves.toEqual({
      ok: true,
    });
    await expect(call("chat", "search")).resolves.toEqual({ ok: true });
    await expect(call("directory", "users.disable")).rejects.toBeInstanceOf(
      ConnectionActionDeniedError,
    );
    await expect(call("chat", "post")).rejects.toThrow("read-only mode");
    expect(invoked).toEqual(["declared:users.list", "annotated:search"]);
    const denied = (await connections.listAudit({ identity: admin, projectId }))
      .filter((event) => event.outcome === "denied")
      .map((event) => event.action);
    expect(denied).toEqual(expect.arrayContaining(["users.disable", "post"]));
  });

  it("lets edit and full-access agents use what the binding grants", async () => {
    for (const next of ["edit", "full-access", undefined] as const) {
      mode = next;
      await expect(call("directory", "users.disable")).resolves.toEqual({
        ok: true,
      });
      await expect(call("chat", "post")).resolves.toEqual({ ok: true });
    }
  });
});
