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

  it("rejects malformed service credentials before they reach the vault", async () => {
    const create = vi.fn();
    const app = createTestApp({
      core: { connections: { create } } as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/connections`,
      payload: {
        providerKind: "google-workspace",
        principalKind: "project_service",
        label: "Directory administrator",
        credential: "",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
