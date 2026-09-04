import {
  AuthenticationRequiredError,
  type CatamorphicCore,
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
  environment: "local",
  owner: {
    type: "member" as const,
    externalUserId: TEST_IDENTITY.externalUserId,
  },
  connections: [],
  capabilities: [],
  consentDigest: "d".repeat(64),
  status: "active" as const,
  suspensionReason: null,
  updateAvailable: false,
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
      throw new AuthenticationRequiredError("local", [
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
      payload: { workflowName: "watchInbox", environment: "local" },
    });

    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({
      code: "authentication_required",
      environment: "local",
      requirements: [{ alias: "mail", providerKind: "mcp-mail" }],
    });
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
        environment: "local",
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
      environment: "local",
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
});
