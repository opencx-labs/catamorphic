import crypto from "node:crypto";
import { type DB, DEFAULT_SCHEMA, migrateToLatest } from "@catamorphic/db";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Kysely, PGliteDialect, WithSchemaPlugin } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Identity } from "../identity.js";
import {
  ConnectionActionDeniedError,
  ConnectionBroker,
} from "../services/connection-broker.js";
import { ConnectionCapabilityGrantsService } from "../services/connection-capability-grants.js";
import {
  type ConnectionProvider,
  ConnectionProviderRegistry,
} from "../services/connection-providers.js";
import type { EnvironmentConnectionBinding } from "../services/connection-types.js";
import {
  AuthenticationRequiredError,
  ConnectionNameTakenError,
  ConnectionPermissionDeniedError,
  ConnectionsService,
} from "../services/connections-service.js";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import { ExecutionAllocationsService } from "../services/execution-allocations-service.js";
import type { WorkflowEnablementsService } from "../services/workflow-enablements-service.js";

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
const invokedRevisions: string[] = [];
const released: string[] = [];
let refreshes = 0;
let providerRevokeFails = false;
/** A `slow` authorization waits here, as a device code being polled does. */
let slowAuthorization: { started: boolean; finish: Promise<void> } = {
  started: false,
  finish: Promise.resolve(),
};
const provider: ConnectionProvider = {
  kind: "fake",
  displayName: "Fake Directory",
  beginAuthorization: async ({ state }) => ({
    challenge: { kind: "url", url: `https://auth.test/?state=${state}` },
    privateState: new TextEncoder().encode("pkce-verifier"),
  }),
  completeAuthorization: async ({ callback, privateState }) => {
    expect(new TextDecoder().decode(privateState)).toBe("pkce-verifier");
    if (callback.code === "refused") throw new Error("upstream refused");
    if (callback.code === "slow") {
      slowAuthorization.started = true;
      await slowAuthorization.finish;
    }
    return {
      material: new TextEncoder().encode(
        callback.code === "approved" ? "member-token" : `${callback.code}`,
      ),
      account: { email: "member@example.test" },
      scopes: ["directory.read"],
      capabilities: ["users.list", "users.disable"],
      ...(callback.code === "approved"
        ? { expiresAt: new Date(Date.now() + 60_000) }
        : {}),
    };
  },
  invoke: async ({ material, action, connection }) => {
    decodedMaterials.push(new TextDecoder().decode(material));
    invokedRevisions.push(`${connection.id}@${connection.revision}`);
    return { action, ok: true };
  },
  release: async ({ connectionId }) => {
    released.push(connectionId);
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

/** What `.work/project.json` commits for the `company` Environment. */
const committed: Record<string, EnvironmentConnectionBinding> = {
  directory: {
    provider: "fake",
    principal: "either",
    capabilities: ["users.list", "users.disable"],
  },
  "service-only": {
    provider: "fake",
    principal: "service",
    service: "directory-bot",
    capabilities: ["users.list"],
  },
};

/** Authorize a named service connection the way an administrator does. */
async function authorizeService(
  connections: ConnectionsService,
  connectionId: string,
  token: string,
) {
  const started = await connections.beginServiceAuthorization({
    identity: admin,
    connectionId,
    redirectUri: "https://work.test/api/connection-authorizations/callback",
  });
  return connections.completeAuthorization({
    identity: admin,
    state: started.authorizationId,
    callback: { code: token },
  });
}

describe("credential connections", () => {
  const vault = new MemoryCredentialVault();
  const providers = new ConnectionProviderRegistry([provider]);
  const connections = new ConnectionsService({
    db,
    vault,
    providers,
    bindings: async ({ environment }) =>
      environment === "company" ? committed : {},
  });
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
          principalKinds: ["project_service", "tenant_service"],
        },
      ],
    });
  });

  it("administers named service connections only with connections:write", async () => {
    await expect(
      connections.createService({
        identity: member,
        name: "directory-bot",
        providerKind: "fake",
        principalKind: "tenant_service",
      }),
    ).rejects.toBeInstanceOf(ConnectionPermissionDeniedError);
    await expect(
      connections.createService({
        identity: admin,
        name: "Not A Name",
        providerKind: "fake",
        principalKind: "tenant_service",
      }),
    ).rejects.toThrow("Invalid service connection name");
    const created = await connections.createService({
      identity: admin,
      name: "tenant-directory",
      providerKind: "fake",
      principalKind: "tenant_service",
    });
    expect(created).toMatchObject({
      name: "tenant-directory",
      principalKind: "tenant_service",
      projectId: null,
      status: "pending",
    });
    await expect(
      connections.createService({
        identity: admin,
        name: "tenant-directory",
        providerKind: "fake",
        principalKind: "tenant_service",
      }),
    ).rejects.toBeInstanceOf(ConnectionNameTakenError);
    await expect(
      connections.beginServiceAuthorization({
        identity: member,
        connectionId: created.id,
        redirectUri: "https://work.test/callback",
      }),
    ).rejects.toBeInstanceOf(ConnectionPermissionDeniedError);
    // An administrator who starts the challenge and loses the permission
    // before finishing cannot complete it.
    const started = await connections.beginServiceAuthorization({
      identity: { ...admin, externalUserId: "demoted" },
      connectionId: created.id,
      redirectUri: "https://work.test/callback",
    });
    await expect(
      connections.completeAuthorization({
        identity: {
          tenantId,
          externalUserId: "demoted",
          scope: [],
          controlPlanePermissions: [],
        },
        state: started.authorizationId,
        callback: { code: "tenant-token" },
      }),
    ).rejects.toBeInstanceOf(ConnectionPermissionDeniedError);
    const listed = await connections.listServices({ identity: admin });
    expect(listed.map((connection) => connection.name)).toContain(
      "tenant-directory",
    );
    await expect(
      connections.listServices({ identity: member }),
    ).rejects.toBeInstanceOf(ConnectionPermissionDeniedError);
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

    const service = await connections.createService({
      identity: admin,
      name: "directory-bot",
      providerKind: "fake",
      principalKind: "project_service",
      projectId,
      label: "Directory bot",
    });
    await authorizeService(connections, service.id, "service-token");
    committed.directory = {
      provider: "fake",
      principal: "either",
      service: "directory-bot",
      capabilities: ["users.list", "users.disable"],
    };
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

  it("resolves a binding's service by name, the project's before the tenant's", async () => {
    const tenantBot = await connections.createService({
      identity: admin,
      name: "shared-bot",
      providerKind: "fake",
      principalKind: "tenant_service",
    });
    await authorizeService(connections, tenantBot.id, "tenant-token");
    committed.shared = {
      provider: "fake",
      principal: "service",
      service: "shared-bot",
    };
    const unattended = {
      identity: admin,
      projectId,
      environment: "company",
      aliases: ["shared"],
      unattended: true,
    };
    const [fromTenant] = await connections.resolve(unattended);
    expect(fromTenant).toMatchObject({
      connectionId: tenantBot.id,
      principalKind: "tenant_service",
      // No narrowing in the binding keeps the connection's own capabilities.
      capabilities: ["users.list", "users.disable"],
    });
    const projectBot = await connections.createService({
      identity: admin,
      name: "shared-bot",
      providerKind: "fake",
      principalKind: "project_service",
      projectId,
    });
    // The project's own connection of that name wins, even while it waits
    // for authorization: a name never silently falls back to another.
    await expect(connections.resolve(unattended)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
    await authorizeService(connections, projectBot.id, "project-token");
    const [fromProject] = await connections.resolve(unattended);
    expect(fromProject?.connectionId).toBe(projectBot.id);
    // A trigger's frozen choice fails closed once the name resolves elsewhere.
    await expect(
      connections.resolveSnapshot({
        identity: admin,
        projectId,
        environment: "company",
        snapshot: [fromTenant!],
      }),
    ).rejects.toThrow("Assigned service connection changed");
    await connections.revoke({ identity: admin, connectionId: projectBot.id });
    expect(released).toContain(projectBot.id);
    const [again] = await connections.resolveSnapshot({
      identity: admin,
      projectId,
      environment: "company",
      snapshot: [fromTenant!],
    });
    expect(again?.connectionId).toBe(tenantBot.id);
    // Revoking frees the name for a new connection.
    const replacement = await connections.createService({
      identity: admin,
      name: "shared-bot",
      providerKind: "fake",
      principalKind: "project_service",
      projectId,
    });
    await connections.revoke({
      identity: admin,
      connectionId: replacement.id,
    });
    delete committed.shared;
  });

  it("rotates a service credential by authorizing again and drops old sessions", async () => {
    const service = (await connections.listServices({ identity: admin })).find(
      (connection) => connection.name === "directory-bot",
    )!;
    released.length = 0;
    const rotated = await authorizeService(
      connections,
      service.id,
      "service-token",
    );
    expect(rotated.revision).toBe(service.revision + 1);
    expect(released).toEqual([service.id]);
    const audit = await connections.listAudit({ identity: admin });
    expect(audit).toContainEqual(
      expect.objectContaining({
        connectionId: service.id,
        eventType: "connection.rotated",
      }),
    );
  });

  it("lists an Environment's committed aliases with their authority", async () => {
    const forMember = await connections.listBindings({
      identity: member,
      projectId,
      environment: "company",
    });
    expect(forMember.map((binding) => binding.alias)).toEqual(["directory"]);
    expect(forMember[0]).toMatchObject({
      provider: "fake",
      principal: "either",
      service: null,
      memberConnection: { principalKind: "member" },
      serviceConnection: { connectionId: null, label: "Directory bot" },
    });
    const forAdmin = await connections.listBindings({
      identity: admin,
      projectId,
      environment: "company",
    });
    expect(forAdmin.map((binding) => binding.alias)).toEqual([
      "directory",
      "service-only",
    ]);
    expect(forAdmin[0]?.service).toBe("directory-bot");
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

    // A session holds one grant per alias and channel (ADR 0175): renewing
    // its sandbox grant revokes the previous sandbox grant only, lives at
    // most an hour, and releasing the Allocation revokes both.
    const sessionId = crypto.randomUUID();
    await db
      .insertInto("agent_sessions")
      .values({
        id: sessionId,
        project_id: projectId,
        external_user_id: member.externalUserId,
        provider: "test",
        source: "api",
        status: "active",
        authority_host_id: "test-host",
      })
      .execute();
    const live = await allocations.create({
      identity: member,
      projectId,
      environmentName: "company",
      workloadKind: "agent",
      rootWorkloadId: sessionId,
      policy: allocation.policy,
    });
    const session = {
      identity: member,
      allocationId: live.id,
      agentSessionId: sessionId,
      alias: "directory",
    };
    const mcpGrant = await grants.issue(session);
    const firstSandbox = await grants.issue({
      ...session,
      channel: "sandbox",
      ttlSeconds: 3600,
    });
    const renewed = await grants.issue({
      ...session,
      channel: "sandbox",
      ttlSeconds: 7200,
    });
    await expect(
      grants.validate({ token: firstSandbox.token }),
    ).resolves.toBeNull();
    await expect(
      grants.validate({ token: renewed.token }),
    ).resolves.toMatchObject({
      channel: "sandbox",
      agentSessionId: sessionId,
      alias: "directory",
    });
    await expect(
      grants.validate({ token: mcpGrant.token }),
    ).resolves.toMatchObject({ channel: "mcp" });
    expect(Date.parse(renewed.expiresAt) - Date.now()).toBeLessThanOrEqual(
      3600 * 1000,
    );
    await grants.revokeAllocation({ allocationId: live.id });
    await expect(grants.validate({ token: renewed.token })).resolves.toBeNull();
    await expect(
      grants.validate({ token: mcpGrant.token }),
    ).resolves.toBeNull();

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

  it("reviews every action through the gateway's guards and audits each decision", async () => {
    let answer: "allow" | "deny" = "allow";
    const asked: string[] = [];
    const guarded = new ConnectionBroker(
      connections,
      providers,
      allocations,
      undefined,
      {
        guards: [
          {
            name: "other-kind",
            kinds: ["elsewhere"],
            review: async () => ({ verdict: "deny", reason: "never runs" }),
          },
          {
            name: "policy",
            kinds: ["fake"],
            review: async (context) => {
              const page =
                typeof context.input === "object" &&
                context.input !== null &&
                !Array.isArray(context.input)
                  ? context.input.page
                  : undefined;
              if (page === 666) return { verdict: "deny", reason: "too broad" };
              if (page === 7) return { verdict: "escalate", reason: "unusual" };
              if (page === 13) throw new Error("classifier crashed");
              // A reviewer that never answers.
              if (page === 99) return new Promise(() => {});
              return { verdict: "allow" };
            },
          },
        ],
        // The host sets how long a guard may take (ADR 0183).
        guardTimeoutMs: 50,
        approvals: {
          handlerFor: () => async (request) => {
            asked.push(`${request.sessionId}:${request.description}`);
            return { decision: answer };
          },
          list: () => [],
          get: () => undefined,
          answer: () => false,
        },
        sessionOwner: async () => "member",
      },
    );
    const [resolved] = await connections.resolve({
      identity: member,
      projectId,
      environment: "company",
      aliases: ["directory"],
      principalsByAlias: { directory: "service" },
    });
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
    const call = (page: number, caller: "agent" | "workflow" = "agent") =>
      guarded.invoke({
        identity: {
          tenantId,
          externalUserId: `connection-grant:${allocation.id}`,
          connectionScope: member.connectionScope,
          executionScope: member.executionScope,
          scope: member.scope,
        },
        allocationId: allocation.id,
        alias: "directory",
        action: "users.list",
        input: { page },
        caller,
        ...(caller === "agent" ? { agentSessionId: "session-1" } : {}),
      });

    await expect(call(1)).resolves.toEqual({ action: "users.list", ok: true });
    await expect(call(666)).rejects.toBeInstanceOf(ConnectionActionDeniedError);
    await expect(call(666)).rejects.toThrow("too broad");
    await expect(call(13)).rejects.toThrow("policy failed");

    await expect(call(7)).resolves.toEqual({ action: "users.list", ok: true });
    expect(asked).toEqual(["session-1:Needs your approval: unusual"]);
    // A guard that does not answer in time sends the action to a person.
    await expect(call(99)).resolves.toEqual({ action: "users.list", ok: true });
    expect(asked.at(-1)).toBe(
      "session-1:Needs your approval: policy did not answer",
    );
    answer = "deny";
    await expect(call(7)).rejects.toThrow("not approved");
    // A workflow cannot wait for a person mid-step; escalation refuses it.
    await expect(call(7, "workflow")).rejects.toThrow(
      "requires human approval",
    );
    expect(asked).toHaveLength(3);

    const audit = (
      await connections.listAudit({ identity: admin, projectId })
    ).filter(
      (event) =>
        event.eventType === "connection.invoked" &&
        event.allocationId === allocation.id,
    );
    const metadata = audit.map((event) => event.metadata);
    expect(metadata).toContainEqual({
      actor: "member",
      caller: "agent",
      guards: [{ guard: "policy", verdict: "deny", reason: "too broad" }],
    });
    expect(metadata).toContainEqual({
      actor: "member",
      caller: "agent",
      guards: [{ guard: "policy", verdict: "escalate", reason: "unusual" }],
      approval: "approved",
    });
    expect(metadata).toContainEqual({
      actor: `connection-grant:${allocation.id}`,
      caller: "workflow",
      guards: [{ guard: "policy", verdict: "escalate", reason: "unusual" }],
      approval: "unavailable",
    });
  });

  it("revalidates an enablement before every brokered action", async () => {
    const [resolved] = await connections.resolve({
      identity: member,
      projectId,
      environment: "company",
      aliases: ["directory"],
      principalsByAlias: { directory: "service" },
    });
    const enablementId = crypto.randomUUID();
    const allocation = await allocations.create({
      identity: member,
      projectId,
      environmentName: "company",
      workloadKind: "workflow",
      rootWorkloadId: crypto.randomUUID(),
      policy: {
        binding: {
          id: "managed",
          label: "Managed",
          trust: "managed",
          isolation: "sandbox",
          workloads: ["workflow"],
          agentTopologies: [],
          capabilities: ["network.egress"],
          resources: {},
        },
        requirements: { workload: "workflow" },
        connections: [resolved!],
        workflowEnablementId: enablementId,
      },
    });
    const revalidate = vi.fn(async () => {
      throw new Error("connection revoked");
    });
    const guardedBroker = new ConnectionBroker(
      connections,
      providers,
      allocations,
      () => ({ revalidate }) as unknown as WorkflowEnablementsService,
    );
    const invocationsBefore = decodedMaterials.length;

    await expect(
      guardedBroker.invoke({
        identity: member,
        allocationId: allocation.id,
        alias: "directory",
        action: "users.list",
        input: {},
      }),
    ).rejects.toThrow("Workflow enablement authority is unavailable");
    expect(revalidate).toHaveBeenCalledWith({ identity: member, enablementId });
    expect(decodedMaterials).toHaveLength(invocationsBefore);
  });

  it("refreshes with compare-and-swap and revokes locally when upstream fails", async () => {
    const expiring = await connections.create({
      identity: member,
      projectId,
      providerKind: "fake",
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

  it("never saves a personal connection whose authorization was cancelled", async () => {
    const person: Identity = { tenantId, externalUserId: "walks-away" };
    let finish = () => {};
    slowAuthorization = {
      started: false,
      finish: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    const started = await connections.beginPersonalAuthorization({
      identity: person,
      providerKind: "fake",
      redirectUri: "https://app.test/callback",
    });
    const completing = connections.completeAuthorization({
      identity: person,
      state: started.authorizationId,
      callback: { code: "slow" },
    });
    await vi.waitFor(() => expect(slowAuthorization.started).toBe(true));
    expect(
      await connections.cancelAuthorization({
        identity: person,
        state: started.authorizationId,
      }),
    ).toBe(true);
    finish();
    await expect(completing).rejects.toThrow();
    expect(
      await connections.personal({ identity: person, providerKind: "fake" }),
    ).toBeUndefined();
    // Nothing is left to cancel.
    expect(
      await connections.cancelAuthorization({
        identity: person,
        state: started.authorizationId,
      }),
    ).toBe(false);
  });
});
