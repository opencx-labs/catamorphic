import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Identity } from "../identity.js";
import { ConnectionBroker } from "../services/connection-broker.js";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import {
  type ConnectionProvider,
  ConnectionProviderRegistry,
} from "../services/connection-providers.js";
import {
  AuthenticationRequiredError,
  ConnectionsService,
} from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";

const pglite = new PGlite({ extensions: { pgcrypto } });
const db = new Kysely<DB>({
  dialect: new PGliteDialect({ pglite }),
  plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
});
const tenantId = crypto.randomUUID();
// Deliberately contains the sensitive fixture value so assertions cannot scan
// unrelated identifiers for that substring.
const projectId = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const otherTenantId = crypto.randomUUID();

const admin: Identity = { tenantId, externalUserId: "admin" };
const member: Identity = {
  tenantId,
  externalUserId: "member",
  scope: [{ kind: "agent", projectId, name: "brain" }],
  executionScope: [{ projectId, name: "company" }],
  connectionScope: [
    {
      projectId,
      environment: "company",
      alias: "directory",
      capabilities: ["users.list"],
    },
  ],
};

const decodedMaterials: string[] = [];
let refreshes = 0;
let providerRevokeFails = false;
const provider: ConnectionProvider = {
  kind: "fake",
  displayName: "Fake Directory",
  beginAuthorization: async ({ state }) => ({
    challenge: { kind: "url", url: `https://auth.test/?state=${state}` },
    privateState: new TextEncoder().encode("pkce-verifier"),
  }),
  completeAuthorization: async ({ callback, privateState }) => {
    expect(callback).toEqual({ code: "approved" });
    expect(new TextDecoder().decode(privateState)).toBe("pkce-verifier");
    return {
      material: new TextEncoder().encode("member-token"),
      account: { email: "member@example.test" },
      scopes: ["directory.read"],
      capabilities: ["users.list", "users.disable"],
      expiresAt: new Date(Date.now() + 60_000),
    };
  },
  invoke: async ({ material, action }) => {
    decodedMaterials.push(new TextDecoder().decode(material));
    return { action, ok: true };
  },
  refresh: async () => {
    refreshes += 1;
    return {
      material: new TextEncoder().encode(`refreshed-${refreshes}`),
      capabilities: ["users.list", "users.disable"],
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  },
  revoke: async () => {
    if (providerRevokeFails) throw new Error("upstream unavailable");
  },
};

describe("credential connections", () => {
  const vault = new MemoryCredentialVault();
  const providers = new ConnectionProviderRegistry([provider]);
  const connections = new ConnectionsService(db, vault, providers);
  const allocations = new ExecutionAllocationsService(db);
  const broker = new ConnectionBroker(connections, providers, allocations);
  const grants = new ConnectionCapabilityGrantsService(db, allocations);

  beforeAll(async () => {
    await migrateToLatest({ db, schema: DEFAULT_SCHEMA });
    await db
      .insertInto("tenants")
      .values([
        { id: tenantId, name: "Tenant" },
        { id: otherTenantId, name: "Other" },
      ])
      .execute();
    await db
      .insertInto("projects")
      .values({ id: projectId, tenant_id: tenantId, name: "Brain" })
      .execute();
    await connections.bind({
      identity: admin,
      projectId,
      environment: "company",
      alias: "directory",
      providerKind: "fake",
      principalKinds: ["member", "project_service"],
      capabilities: ["users.list", "users.disable"],
    });
    await connections.bind({
      identity: admin,
      projectId,
      environment: "company",
      alias: "service-only",
      providerKind: "fake",
      principalKinds: ["project_service"],
      capabilities: ["users.list"],
    });
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
  });

  it("stores OAuth state by hash and exposes only sanitized records", async () => {
    const started = await connections.beginAuthorization({
      identity: member,
      projectId,
      environment: "company",
      alias: "directory",
      redirectUri: "https://app.test/callback",
    });
    const attempt = await db
      .selectFrom("connection_authorization_attempts")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(attempt.state_hash).not.toBe(started.authorizationId);
    expect(attempt.private_state_ref).toBeTruthy();

    const record = await connections.completeAuthorization({
      identity: member,
      state: started.authorizationId,
      callback: { code: "approved" },
    });
    expect(record).toMatchObject({
      providerKind: "fake",
      principalKind: "member",
      ownerExternalUserId: "member",
      account: { email: "member@example.test" },
      scopes: ["directory.read"],
    });
    expect(record).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(record)).not.toContain("member-token");
    await expect(
      vault.withMaterial({
        tenantId,
        ref: { id: attempt.private_state_ref! },
        use: () => undefined,
      }),
    ).rejects.toThrow("not found");

    const [resolved] = await connections.resolve({
      identity: member,
      projectId,
      environment: "company",
      aliases: ["directory"],
    });
    expect(resolved?.capabilities).toEqual(["users.list"]);
    await expect(
      connections.resolve({
        identity: member,
        projectId,
        environment: "company",
        aliases: ["directory"],
        unattended: true,
      }),
    ).rejects.toMatchObject({
      requirements: [
        {
          alias: "directory",
          principalKinds: ["project_service"],
        },
      ],
    });
  });

  it("does not fall back from a required service principal to member auth", async () => {
    const memberConnection = (await connections.list({ identity: member }))[0]!;
    await expect(
      connections.resolve({
        identity: member,
        projectId,
        environment: "company",
        aliases: ["directory"],
        principalsByAlias: { directory: "service" },
      }),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);

    const service = await connections.create({
      identity: admin,
      projectId,
      providerKind: "fake",
      principalKind: "project_service",
      label: "Directory bot",
      material: new TextEncoder().encode("service-token"),
      capabilities: ["users.list", "users.disable"],
    });
    await connections.bind({
      identity: admin,
      projectId,
      environment: "company",
      alias: "directory",
      providerKind: "fake",
      principalKinds: ["member", "project_service"],
      serviceConnectionId: service.id,
      capabilities: ["users.list", "users.disable"],
    });
    const [resolved] = await connections.resolve({
      identity: member,
      projectId,
      environment: "company",
      aliases: ["directory"],
      principalsByAlias: { directory: "service" },
    });
    expect(resolved).toMatchObject({
      connectionId: service.id,
      principalKind: "project_service",
    });
    expect(memberConnection.principalKind).toBe("member");
  });

  it("does not offer member authorization for a service-only binding", async () => {
    await expect(
      connections.beginAuthorization({
        identity: admin,
        projectId,
        environment: "company",
        alias: "service-only",
        redirectUri: "https://app.test/callback",
      }),
    ).rejects.toThrow("does not accept member authorization");
  });

  it("brokers by immutable allocation and stores only grant hashes", async () => {
    const deniedInput = { userId: "123" };
    const allowedInput = { page: 1 };
    const [resolved] = await connections.resolve({
      identity: member,
      projectId,
      environment: "company",
      aliases: ["directory"],
      principalsByAlias: { directory: "service" },
    });
    expect(resolved).toBeDefined();
    const allocation = await allocations.create({
      identity: member,
      projectId,
      environmentName: "company",
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
          capabilities: ["network.egress"],
          resources: {},
        },
        requirements: { workload: "agent", topology: "controller" },
        connections: [resolved!],
      },
    });
    await expect(
      broker.invoke({
        identity: member,
        allocationId: allocation.id,
        alias: "directory",
        action: "users.disable",
        input: deniedInput,
      }),
    ).rejects.toThrow("not permitted");
    await expect(
      broker.invoke({
        identity: member,
        allocationId: allocation.id,
        alias: "directory",
        action: "users.list",
        input: allowedInput,
      }),
    ).resolves.toEqual({ action: "users.list", ok: true });
    expect(decodedMaterials.at(-1)).toBe("service-token");

    const grant = await grants.issue({
      identity: member,
      allocationId: allocation.id,
      alias: "directory",
    });
    const stored = await db
      .selectFrom("connection_capability_grants")
      .select(["token_hash"])
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(grant.token);
    await expect(
      grants.validate({ token: grant.token }),
    ).resolves.toMatchObject({
      allocationId: allocation.id,
    });
    await grants.revokeAllocation({ allocationId: allocation.id });
    await expect(grants.validate({ token: grant.token })).resolves.toBeNull();

    const audit = await connections.listAudit({
      identity: admin,
      projectId,
    });
    const allowedInvocation = audit.find(
      (event) =>
        event.eventType === "connection.invoked" &&
        event.action === "users.list",
    );
    const deniedInvocation = audit.find(
      (event) =>
        event.eventType === "connection.invoked" &&
        event.action === "users.disable",
    );
    expect(allowedInvocation).toMatchObject({
      outcome: "allowed",
      argumentsDigest: crypto
        .createHash("sha256")
        .update(JSON.stringify(allowedInput))
        .digest("hex"),
    });
    expect(deniedInvocation).toMatchObject({
      outcome: "denied",
      argumentsDigest: crypto
        .createHash("sha256")
        .update(JSON.stringify(deniedInput))
        .digest("hex"),
    });
    expect(allowedInvocation?.metadata).toEqual({});
    expect(deniedInvocation?.metadata).toEqual({});
    expect(deniedInvocation?.argumentsDigest).not.toBe(deniedInput.userId);
    expect(allowedInvocation).not.toHaveProperty("input");
    expect(deniedInvocation).not.toHaveProperty("input");
    expect(allowedInvocation).not.toHaveProperty("arguments");
    expect(deniedInvocation).not.toHaveProperty("arguments");
  });

  it("refreshes with compare-and-swap and revokes locally when upstream fails", async () => {
    const expiring = await connections.create({
      identity: member,
      projectId,
      providerKind: "fake",
      principalKind: "member",
      label: "Expiring",
      material: new TextEncoder().encode("old-token"),
      capabilities: ["users.list"],
      expiresAt: new Date(Date.now() + 5),
    });
    await Promise.all([
      connections.refreshIfNeeded({
        identity: member,
        connectionId: expiring.id,
      }),
      connections.refreshIfNeeded({
        identity: member,
        connectionId: expiring.id,
      }),
    ]);
    const refreshed = (await connections.list({ identity: member })).find(
      (candidate) => candidate.id === expiring.id,
    );
    expect(refreshed?.revision).toBe(2);
    expect(refreshed?.status).toBe("ready");

    providerRevokeFails = true;
    await connections.revoke({ identity: member, connectionId: expiring.id });
    const revoked = (await connections.list({ identity: member })).find(
      (candidate) => candidate.id === expiring.id,
    );
    expect(revoked?.status).toBe("revoked");
    const audit = await connections.listAudit({ identity: admin, projectId });
    expect(audit).toContainEqual(
      expect.objectContaining({
        connectionId: expiring.id,
        eventType: "connection.revoked",
        outcome: "error",
        metadata: { providerRevocation: "failed_closed" },
      }),
    );
  });
});
