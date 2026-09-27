import {
  type CatamorphicCore,
  CodeHostNotConnectedError,
  ProjectAlreadyLinkedError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const connection = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: null,
  providerKind: "github",
  principalKind: "member",
  name: null,
  ownerExternalUserId: "test-user",
  label: "GitHub",
  status: "ready",
  account: { type: "user", login: "octo" },
  scopes: [],
  capabilities: [],
  expiresAt: null,
  revision: 1,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

function app(overrides: Record<string, unknown> = {}) {
  const codeHosts = {
    available: true,
    list: () => [{ provider: "github", displayName: "GitHub" }],
    personalConnection: vi.fn(async () => connection),
    listRepositories: vi.fn(async () => [
      {
        fullName: "octo/hello",
        name: "hello",
        owner: "octo",
        private: true,
        defaultBranch: "main",
        cloneUrl: "https://github.com/octo/hello.git",
        description: null,
        pushedAt: null,
      },
    ]),
    importRepository: vi.fn(async () => ({
      id: PROJECT_ID,
      tenantId: "t",
      name: "hello",
      storageType: "managed",
      remoteUrl: "https://github.com/octo/hello.git",
      remoteOwnership: "attached",
      defaultBranch: "main",
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    })),
    publishProject: vi.fn(async () => {
      throw new ProjectAlreadyLinkedError(PROJECT_ID);
    }),
    ...overrides,
  };
  const beginPersonalAuthorization = vi.fn(async () => ({
    authorizationId: "state-1",
    challenge: {
      kind: "device",
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
    },
  }));
  const instance = createTestApp({
    core: {
      codeHosts,
      connections: { beginPersonalAuthorization },
    } as unknown as CatamorphicCore,
  });
  apps.push(instance);
  return { instance, codeHosts, beginPersonalAuthorization };
}

describe("code host routes (ADR 0177)", () => {
  it("lists code hosts with the caller's personal connection", async () => {
    const { instance } = app();
    const response = await instance.inject({ url: "/api/code-hosts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { provider: "github", displayName: "GitHub", connection },
    ]);
  });

  it("starts a personal authorization through core connections", async () => {
    const { instance, beginPersonalAuthorization } = app();
    const response = await instance.inject({
      method: "POST",
      url: "/api/code-hosts/github/connection/authorize",
      payload: { redirectUri: "https://work.test/callback" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authorizationId: "state-1",
      challenge: { kind: "device", userCode: "ABCD-1234" },
    });
    expect(beginPersonalAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ providerKind: "github" }),
    );
    const unknown = await instance.inject({
      method: "POST",
      url: "/api/code-hosts/gitlab/connection/authorize",
      payload: { redirectUri: "https://work.test/callback" },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("lists repositories, imports one, and maps code-host failures", async () => {
    const { instance, codeHosts } = app();
    const repositories = await instance.inject({
      url: "/api/code-hosts/github/repositories",
    });
    expect(repositories.json()).toHaveLength(1);
    const imported = await instance.inject({
      method: "POST",
      url: "/api/code-hosts/github/import",
      payload: { fullName: "octo/hello" },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      remoteUrl: "https://github.com/octo/hello.git",
      remoteOwnership: "attached",
    });
    expect(codeHosts.importRepository).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github", fullName: "octo/hello" }),
    );
    const published = await instance.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/code-host/publish`,
      payload: { provider: "github", name: "hello" },
    });
    expect(published.statusCode).toBe(409);

    const { instance: unconnected } = app({
      listRepositories: vi.fn(async () => {
        throw new CodeHostNotConnectedError("github");
      }),
    });
    const refused = await unconnected.inject({
      url: "/api/code-hosts/github/repositories",
    });
    expect(refused.statusCode).toBe(401);
  });
});
