import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp, TEST_IDENTITY } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const CONNECTION_ID = "b1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

const connection = {
  id: CONNECTION_ID,
  projectId: PROJECT_ID,
  providerKind: "google-workspace",
  principalKind: "member",
  name: null,
  ownerExternalUserId: TEST_IDENTITY.externalUserId,
  label: "Ada",
  status: "ready",
  account: { email: "ada@example.test" },
  scopes: ["directory.readonly"],
  capabilities: ["users.list"],
  expiresAt: null,
  revision: 1,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
} as const;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("connection control plane routes", () => {
  it("starts member authorization without returning private state", async () => {
    const beginAuthorization = vi.fn(async () => ({
      authorizationId: "authorization-id",
      challenge: {
        kind: "url" as const,
        url: "https://accounts.example.test/authorize?state=opaque",
      },
    }));
    const app = createTestApp({
      core: {
        connections: { beginAuthorization },
      } as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/environments/managed/connections/workspace/authorize`,
      payload: {
        redirectUri:
          "https://app.example.test/api/connection-authorizations/callback",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authorizationId: "authorization-id",
      challenge: {
        kind: "url",
        url: "https://accounts.example.test/authorize?state=opaque",
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("privateState");
    expect(beginAuthorization).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      projectId: PROJECT_ID,
      environment: "managed",
      alias: "workspace",
      redirectUri:
        "https://app.example.test/api/connection-authorizations/callback",
    });
  });

  it("completes OAuth callbacks without requiring the user's bearer session", async () => {
    const completeAuthorizationCallback = vi.fn(async () => connection);
    const app = createTestApp({
      core: {
        connections: { completeAuthorizationCallback },
      } as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/connection-authorizations/callback?state=opaque&code=code",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(connection);
    expect(completeAuthorizationCallback).toHaveBeenCalledWith({
      state: "opaque",
      callback: { code: "code" },
    });
  });

  it("creates named service connections and validates them first", async () => {
    const createService = vi.fn(async () => ({
      ...connection,
      principalKind: "tenant_service",
      ownerExternalUserId: null,
      projectId: null,
      name: "prod-replica",
      status: "pending",
    }));
    const app = createTestApp({
      core: {
        connections: {
          createService,
          providerCatalog: () => [
            { kind: "prod-replica", displayName: "Production replica" },
          ],
        },
      } as never,
    });
    apps.push(app);
    const create = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/service-connections", payload });

    expect(
      (
        await create({
          name: "Prod Replica",
          providerKind: "prod-replica",
          principalKind: "tenant_service",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await create({
          name: "prod-replica",
          providerKind: "prod-replica",
          principalKind: "project_service",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await create({
          name: "prod-replica",
          providerKind: "unknown",
          principalKind: "tenant_service",
        })
      ).statusCode,
    ).toBe(400);
    expect(createService).not.toHaveBeenCalled();
    const created = await create({
      name: "prod-replica",
      providerKind: "prod-replica",
      principalKind: "tenant_service",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "prod-replica" });
    expect(createService).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      name: "prod-replica",
      providerKind: "prod-replica",
      principalKind: "tenant_service",
    });
  });

  it("authorizes a service connection through this server's own callback", async () => {
    const beginServiceAuthorization = vi.fn(async () => ({
      authorizationId: "authorization-id",
      challenge: {
        kind: "form" as const,
        fields: [
          {
            name: "connectionString",
            label: "Read-only connection string",
            secret: true,
            required: true,
          },
        ],
      },
    }));
    const app = createTestApp({
      core: { connections: { beginServiceAuthorization } } as never,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/service-connections/${CONNECTION_ID}/authorize`,
      headers: { host: "work.example.test" },
    });
    expect(response.statusCode).toBe(200);
    expect(beginServiceAuthorization).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      connectionId: CONNECTION_ID,
      redirectUri:
        "http://work.example.test/api/connection-authorizations/callback",
    });
  });
});
