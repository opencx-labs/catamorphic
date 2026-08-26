import type { Identity } from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /me (ADR 0055 introspection)", () => {
  it("summarises the caller's scope per project and the host's features", async () => {
    const alice: Identity = {
      tenantId: "t",
      externalUserId: "alice",
      scope: [
        { kind: "agent", projectId: PROJECT_ID, name: "csm" },
        { kind: "workflow", projectId: PROJECT_ID, name: "crm.lookup" },
        { kind: "document", projectId: PROJECT_ID, path: "docs/**" },
        {
          kind: "document",
          projectId: PROJECT_ID,
          path: "store/customers/acme/**",
          access: "write",
        },
        { kind: "project", projectId: "other" },
      ],
    };
    const app = createApp({
      identity: () => alice,
      core: {
        proposals: {},
        proposalsOpenPullRequests: true,
        agentSessions: {},
      } as never,
      features: { publications: "members" },
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: 1,
      identity: { externalUserId: "alice", root: false },
      projects: [
        {
          projectId: PROJECT_ID,
          builder: false,
          source: null,
          permissions: [],
          agents: ["csm"],
          workflows: ["crm.lookup"],
          apps: [],
          documents: [
            { path: "docs/**", access: "read" },
            { path: "store/customers/acme/**", access: "write" },
          ],
        },
        {
          projectId: "other",
          builder: true,
          source: null,
          permissions: [],
          agents: [],
          workflows: [],
          apps: [],
          documents: [],
        },
      ],
      features: {
        publications: "members",
        proposals: true,
        proposalsOpenPullRequests: true,
        mcp: true,
        agentSessions: true,
        storeUploadMaxBytes: 64 * 1024 * 1024,
      },
    });
  });

  it("discloses repository source only to builders", async () => {
    const builder: Identity = {
      tenantId: "t",
      externalUserId: "builder",
      scope: [{ kind: "project", projectId: PROJECT_ID }],
    };
    const app = createApp({
      identity: () => builder,
      core: {
        projects: {
          get: async () => ({
            remoteUrl: "https://github.com/acme/brain.git",
            defaultBranch: "main",
          }),
        },
      } as never,
    });
    apps.push(app);
    const body = (await app.inject({ method: "GET", url: "/api/me" })).json();
    expect(body.projects[0]?.source).toEqual({
      remoteUrl: "https://github.com/acme/brain.git",
      defaultBranch: "main",
    });
  });

  it("root identities say so; defaults are permissive", async () => {
    const app = createTestApp({ core: {} as never });
    apps.push(app);
    const body = (await app.inject({ method: "GET", url: "/api/me" })).json();
    expect(body.identity.root).toBe(true);
    expect(body.projects).toEqual([]);
    expect(body.features).toMatchObject({
      publications: "public",
      proposals: false,
      mcp: true,
    });
  });

  it("features are enforced, not just advertised", async () => {
    const calls: string[] = [];
    const app = createTestApp({
      core: {
        publications: {
          publish: async () => {
            calls.push("publish");
            return {};
          },
        },
        proposals: {
          propose: async () => {
            calls.push("propose");
            return { branch: "x" };
          },
        },
      } as never,
      features: { publications: "members", proposals: false, mcp: false },
    });
    apps.push(app);
    const pub = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/publications`,
      payload: { path: "store/x.md", audience: "public" },
    });
    expect(pub.statusCode).toBe(403);
    const prop = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/proposals`,
      payload: { title: "x", changes: [{ path: "docs/a.md", content: "b" }] },
    });
    expect(prop.statusCode).toBe(403);
    const mcp = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/mcp`,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(mcp.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});
