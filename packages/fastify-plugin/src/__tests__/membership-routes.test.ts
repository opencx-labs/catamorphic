import { AccessDeniedError, type Identity } from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { identityFromBearer } from "../http-identity.js";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const membership = {
  projectId: PROJECT_ID,
  externalUserId: "alice",
  roles: ["csm"],
  grants: { customer: ["acme"] },
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

function appWithCore(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const app = createTestApp({
    core: {
      roles: {
        list: async () => [
          { slug: "csm", definition: { version: 1, name: "CSM" } },
          { slug: "broken", invalid: { error: "Not valid JSON" } },
        ],
      },
      memberships: {
        list: async () => [membership],
        get: async (input: unknown) => {
          calls.push(input);
          return membership;
        },
        grant: async (input: unknown) => {
          calls.push(input);
          return membership;
        },
        revoke: async (input: unknown) => {
          calls.push(input);
          return true;
        },
      },
      ...overrides,
    } as never,
  });
  apps.push(app);
  return { app, calls };
}

describe("roles + memberships routes (ADR 0055)", () => {
  it("lists roles with per-file validity", async () => {
    const { app } = appWithCore();
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/roles`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { slug: "csm", definition: { version: 1, name: "CSM" } },
      { slug: "broken", invalid: { error: "Not valid JSON" } },
    ]);
  });

  it("grants, reads, lists and revokes memberships", async () => {
    const { app, calls } = appWithCore();
    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${PROJECT_ID}/memberships/alice`,
      payload: { roles: ["csm"], grants: { customer: ["acme"] } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(membership);
    expect(calls.at(-1)).toMatchObject({
      projectId: PROJECT_ID,
      externalUserId: "alice",
      roles: ["csm"],
      grants: { customer: ["acme"] },
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/memberships`,
    });
    expect(list.json()).toEqual([membership]);

    const one = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/memberships/alice`,
    });
    expect(one.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${PROJECT_ID}/memberships/alice`,
    });
    expect(del.statusCode).toBe(204);
  });

  it("validates the grant body", async () => {
    const { app } = appWithCore();
    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/${PROJECT_ID}/memberships/alice`,
      payload: { roles: "csm" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("maps AccessDeniedError to 403 (viewers may not administer)", async () => {
    const { app } = appWithCore({
      memberships: {
        list: async () => {
          throw new AccessDeniedError();
        },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/memberships`,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("identityFromBearer", () => {
  const alice: Identity = {
    tenantId: "t",
    externalUserId: "alice",
    scope: [{ kind: "agent", projectId: PROJECT_ID, name: "csm" }],
  };

  function bearerApp() {
    const app = createApp({
      identity: identityFromBearer(async (token) =>
        token === "good" ? alice : null,
      ),
      core: {
        memberships: {
          get: async () => membership,
        },
      } as never,
    });
    apps.push(app);
    return app;
  }

  it("verifies the token through the host and 401s everything else", async () => {
    const app = bearerApp();
    const url = `/api/projects/${PROJECT_ID}/memberships/alice`;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { authorization: "Basic abc" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { authorization: "Bearer stale" },
        })
      ).statusCode,
    ).toBe(401);
    const ok = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "bearer good" },
    });
    expect(ok.statusCode).toBe(200);
  });
});
