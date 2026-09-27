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

/** A Git host, reached only through the Git gateway (ADR 0175). */
const forge: ConnectionProvider = {
  kind: "forge",
  displayName: "Forge",
  ...pastedToken,
  completeAuthorization: async ({ callback }) => ({
    material: new TextEncoder().encode(callback.code ?? ""),
    capabilities: ["git:read", "git:write", "issues.list"],
  }),
  git: {
    remoteBaseUrls: ["https://forge.test"],
    credentials: async ({ access }) => ({
      username: "x-access-token",
      password: `token-${access}`,
    }),
  },
  readOnly: (action) => action === "issues.list",
  invoke: async ({ repositories }) => {
    forgeRepositories.push(repositories);
    return { ok: true };
  },
};
const forgeRepositories: Array<readonly string[] | undefined> = [];

describe("connection actions by agent mode (ADR 0176)", () => {
  const providers = new ConnectionProviderRegistry([
    declared,
    annotated,
    forge,
  ]);
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
      repo: {
        provider: "forge",
        principal: "service",
        service: "repo",
        capabilities: ["git:read", "git:write", "issues.list"],
      },
    }),
  });
  const allocations = new ExecutionAllocationsService(db);
  let mode: AgentMode | undefined = "read-only";
  const broker = new ConnectionBroker(
    connections,
    providers,
    allocations,
    undefined,
    {
      guards: [],
      sessionMode: async () => mode,
      // The project's linked remote scopes the forge binding (ADR 0175).
      projectRemote: async () => "https://forge.test/org/repo.git",
    },
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
      ["repo", "forge"],
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
      aliases: ["directory", "chat", "repo"],
      principalsByAlias: {
        directory: "service",
        chat: "service",
        repo: "service",
      },
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

  const git = (access: "read" | "write") =>
    broker.gitAccess({
      identity: admin,
      allocationId,
      alias: "repo",
      access,
      remoteUrl: "https://forge.test/org/repo",
      agentSessionId: "session-1",
    });

  it("lets a read-only agent fetch but never push through the Git gateway", async () => {
    mode = "read-only";
    await expect(git("read")).resolves.toMatchObject({
      credentials: { password: "token-read" },
    });
    await expect(git("write")).rejects.toThrow("read-only mode");
    for (const next of ["edit", "full-access", undefined] as const) {
      mode = next;
      await expect(git("write")).resolves.toMatchObject({
        credentials: { password: "token-write" },
      });
    }
  });

  it("scopes a Git provider's API actions to the binding's repositories", async () => {
    mode = "full-access";
    forgeRepositories.length = 0;
    await expect(call("repo", "issues.list")).resolves.toEqual({ ok: true });
    expect(forgeRepositories).toEqual([["org/repo"]]);
  });
});
