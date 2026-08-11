import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { workflowKeys } from "../../workflow-keys.js";
import { useWorkflow } from "../use-workflow.js";
import { useWorkflows } from "../use-workflows.js";
import { useWriteProjectFile } from "../use-write-project-file.js";

const PROJECT_ID = "project-1";
const WORKFLOW_NAME = "sample";

const workflow = {
  name: WORKFLOW_NAME,
  capabilities: {
    persistedContinuations: false,
    batchProcessing: false,
    cancellation: false,
  },
  filePath: "workflows/sample.ts",
  input: { parameters: [] },
  triggers: [],
  canSuspend: false,
  nodes: [],
  edges: [],
  sourceCode: "",
};

describe("workflow query keys", () => {
  it("shares a project hierarchy across lists and details", async () => {
    server.use(
      http.get(apiUrl(`/api/projects/${PROJECT_ID}/workflows`), () =>
        HttpResponse.json([workflow]),
      ),
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/workflows/${WORKFLOW_NAME}`),
        () => HttpResponse.json(workflow),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => ({
      list: useWorkflows(PROJECT_ID),
      detail: useWorkflow(PROJECT_ID, WORKFLOW_NAME),
    }));

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    expect(
      queryClient.getQueryData(
        workflowKeys.list({ projectId: PROJECT_ID, ref: undefined }),
      ),
    ).toEqual([workflow]);
    expect(
      queryClient.getQueryData(
        workflowKeys.detail({
          projectId: PROJECT_ID,
          name: WORKFLOW_NAME,
          ref: undefined,
        }),
      ),
    ).toEqual(workflow);
  });

  it("invalidates list and detail queries after a file write", async () => {
    server.use(
      http.put(
        apiUrl(`/api/projects/${PROJECT_ID}/files/workflows/sample.ts`),
        () =>
          HttpResponse.json({
            path: "workflows/sample.ts",
            content: "export {}",
          }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useWriteProjectFile(PROJECT_ID),
    );
    const listKey = workflowKeys.list({
      projectId: PROJECT_ID,
      ref: undefined,
    });
    const detailKey = workflowKeys.detail({
      projectId: PROJECT_ID,
      name: WORKFLOW_NAME,
      ref: undefined,
    });
    queryClient.setQueryData(listKey, [workflow]);
    queryClient.setQueryData(detailKey, workflow);

    await result.current.mutateAsync({
      path: "workflows/sample.ts",
      content: "export {}",
    });

    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });
});
