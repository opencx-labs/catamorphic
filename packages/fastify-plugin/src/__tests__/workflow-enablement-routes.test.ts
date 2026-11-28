import {
  AuthenticationRequiredError,
  type CatamorphicCore,
  EnvironmentAccessDeniedError,
  EnvironmentNotFoundError,
  EnvironmentPolicyInvalidError,
  PublishedRevisionNotRetryableError,
  WorkflowEnablementFollowUnavailableError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp, TEST_IDENTITY } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const ENABLEMENT_ID = "b1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

const enablement = {
  id: ENABLEMENT_ID,
  projectId: PROJECT_ID,
  workflowName: "watchInbox",
  deploymentArtifactId: "c1b2c3d4-e5f6-4890-abcd-ef1234567890",
  commitSha: "a".repeat(40),
  remoteBranch: "main",
  environment: "default",
  owner: {
    type: "member" as const,
    externalUserId: TEST_IDENTITY.externalUserId,
  },
  connections: [],
  permissions: [],
  documents: [{ path: "store/inbox/", access: "write" as const }],
  capabilities: [],
  consentDigest: "d".repeat(64),
  status: "active" as const,
  suspensionReason: null,
  updateAvailable: false,
  follow: true,
  temporary: false,
  expiresAt: null,
  revision: 1,
  triggers: [],
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("workflow enablement routes", () => {
  it("returns typed authentication requirements from preview", async () => {
    const preview = vi.fn(async () => {
      throw new AuthenticationRequiredError("default", [
        {
          alias: "mail",
          providerKind: "mcp-mail",
          principalKinds: ["member"],
        },
      ]);
    });
    const app = createTestApp({
      core: { workflowEnablements: { preview } } as unknown as CatamorphicCore,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/workflow-enablement-preview`,
      payload: { workflowName: "watchInbox", environment: "default" },
    });

    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({
      code: "authentication_required",
      environment: "default",
      requirements: [{ alias: "mail", providerKind: "mcp-mail" }],
    });
  });

  it("answers an Environment the caller may not use, or that is not declared, as a refusal", async () => {
    for (const [error, status] of [
      [new EnvironmentAccessDeniedError("github-poster"), 403],
      [new EnvironmentNotFoundError("github-poster"), 409],
      [new EnvironmentPolicyInvalidError("bad manifest"), 409],
    ] as const) {
      const preview = vi.fn(async () => {
        throw error;
      });
      const app = createTestApp({
        core: {
          workflowEnablements: { preview },
        } as unknown as CatamorphicCore,
      });
      apps.push(app);
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/workflow-enablement-preview`,
        payload: { workflowName: "postReviews", environment: "github-poster" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: error.message });
    }
  });

  it("passes exact consent to creation and returns the pinned enablement", async () => {
    const create = vi.fn(async () => enablement);
    const app = createTestApp({
      core: { workflowEnablements: { create } } as unknown as CatamorphicCore,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/workflow-enablements`,
      payload: {
        workflowName: "watchInbox",
        environment: "default",
        connectionSelections: {
          mail: "d1b2c3d4-e5f6-4890-abcd-ef1234567890",
        },
        consentDigest: "d".repeat(64),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(enablement);
    expect(create).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      projectId: PROJECT_ID,
      workflowName: "watchInbox",
      environment: "default",
      connectionSelections: {
        mail: "d1b2c3d4-e5f6-4890-abcd-ef1234567890",
      },
      consentDigest: "d".repeat(64),
    });
  });

  it("checks the path project before applying a mutation", async () => {
    const get = vi.fn(async () => ({
      ...enablement,
      projectId: crypto.randomUUID(),
    }));
    const disable = vi.fn(async () => enablement);
    const app = createTestApp({
      core: {
        workflowEnablements: { get, disable },
      } as unknown as CatamorphicCore,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/workflow-enablements/${ENABLEMENT_ID}/disable`,
    });

    expect(response.statusCode).toBe(404);
    expect(disable).not.toHaveBeenCalled();
  });

  it("turns following on and off, and refuses it where it cannot follow", async () => {
    const get = vi.fn(async () => enablement);
    const setFollow = vi.fn(async ({ follow }: { follow: boolean }) => ({
      ...enablement,
      follow,
    }));
    const app = createTestApp({
      core: {
        workflowEnablements: { get, setFollow },
      } as unknown as CatamorphicCore,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/workflow-enablements/${ENABLEMENT_ID}/follow`,
      payload: { follow: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ follow: false });
    expect(setFollow).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      enablementId: ENABLEMENT_ID,
      follow: false,
    });

    setFollow.mockRejectedValueOnce(
      new WorkflowEnablementFollowUnavailableError(),
    );
    const refused = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/workflow-enablements/${ENABLEMENT_ID}/follow`,
      payload: { follow: true },
    });
    expect(refused.statusCode).toBe(409);
  });

  it("lists the project's published revisions", async () => {
    const list = vi.fn(async () => [
      {
        id: ENABLEMENT_ID,
        sequence: 7,
        projectId: PROJECT_ID,
        commitSha: "b".repeat(40),
        status: "failed" as const,
        deployEventId: "d1b2c3d4-e5f6-4890-abcd-ef1234567890",
        deployRuns: [{ workflowName: "migrateDatabase", runId: null }],
        previousCommitSha: "a".repeat(40),
        error: "The deploy workflow migrateDatabase failed",
        report: [],
        createdAt: "2026-11-17T00:00:00.000Z",
        settledAt: "2026-11-17T00:01:00.000Z",
      },
    ]);
    const app = createTestApp({
      core: { publishedRevisions: { list } } as unknown as CatamorphicCore,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/published-revisions?limit=5`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      status: "failed",
      deployEventId: "d1b2c3d4-e5f6-4890-abcd-ef1234567890",
      deployRuns: [{ workflowName: "migrateDatabase", runId: null }],
    });
    expect(list).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      projectId: PROJECT_ID,
      limit: 5,
    });
  });

  it("tries the latest failed revision again, and says when there is none", async () => {
    const revision = {
      id: ENABLEMENT_ID,
      sequence: 8,
      projectId: PROJECT_ID,
      commitSha: "c".repeat(40),
      status: "pending" as const,
      deployEventId: null,
      deployRuns: [],
      previousCommitSha: "b".repeat(40),
      error: null,
      report: [],
      createdAt: "2026-11-17T00:00:00.000Z",
      settledAt: null,
    };
    const retry = vi.fn(async () => revision);
    const app = createTestApp({
      core: { publishedRevisions: { retry } } as unknown as CatamorphicCore,
    });
    apps.push(app);
    const url = `/api/projects/${PROJECT_ID}/published-revisions/retry`;

    const response = await app.inject({ method: "POST", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "pending" });
    expect(retry).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      projectId: PROJECT_ID,
    });

    retry.mockRejectedValueOnce(
      new PublishedRevisionNotRetryableError("Nothing to try again"),
    );
    const none = await app.inject({ method: "POST", url });
    expect(none.statusCode).toBe(409);
  });
});
