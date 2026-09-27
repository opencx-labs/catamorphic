import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import type { Sandboxing } from "@catamorphic/sandbox";
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
const admin: Identity = {
  tenantId,
  externalUserId: "admin",
  controlPlanePermissions: ["connections:read", "connections:write"],
};

/** Administrators authorize these fakes by pasting a token. */
const pastedToken = {
  beginAuthorization: async () => ({
    challenge: {
      kind: "form" as const,
      fields: [{ name: "code", label: "Token", secret: true, required: true }],
    },
  }),
  completeAuthorization: async ({
    callback,
  }: {
    callback: Readonly<Record<string, string>>;
  }) => ({
    material: new TextEncoder().encode(callback.code ?? ""),
    capabilities: ["users.list", "users.disable", "search", "post"],
  }),
};

const invoked: string[] = [];
/** Declares which actions read, like the HTTP and Postgres providers. */
const declared: ConnectionProvider = {
  kind: "declared",
  displayName: "Declared",
  ...pastedToken,
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
  ...pastedToken,
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

describe("connection actions by agent sandboxing (ADR 0182)", () => {
  const providers = new ConnectionProviderRegistry([declared, annotated]);
  const connections = new ConnectionsService({
    db,
    vault: new MemoryCredentialVault(),
    providers,
    // What `.work/project.json` commits for the `review` Environment.
    bindings: async () => ({
      directory: {
        provider: "declared",
        principal: "service",
        service: "directory",
        capabilities: ["users.list", "users.disable"],
      },
      chat: {
        provider: "annotated",
        principal: "service",
        service: "chat",
        capabilities: ["search", "post"],
      },
    }),
  });
  const allocations = new ExecutionAllocationsService(db);
  let sandboxing: Sandboxing | undefined = "contained";
  const broker = new ConnectionBroker(
    connections,
    providers,
    allocations,
    undefined,
    { guards: [], sessionSandboxing: async () => sandboxing },
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
    for (const [name, kind] of [
      ["directory", "declared"],
      ["chat", "annotated"],
    ] as const) {
      const service = await connections.createService({
        identity: admin,
        name,
        providerKind: kind,
        principalKind: "project_service",
        projectId,
      });
      const started = await connections.beginServiceAuthorization({
        identity: admin,
        connectionId: service.id,
        redirectUri: "https://work.test/api/connection-authorizations/callback",
      });
      await connections.completeAuthorization({
        identity: admin,
        state: started.authorizationId,
        callback: { code: `${name}-token` },
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

  it("lets a contained agent read and refuses what could change the system", async () => {
    sandboxing = "contained";
    invoked.length = 0;
    await expect(call("directory", "users.list")).resolves.toEqual({
      ok: true,
    });
    await expect(call("chat", "search")).resolves.toEqual({ ok: true });
    await expect(call("directory", "users.disable")).rejects.toBeInstanceOf(
      ConnectionActionDeniedError,
    );
    await expect(call("chat", "post")).rejects.toThrow(
      "This agent's sandboxing is contained",
    );
    expect(invoked).toEqual(["declared:users.list", "annotated:search"]);
    const denied = (await connections.listAudit({ identity: admin, projectId }))
      .filter((event) => event.outcome === "denied")
      .map((event) => event.action);
    expect(denied).toEqual(expect.arrayContaining(["users.disable", "post"]));
  });

  it("lets propose and publish agents use what the binding grants", async () => {
    for (const next of ["propose", "publish", undefined] as const) {
      sandboxing = next;
      await expect(call("directory", "users.disable")).resolves.toEqual({
        ok: true,
      });
      await expect(call("chat", "post")).resolves.toEqual({ ok: true });
    }
  });
});
