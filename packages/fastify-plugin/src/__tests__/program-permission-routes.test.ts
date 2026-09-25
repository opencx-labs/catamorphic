import { DeploymentBlockedError, type Identity } from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function member(...permissions: string[]): Identity {
  return {
    tenantId: "t",
    externalUserId: "member",
    scope: [],
    projectPermissions: permissions.map((permission) => ({
      projectId: PROJECT_ID,
      permission,
    })),
  };
}

/** A core whose services record calls; project existence is not the test. */
function fakeCore() {
  return {
    projects: { get: vi.fn(async () => ({ id: PROJECT_ID })) },
    plugins: {
      listAttached: vi.fn(async () => []),
      attach: vi.fn(async () => ({
        packageName: "@acme/plugin",
        version: "1.0.0",
      })),
      detach: vi.fn(async () => true),
    },
    deployment: {
      deploy: vi.fn(
        async (
          _tenantId: string,
          _projectId: string,
          _userId: string,
          _options: {
            guardPublishedPaths?: (paths: readonly string[]) => void;
          },
        ) => ({
          status: "nothing-to-deploy",
          commitSha: null,
          remoteSha: null,
          conflicts: [],
        }),
      ),
      checkoutBranch: vi.fn(async () => ({})),
      discardDraft: vi.fn(async () => ({})),
    },
  };
}

function appFor(identity: Identity, core: ReturnType<typeof fakeCore>) {
  const app = createApp({ identity: () => identity, core: core as never });
  apps.push(app);
  return app;
}

describe("program permissions on project routes (ADR 0158)", () => {
  it("attaching or detaching a plugin publishes the program", async () => {
    const core = fakeCore();
    const reader = appFor(member("program:write"), core);
    const attach = await reader.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plugins`,
      payload: { packageName: "@acme/plugin" },
    });
    expect(attach.statusCode).toBe(403);
    const detach = await reader.inject({
      method: "DELETE",
      url: `/api/projects/${PROJECT_ID}/plugins/${encodeURIComponent("@acme/plugin")}`,
    });
    expect(detach.statusCode).toBe(403);
    expect(core.plugins.attach).not.toHaveBeenCalled();
    expect(core.plugins.detach).not.toHaveBeenCalled();

    const publisher = appFor(member("program:publish"), core);
    await publisher.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/plugins`,
      payload: { packageName: "@acme/plugin" },
    });
    expect(core.plugins.attach).toHaveBeenCalledWith(
      PROJECT_ID,
      "@acme/plugin",
    );
  });

  it("reading attached plugins goes through the project's program read", async () => {
    const core = fakeCore();
    core.projects.get.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "AccessDeniedError" }),
    );
    const app = appFor(member(), core);
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/plugins`,
    });
    expect(response.statusCode).not.toBe(200);
    expect(core.plugins.listAttached).not.toHaveBeenCalled();
  });

  it("a program reader cannot deploy, check out or discard", async () => {
    const core = fakeCore();
    const reader = appFor(member("program:read"), core);
    for (const [url, payload] of [
      ["deploy", {}],
      ["checkout", { ref: "work" }],
      ["discard", {}],
    ] as const) {
      const response = await reader.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/${url}`,
        payload,
      });
      expect(response.statusCode, url).toBe(403);
    }
    expect(core.deployment.deploy).not.toHaveBeenCalled();
    expect(core.deployment.checkoutBranch).not.toHaveBeenCalled();
    expect(core.deployment.discardDraft).not.toHaveBeenCalled();
  });

  it("publishing guards role files in the published diff", async () => {
    const core = fakeCore();
    const publisher = appFor(member("program:publish"), core);
    const response = await publisher.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/deploy`,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const guard = core.deployment.deploy.mock.calls[0]?.[3].guardPublishedPaths;
    expect(guard).toBeDefined();
    expect(() => guard?.(["docs/a.md"])).not.toThrow();
    expect(() => guard?.([".catamorphic/roles/admin.json"])).toThrow();
  });

  it("answers 409 when publishing is blocked by unrecorded changes", async () => {
    const core = fakeCore();
    core.deployment.deploy.mockRejectedValueOnce(
      new DeploymentBlockedError(
        "Record the changes you want to publish in Git first.",
      ),
    );
    const response = await appFor(member("program:publish"), core).inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/deploy`,
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Record the changes");
  });
});
