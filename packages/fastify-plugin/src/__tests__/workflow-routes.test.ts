import {
  type CatamorphicCore,
  RunResumeConflictError,
  RunSignalInvalidError,
  RunSignalLimitError,
  RunSignalNotFoundError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const headers = {
  "x-catamorphic-tenant-id": "tenant-1",
  "x-external-user-id": "user-1",
};
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("workflow route contracts", () => {
  it("forwards ref when listing workflows and omits execution", async () => {
    const list = vi.fn(async () => [
      {
        name: "example",
        capabilities: {
          persistedContinuations: false,
          batchProcessing: false,
          cancellation: false,
        },
        execution: {
          exportTarget: {
            modulePath: "src/index.ts",
            exportName: "example",
          },
          steps: [],
        },
        displayName: null,
        description: null,
        filePath: "src/index.ts",
        parameterCount: 0,
        triggers: [],
        canSuspend: false,
      },
    ]);
    const core = { workflows: { list } } as unknown as CatamorphicCore;
    const app = createTestApp({ core });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/workflows?ref=origin%2Fmain`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({
      identity: { tenantId: "tenant-1", externalUserId: "user-1" },
      projectId: PROJECT_ID,
      ref: "origin/main",
    });
    expect(response.json()[0]).not.toHaveProperty("execution");
  });

  it("requires project files on workflow detail and omits parser execution data", async () => {
    const get = vi.fn(async () => ({
      name: "example",
      capabilities: {
        persistedContinuations: true,
        batchProcessing: false,
        cancellation: true,
      },
      execution: {
        exportTarget: { modulePath: "src/index.ts", exportName: "example" },
        steps: [],
      },
      input: { parameters: [] },
      inputSchema: {},
      outputSchema: {},
      triggers: [],
      connections: [],
      permissions: [],
      canSuspend: true,
      nodes: [
        {
          id: "input",
          type: "input" as const,
          label: "Trigger",
          sourceRange: {
            start: 0,
            end: 1,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 2,
          },
          metadata: {},
          workflowTarget: {
            exportTarget: { modulePath: "src/child.ts", exportName: "child" },
            capabilities: {
              persistedContinuations: false,
              batchProcessing: false,
              cancellation: false,
            },
            execution: {
              exportTarget: { modulePath: "src/child.ts", exportName: "child" },
              steps: [],
            },
          },
        },
      ],
      edges: [],
      sourceCode: "export const example = true;",
      filePath: "src/index.ts",
      projectFiles: ["src/index.ts"],
      allFiles: { "src/index.ts": "export const example = true;" },
    }));
    const core = { workflows: { get } } as unknown as CatamorphicCore;
    const app = createTestApp({ core });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/workflows/example`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectFiles: ["src/index.ts"],
      allFiles: { "src/index.ts": "export const example = true;" },
    });
    expect(response.json()).not.toHaveProperty("execution");
    expect(response.json().nodes[0]).not.toHaveProperty("workflowTarget");
  });

  it("rejects workflow details without projectFiles and allFiles", async () => {
    const get = vi.fn(async () => ({
      name: "example",
      capabilities: {
        persistedContinuations: false,
        batchProcessing: false,
        cancellation: false,
      },
      execution: {
        exportTarget: { modulePath: "src/index.ts", exportName: "example" },
        steps: [],
      },
      input: { parameters: [] },
      inputSchema: {},
      outputSchema: {},
      triggers: [],
      connections: [],
      permissions: [],
      canSuspend: false,
      nodes: [],
      edges: [],
      sourceCode: "export const example = true;",
    }));
    const core = { workflows: { get } } as unknown as CatamorphicCore;
    const app = createTestApp({ core });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/workflows/example`,
      headers,
    });

    expect(response.statusCode).toBe(500);
  });
});

describe("named signal route", () => {
  const runId = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
  const id = "c3d4e5f6-a7b8-4890-acde-123456789012";
  const pauseId = "d4e5f6a7-b8c9-4890-8efa-234567890123";
  const payload = {
    runId,
    correlationKey: "subject",
    signal: "reply",
    idempotencyKey: "event-1",
    value: { approved: true },
  };
  const url = `/api/projects/${PROJECT_ID}/workflows/journey/signals`;

  it.each([
    { id, runId, status: "buffered", pauseId: null },
    { id, runId, status: "resumed", pauseId },
    { id, runId, status: "discarded", pauseId: null },
  ])(
    "returns the $status receipt and forwards its generation",
    async (receipt) => {
      const signalByKey = vi.fn(async () => receipt);
      const app = createTestApp({
        core: { runs: { signalByKey } } as unknown as CatamorphicCore,
      });
      apps.push(app);
      const response = await app.inject({
        method: "POST",
        url,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(receipt);
      expect(signalByKey).toHaveBeenCalledWith({
        ...payload,
        identity: { tenantId: "tenant-1", externalUserId: "user-1" },
        projectId: PROJECT_ID,
        workflowName: "journey",
      });
    },
  );

  it("requires an explicit run generation", async () => {
    const signalByKey = vi.fn();
    const app = createTestApp({
      core: { runs: { signalByKey } } as unknown as CatamorphicCore,
    });
    apps.push(app);
    const { runId: omitted, ...unfenced } = payload;
    expect(omitted).toBe(runId);
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload: unfenced,
    });
    expect(response.statusCode).toBe(400);
    expect(signalByKey).not.toHaveBeenCalled();
  });

  it.each([
    {
      error: new RunSignalLimitError("Signal value exceeds 64 KiB"),
      status: 429,
    },
    { error: new RunSignalInvalidError("Invalid name"), status: 400 },
    {
      error: new RunSignalNotFoundError("journey", "subject", "reply"),
      status: 404,
    },
    {
      error: new RunResumeConflictError("Run generation is not active"),
      status: 409,
    },
  ])("maps $status signal errors", async ({ error, status }) => {
    const signalByKey = vi.fn(async () => {
      throw error;
    });
    const app = createTestApp({
      core: { runs: { signalByKey } } as unknown as CatamorphicCore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: error.message });
  });
});
