import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerStockAdmissionRoutes } from "./routes.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function setup() {
  const app = Fastify();
  apps.push(app);
  const createInvitation = vi.fn(async () => ({
    id: "invite-1",
    projectId: "project-1",
    expiresAt: "2026-09-02T00:00:00.000Z",
  }));
  const redeemInvitation = vi.fn(async () => ({
    projectId: "project-1",
    externalUserId: "user-1",
    roles: ["member"],
    grants: {},
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  }));
  const join = vi.fn(redeemInvitation);
  registerStockAdmissionRoutes(app, {
    publicBases: ["https://brain.acme.dev"],
    auth: {
      findUserById: async ({ userId }) => ({
        id: userId,
        name: "Ada Lovelace",
        email: "ada@acme.dev",
        emailVerified: true,
        username: "ada",
      }),
      resolveAccessToken: async ({ authorization }) =>
        authorization === "Bearer good"
          ? {
              userId: "user-1",
              email: "person@acme.dev",
              emailVerified: true,
              scopes: ["openid"],
            }
          : null,
    },
    identityForUser: async ({ externalUserId }) => ({
      tenantId: "tenant-1",
      externalUserId,
    }),
    admission: {
      listJoinableProjects: vi.fn(async () => [
        { id: "project-1", name: "Brain" },
      ]),
      listAccessRequests: vi.fn(async () => [
        {
          id: "request-1",
          externalUserId: "user-2",
          email: "grace@acme.dev",
          emailVerified: true,
          status: "pending",
          requestedAt: "2026-08-26T00:00:00.000Z",
        },
      ]),
      listMembers: vi.fn(async () => [
        {
          projectId: "project-1",
          externalUserId: "user-1",
          roles: ["manager"],
          grants: {},
          createdAt: "2026-08-26T00:00:00.000Z",
          updatedAt: "2026-08-26T00:00:00.000Z",
        },
      ]),
      setPolicy: vi.fn(),
      createInvitation,
      redeemInvitation,
      join,
      requestAccess: vi.fn(),
      decideRequest: vi.fn(),
    },
  });
  return { app, createInvitation, redeemInvitation, join };
}

describe("stock admission routes", () => {
  it("lists projects the authenticated user may join immediately", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/admission/projects",
      headers: { authorization: "Bearer good" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: "project-1", name: "Brain" }]);
  });

  it("lists members with stock-host identity labels", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/admission/members",
      headers: { authorization: "Bearer good" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        externalUserId: "user-1",
        name: "Ada Lovelace",
        email: "ada@acme.dev",
        roles: ["manager"],
      }),
    ]);
  });

  it("lists pending admission requests for project managers", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/project-1/admission/requests",
      headers: { authorization: "Bearer good" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: "request-1",
        email: "grace@acme.dev",
      }),
    ]);
  });

  it("returns a credential-free invitation locator", async () => {
    const { app } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/admission/invitations",
      headers: { authorization: "Bearer good" },
      payload: { email: "invitee@acme.dev" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().connectLinks[0]).toBe(
      "catamorphic://connect?server=https%3A%2F%2Fbrain.acme.dev%2Fapi&project=project-1&invitation=invite-1",
    );
    expect(response.json().connectLinks[0]).not.toContain("token=");
    expect(response.json().webLinks[0]).toBe(
      "https://brain.acme.dev/?server=https%3A%2F%2Fbrain.acme.dev%2Fapi&project=project-1&invitation=invite-1",
    );
  });

  it("redeems an invitation as the authenticated user", async () => {
    const { app, redeemInvitation } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/admission/invitations/invite-1/redeem",
      headers: { authorization: "Bearer good" },
    });

    expect(response.statusCode).toBe(200);
    expect(redeemInvitation).toHaveBeenCalledWith({
      projectId: "project-1",
      invitationId: "invite-1",
      user: {
        id: "user-1",
        email: "person@acme.dev",
        emailVerified: true,
      },
    });
  });

  it("rejects missing or invalid OAuth access tokens", async () => {
    const { app, join } = setup();

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects/project-1/admission/join",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects/project-1/admission/join",
          headers: { authorization: "Bearer bad" },
        })
      ).statusCode,
    ).toBe(401);
    expect(join).not.toHaveBeenCalled();
  });
});
