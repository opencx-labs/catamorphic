import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import {
  ConnectionActionDeniedError,
  ConnectionBroker,
} from "../services/connection-broker.js";
import type { ConnectionActionContext } from "../services/connection-guards.js";
import {
  type ConnectionCallContext,
  type ConnectionProvider,
  ConnectionProviderRegistry,
} from "../services/connection-providers.js";
import type { EnvironmentConnectionBinding } from "../services/connection-types.js";
import {
  AuthenticationRequiredError,
  ConnectionsService,
  ConnectionTemporarilyUnavailableError,
} from "../services/connections-service.js";
import {
  type CredentialPlacement,
  type CredentialVault,
  MemoryCredentialVault,
  routeCredentialVaults,
} from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const admin: Identity = { tenantId, externalUserId: "admin" };

function memberOf(externalUserId: string, aliases: string[]): Identity {
  return {
    tenantId,
    externalUserId,
    scope: [{ kind: "agent", projectId, name: "brain" }],
    executionScope: [{ projectId, name: "company" }],
    connectionScope: aliases.map((alias) => ({
      projectId,
      environment: "company",
      alias,
      capabilities: ["read", "write"],
    })),
  };
}

/** A vault that records the trusted placement of every write. */
class RecordingVault implements CredentialVault {
  readonly inner = new MemoryCredentialVault();
  readonly placements: CredentialPlacement[] = [];
  put(args: Parameters<CredentialVault["put"]>[0]) {
    this.placements.push(args.placement);
    return this.inner.put(args);
  }
  withMaterial<T>(args: {
    tenantId: string;
    ref: { id: string };
    use: (material: Uint8Array) => Promise<T> | T;
  }) {
    return this.inner.withMaterial(args);
  }
  delete(args: Parameters<CredentialVault["delete"]>[0]) {
    return this.inner.delete(args);
  }
}

const calls: Array<{ material: string; context: ConnectionCallContext }> = [];
let refreshes = 0;
let refreshRefused = false;
/** The token endpoint is down: nothing is known about the grant. */
let refreshUnreachable = false;
/** An ordinary provider that wrongly answers with nothing to keep. */
const careless: ConnectionProvider = {
  kind: "careless",
  displayName: "Careless",
  beginAuthorization: async () => ({ challenge: { kind: "form", fields: [] } }),
  completeAuthorization: async () => ({ material: new Uint8Array(0) }),
  invoke: async () => ({}),
};

/** Refresh tokens already exchanged: each is single-use upstream. */
const spent = new Set<string>();
let refreshDelayMs = 0;

const oauth: ConnectionProvider = {
  kind: "oauth",
  displayName: "Member OAuth",
  invoke: async ({ material, context, action }) => {
    calls.push({ material: new TextDecoder().decode(material), context });
    return { action };
  },
  refresh: async ({ material }) => {
    const token = new TextDecoder().decode(material);
    await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
    if (refreshUnreachable) {
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    }
    if (refreshRefused || spent.has(token)) {
      throw Object.assign(new Error("invalid_grant"), { status: 400 });
    }
    spent.add(token);
    refreshes += 1;
    return {
      material: new TextEncoder().encode(`${token}+${refreshes}`),
      capabilities: ["read", "write"],
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  },
};

/** Obtains its credential itself from the call's context: Work keeps none. */
const hostIssued: ConnectionProvider = {
  kind: "host-issued",
  displayName: "Host issued",
  keepsNoCredential: true,
  beginAuthorization: async () => ({
    challenge: { kind: "form", fields: [] },
  }),
  completeAuthorization: async () => ({
    material: new Uint8Array(0),
    capabilities: ["read", "write"],
  }),
  invoke: async ({ material, context, action }) => {
    calls.push({ material: new TextDecoder().decode(material), context });
    return { action, issuedFor: context.externalUserId };
  },
};

const committed: Record<string, EnvironmentConnectionBinding> = {
  mine: { provider: "oauth", principal: "member" },
  shared: { provider: "host-issued", principal: "service", service: "issuer" },
  sloppy: { provider: "careless", principal: "service", service: "sloppy" },
};

describe("host-owned connections (ADR 0316)", () => {
  const vault = new RecordingVault();
  const providers = new ConnectionProviderRegistry([
    oauth,
    hostIssued,
    careless,
  ]);
  const service = (target: CredentialVault = vault) =>
    new ConnectionsService({
      db,
      vault: target,
      providers,
      bindings: async ({ environment }) =>
        environment === "company" ? committed : {},
    });
  const connections = service();
  const reviewed: ConnectionActionContext[] = [];
  let verdict: "allow" | "escalate" = "allow";
  const broker = new ConnectionBroker(
    connections,
    providers,
    new ExecutionAllocationsService(db),
    undefined,
    {
      guards: [
        {
          name: "record",
          review: async (context) => {
            reviewed.push(context);
            return verdict === "allow"
              ? { verdict: "allow" }
              : { verdict: "escalate", reason: "needs a person" };
          },
        },
      ],
    },
  );

  async function memberConnection(args: {
    owner: Identity;
    token: string;
    expiresAt?: Date;
  }) {
    const created = await connections.create({
      identity: args.owner,
      projectId,
      providerKind: "oauth",
      label: "Mine",
      material: new TextEncoder().encode(args.token),
      capabilities: ["read", "write"],
      ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
    });
    await connections.attachMember({
      identity: args.owner,
      projectId,
      environment: "company",
      alias: "mine",
      connectionId: created.id,
    });
    return created;
  }

  beforeAll(async () => {
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
    await db
      .insertInto("tenants")
      .values({ id: tenantId, name: "T" })
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "Brain" })
      .execute();
  }, 120_000);

  beforeEach(() => {
    calls.length = 0;
    reviewed.length = 0;
    refreshRefused = false;
    refreshUnreachable = false;
    refreshDelayMs = 0;
    verdict = "allow";
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("gives the vault trusted placement for every write", async () => {
    const owner = memberOf("placement", ["mine"]);
    await memberConnection({ owner, token: "placement-token" });
    expect(vault.placements.at(-1)).toEqual({
      purpose: "connection",
      projectId,
      owner: { kind: "member", externalUserId: "placement" },
    });
  });

  it("refreshes expired member access before admission", async () => {
    const owner = memberOf("expired", ["mine"]);
    const created = await memberConnection({
      owner,
      token: "expired-token",
      expiresAt: new Date(Date.now() - 1_000),
    });
    const before = refreshes;
    const [resolved] = await connections.resolve({
      identity: owner,
      projectId,
      environment: "company",
      aliases: ["mine"],
    });
    expect(resolved?.connectionId).toBe(created.id);
    expect(refreshes).toBe(before + 1);
  });

  it("asks for authorization when admission's refresh is refused", async () => {
    const owner = memberOf("refused", ["mine"]);
    await memberConnection({
      owner,
      token: "refused-token",
      expiresAt: new Date(Date.now() - 1_000),
    });
    refreshRefused = true;
    await expect(
      connections.resolve({
        identity: owner,
        projectId,
        environment: "company",
        aliases: ["mine"],
      }),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("reads an unreachable token endpoint as temporary, never as a reason to reconnect", async () => {
    const owner = memberOf("unreachable", ["mine"]);
    const created = await memberConnection({
      owner,
      token: "unreachable-token",
      expiresAt: new Date(Date.now() - 1_000),
    });
    refreshUnreachable = true;
    await expect(
      connections.resolve({
        identity: owner,
        projectId,
        environment: "company",
        aliases: ["mine"],
      }),
    ).rejects.toBeInstanceOf(ConnectionTemporarilyUnavailableError);
    expect(
      (await connections.list({ identity: owner })).find(
        (record) => record.id === created.id,
      )?.status,
    ).toBe("ready");
    // Still valid for a while: a call goes ahead despite the failed refresh.
    await db
      .updateTable("connections")
      .set({ expires_at: new Date(Date.now() + 30_000) })
      .where("id", "=", created.id)
      .execute();
    await expect(
      connections.resolve({
        identity: owner,
        projectId,
        environment: "company",
        aliases: ["mine"],
      }),
    ).resolves.toHaveLength(1);
  });

  it("never refreshes a revoked connection", async () => {
    const owner = memberOf("revoked", ["mine"]);
    const created = await memberConnection({
      owner,
      token: "revoked-token",
      expiresAt: new Date(Date.now() - 1_000),
    });
    await connections.revoke({ identity: owner, connectionId: created.id });
    const before = refreshes;
    await connections.refreshIfNeeded({
      identity: owner,
      connectionId: created.id,
    });
    expect(refreshes).toBe(before);
  });

  it("serializes refresh across instances so a single-use token is spent once", async () => {
    const owner = memberOf("concurrent", ["mine"]);
    const created = await memberConnection({
      owner,
      token: "single-use",
      expiresAt: new Date(Date.now() - 1_000),
    });
    refreshDelayMs = 300;
    const before = refreshes;
    // Two replicas sharing one database and one vault.
    await Promise.all([
      connections.refreshIfNeeded({
        identity: owner,
        connectionId: created.id,
      }),
      service().refreshIfNeeded({ identity: owner, connectionId: created.id }),
    ]);
    expect(refreshes).toBe(before + 1);
    expect(
      (await connections.list({ identity: owner })).find(
        (record) => record.id === created.id,
      ),
    ).toMatchObject({ status: "ready", revision: created.revision + 1 });
  });

  it("calls a member's own account directly, with trusted context, and stops at once when detached", async () => {
    const owner = memberOf("direct", ["mine"]);
    await memberConnection({ owner, token: "direct-token" });
    await expect(
      broker.invoke({
        identity: owner,
        projectId,
        environment: "company",
        alias: "mine",
        action: "read",
        input: {},
        caller: "member",
      }),
    ).resolves.toEqual({ action: "read" });
    expect(calls.at(-1)).toEqual({
      material: "direct-token",
      context: {
        tenantId,
        connectionId: expect.any(String),
        principal: { kind: "member", externalUserId: "direct" },
        projectId,
        environment: "company",
        alias: "mine",
        externalUserId: "direct",
      },
    });
    expect(reviewed.at(-1)).toMatchObject({
      caller: "member",
      actor: "direct",
    });
    expect(reviewed.at(-1)?.allocationId).toBeUndefined();

    await connections.detachMember({
      identity: owner,
      projectId,
      environment: "company",
      alias: "mine",
    });
    await expect(
      broker.invoke({
        identity: owner,
        projectId,
        environment: "company",
        alias: "mine",
        action: "read",
        input: {},
        caller: "member",
      }),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("refuses a member's call outside their role, and an escalation", async () => {
    const outsider = memberOf("outsider", []);
    await expect(
      broker.invoke({
        identity: outsider,
        projectId,
        environment: "company",
        alias: "mine",
        action: "read",
        input: {},
        caller: "member",
      }),
    ).rejects.toBeInstanceOf(ConnectionActionDeniedError);

    const owner = memberOf("escalated", ["mine"]);
    await memberConnection({ owner, token: "escalated-token" });
    verdict = "escalate";
    await expect(
      broker.invoke({
        identity: owner,
        projectId,
        environment: "company",
        alias: "mine",
        action: "write",
        input: {},
        caller: "member",
      }),
    ).rejects.toThrow("requires human approval");
    expect(calls).toEqual([]);
  });

  it("keeps nothing for a connection whose provider obtains its own credential", async () => {
    const issuer = await connections.createService({
      identity: admin,
      name: "issuer",
      providerKind: "host-issued",
      principalKind: "project_service",
      projectId,
    });
    const writes = vault.placements.length;
    const started = await connections.beginServiceAuthorization({
      identity: admin,
      connectionId: issuer.id,
      redirectUri: "https://work.test/api/connection-authorizations/callback",
    });
    const ready = await connections.completeAuthorization({
      identity: admin,
      state: started.authorizationId,
      callback: {},
    });
    expect(ready.status).toBe("ready");
    expect(vault.placements.length).toBe(writes);
    const row = await db
      .selectFrom("connections")
      .select("credential_ref")
      .where("id", "=", issuer.id)
      .executeTakeFirstOrThrow();
    expect(row.credential_ref).toBeNull();

    const caller = memberOf("caller", ["shared"]);
    await expect(
      broker.invoke({
        identity: caller,
        projectId,
        environment: "company",
        alias: "shared",
        action: "read",
        input: {},
        caller: "member",
      }),
    ).resolves.toEqual({ action: "read", issuedFor: "caller" });
    expect(calls.at(-1)).toMatchObject({
      material: "",
      context: {
        principal: { kind: "service", name: "issuer" },
        alias: "shared",
        externalUserId: "caller",
      },
    });
  });

  it("refuses empty material from a provider that does not declare it keeps none", async () => {
    const sloppy = await connections.createService({
      identity: admin,
      name: "sloppy",
      providerKind: "careless",
      principalKind: "project_service",
      projectId,
    });
    const started = await connections.beginServiceAuthorization({
      identity: admin,
      connectionId: sloppy.id,
      redirectUri: "https://work.test/api/connection-authorizations/callback",
    });
    await expect(
      connections.completeAuthorization({
        identity: admin,
        state: started.authorizationId,
        callback: {},
      }),
    ).rejects.toThrow("returned no credential");
    expect(
      () =>
        new ConnectionProviderRegistry([
          {
            ...hostIssued,
            kind: "forwarding",
            http: {
              baseUrl: "https://api.test",
              headers: () => ({}),
            },
          },
        ]),
    ).toThrow("keeps no credential");
  });

  it("takes over a refresh another replica abandoned", async () => {
    const owner = memberOf("abandoned", ["mine"]);
    const created = await memberConnection({
      owner,
      token: "abandoned-token",
      expiresAt: new Date(Date.now() - 1_000),
    });
    // Another replica took the lease and then crashed: it lapses.
    await db
      .updateTable("connections")
      .set({
        refresh_lease_until: new Date(Date.now() + 300),
        refresh_lease_holder: "crashed-replica",
      })
      .where("id", "=", created.id)
      .execute();
    const before = refreshes;
    await connections.refreshIfNeeded({
      identity: owner,
      connectionId: created.id,
    });
    expect(refreshes).toBe(before + 1);
    const row = await db
      .selectFrom("connections")
      .select(["status", "refresh_lease_holder"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "ready", refresh_lease_holder: null });
  });

  it("revokes the credential stored when it locks the row", async () => {
    const owner = memberOf("revoker", ["mine"]);
    const created = await memberConnection({ owner, token: "revoke-me" });
    await connections.revoke({ identity: owner, connectionId: created.id });
    const row = await db
      .selectFrom("connections")
      .select(["status", "credential_ref", "revision"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "revoked",
      credential_ref: null,
      revision: created.revision + 1,
    });
  });
});

describe("routeCredentialVaults", () => {
  const placement = (purpose: CredentialPlacement["purpose"]) => ({
    purpose,
    owner: { kind: "project" as const },
  });

  it("routes writes by host logic and reads each ref from its own vault", async () => {
    const personal = new MemoryCredentialVault();
    const shared = new MemoryCredentialVault();
    let route = (purpose: string) =>
      purpose === "connection" ? "personal" : "shared";
    const vault = routeCredentialVaults({
      vaults: { personal, shared },
      select: ({ placement }) => route(placement.purpose),
    });
    const token = await vault.put({
      tenantId,
      material: new TextEncoder().encode("token"),
      placement: placement("connection"),
    });
    const secret = await vault.put({
      tenantId,
      material: new TextEncoder().encode("secret"),
      placement: placement("project-secret"),
    });
    expect(token.id.startsWith("personal:")).toBe(true);
    expect(secret.id.startsWith("shared:")).toBe(true);

    // Changing the routing moves new writes only.
    route = () => "shared";
    const read = (ref: { id: string }) =>
      vault.withMaterial({
        tenantId,
        ref,
        use: (material) => new TextDecoder().decode(material),
      });
    expect(await read(token)).toBe("token");
    expect(await read(secret)).toBe("secret");

    await vault.delete({ tenantId, ref: token });
    await expect(read(token)).rejects.toThrow("Credential not found");
    await expect(
      personal.withMaterial({
        tenantId,
        ref: { id: token.id.slice("personal:".length) },
        use: () => "present",
      }),
    ).rejects.toThrow("Credential not found");
  });

  it("keeps reading records written before routing through the fallback", async () => {
    const existing: CredentialVault = new MemoryCredentialVault();
    const old = await existing.put({
      tenantId,
      material: new TextEncoder().encode("before routing"),
      placement: placement("connection"),
    });
    const vault = routeCredentialVaults({
      vaults: { existing, secrets: new MemoryCredentialVault() },
      fallback: "existing",
      select: () => "secrets",
    });
    expect(
      await vault.withMaterial({
        tenantId,
        ref: old,
        use: (material) => new TextDecoder().decode(material),
      }),
    ).toBe("before routing");
    await vault.delete({ tenantId, ref: old });
    await expect(
      existing.withMaterial({ tenantId, ref: old, use: () => 1 }),
    ).rejects.toThrow("Credential not found");
  });

  it("refuses unknown and malformed vault keys", async () => {
    expect(() =>
      routeCredentialVaults({
        vaults: { "Not:Valid": new MemoryCredentialVault() },
        select: () => "Not:Valid",
      }),
    ).toThrow("Invalid credential vault key");
    const vault = routeCredentialVaults({
      vaults: { only: new MemoryCredentialVault() },
      select: () => "missing",
    });
    await expect(
      vault.put({
        tenantId,
        material: new Uint8Array([1]),
        placement: placement("connection"),
      }),
    ).rejects.toThrow("No credential vault 'missing'");
    await expect(
      vault.withMaterial({ tenantId, ref: { id: "plain" }, use: () => 1 }),
    ).rejects.toThrow("Credential not found");
  });
});
