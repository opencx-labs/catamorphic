import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import type { BatchItem, BatchRun } from "../../types.js";
import { useBatchItemSteps } from "../use-batch-item-steps.js";
import { useBatchRun } from "../use-batch-run.js";
import { useBatchRunItems } from "../use-batch-run-items.js";
import { useBatchRuns } from "../use-batch-runs.js";
import { useCancelBatchRun } from "../use-cancel-batch-run.js";
import { usePauseBatchRun } from "../use-pause-batch-run.js";
import { useResumeBatchRun } from "../use-resume-batch-run.js";
import { useRetryFailedBatchItems } from "../use-retry-failed-batch-items.js";
import { useTriggerBatchRun } from "../use-trigger-batch-run.js";

const BATCH_RUN: BatchRun = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-0000000000aa",
  workflowName: "importContacts",
  deploymentArtifactId: null,
  mode: "production",
  initiatedBy: "user-1",
  status: "running",
  triggerData: null,
  sourceSnapshot: null,
  sourceCursor: null,
  sourceConsistency: null,
  estimatedCount: 100,
  discoveredCount: 40,
  completedCount: 30,
  failedCount: 2,
  skippedCount: 1,
  failurePolicy: null,
  artifact: null,
  sinkCompletedChunks: 0,
  sinkTotalChunks: 0,
  error: null,
  startedAt: "2026-07-12T12:00:00.000Z",
  completedAt: null,
  createdAt: "2026-07-12T12:00:00.000Z",
};

const BATCH_ITEM: BatchItem = {
  id: "00000000-0000-0000-0000-000000000002",
  batchRunId: BATCH_RUN.id,
  key: "contact-1",
  sourceOrder: 0,
  status: "failed",
  value: null,
  valueReference: null,
  output: null,
  outputReference: null,
  error: "Invalid email",
  currentNodeId: null,
  availableAt: "2026-07-12T12:00:00.000Z",
  attempt: 1,
  createdAt: "2026-07-12T12:00:00.000Z",
  updatedAt: "2026-07-12T12:00:01.000Z",
  completedAt: "2026-07-12T12:00:01.000Z",
};

describe("batch run hooks", () => {
  it("lists batch runs with pagination", async () => {
    server.use(
      http.get(
        apiUrl("/api/projects/proj/workflows/importContacts/batch-runs"),
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("limit")).toBe("10");
          expect(url.searchParams.get("offset")).toBe("20");
          return HttpResponse.json({ items: [BATCH_RUN], total: 1 });
        },
      ),
    );

    const { result } = renderHookWithProviders(() =>
      useBatchRuns({
        projectId: "proj",
        workflowName: "importContacts",
        limit: 10,
        offset: 20,
        activeRefetchInterval: false,
      }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.status).toBe("running");
  });

  it("gets a batch run", async () => {
    server.use(
      http.get(apiUrl(`/api/batch-runs/${BATCH_RUN.id}`), () =>
        HttpResponse.json(BATCH_RUN),
      ),
    );

    const { result } = renderHookWithProviders(() =>
      useBatchRun({
        batchRunId: BATCH_RUN.id,
        activeRefetchInterval: false,
      }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.completedCount).toBe(30);
  });

  it("filters and paginates batch items", async () => {
    server.use(
      http.get(
        apiUrl(`/api/batch-runs/${BATCH_RUN.id}/items`),
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("status")).toBe("failed");
          expect(url.searchParams.get("limit")).toBe("25");
          expect(url.searchParams.get("offset")).toBe("50");
          return HttpResponse.json({ items: [BATCH_ITEM], total: 1 });
        },
      ),
    );

    const { result } = renderHookWithProviders(() =>
      useBatchRunItems({
        batchRunId: BATCH_RUN.id,
        status: "failed",
        limit: 25,
        offset: 50,
        activeRefetchInterval: false,
      }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.error).toBe("Invalid email");
  });

  it("loads persisted item step history", async () => {
    server.use(
      http.get(
        apiUrl(`/api/batch-runs/${BATCH_RUN.id}/items/${BATCH_ITEM.id}/steps`),
        () =>
          HttpResponse.json([
            {
              id: "00000000-0000-0000-0000-000000000003",
              itemId: BATCH_ITEM.id,
              nodeId: "normalize",
              occurrence: 0,
              attempt: 1,
              name: "Normalize",
              status: "completed",
              input: null,
              output: null,
              error: null,
              startedAt: "2026-07-12T12:00:00.000Z",
              completedAt: "2026-07-12T12:00:01.000Z",
            },
          ]),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useBatchItemSteps({
        batchRunId: BATCH_RUN.id,
        itemId: BATCH_ITEM.id,
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.nodeId).toBe("normalize");
  });

  it("triggers a batch run and invalidates its list", async () => {
    let body: unknown;
    server.use(
      http.post(
        apiUrl("/api/projects/proj/workflows/importContacts/batch-runs"),
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json(BATCH_RUN, { status: 201 });
        },
      ),
    );

    const { result, queryClient } = renderHookWithProviders(() =>
      useTriggerBatchRun({
        projectId: "proj",
        workflowName: "importContacts",
      }),
    );
    const queryKey = [
      "cat",
      "project",
      "proj",
      "workflow",
      "importContacts",
      "batch-runs",
      { limit: 20 },
    ];
    queryClient.setQueryData(queryKey, { items: [], total: 0 });

    const batchRun = await result.current.mutateAsync({
      triggerData: { source: "crm" },
    });

    expect(batchRun.id).toBe(BATCH_RUN.id);
    expect(body).toEqual({ triggerData: { source: "crm" } });
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  });

  it("cancels a batch run and updates its detail cache", async () => {
    const canceledRun: BatchRun = { ...BATCH_RUN, status: "canceled" };
    server.use(
      http.post(apiUrl(`/api/batch-runs/${BATCH_RUN.id}/cancel`), () =>
        HttpResponse.json(canceledRun),
      ),
    );

    const { result, queryClient } = renderHookWithProviders(() =>
      useCancelBatchRun({
        projectId: "proj",
        workflowName: "importContacts",
      }),
    );
    const canceled = await result.current.mutateAsync({
      batchRunId: BATCH_RUN.id,
    });

    expect(canceled.status).toBe("canceled");
    expect(
      queryClient.getQueryData(["cat", "batch-run", BATCH_RUN.id]),
    ).toEqual(canceledRun);
  });

  it("pauses and resumes a batch run", async () => {
    const pausedRun: BatchRun = { ...BATCH_RUN, status: "paused" };
    server.use(
      http.post(apiUrl(`/api/batch-runs/${BATCH_RUN.id}/pause`), () =>
        HttpResponse.json(pausedRun),
      ),
      http.post(apiUrl(`/api/batch-runs/${BATCH_RUN.id}/resume`), () =>
        HttpResponse.json(BATCH_RUN),
      ),
    );

    const paused = renderHookWithProviders(() =>
      usePauseBatchRun({
        projectId: "proj",
        workflowName: "importContacts",
      }),
    );
    const resumed = renderHookWithProviders(() =>
      useResumeBatchRun({
        projectId: "proj",
        workflowName: "importContacts",
      }),
    );

    expect(
      (
        await paused.result.current.mutateAsync({
          batchRunId: BATCH_RUN.id,
        })
      ).status,
    ).toBe("paused");
    expect(
      (
        await resumed.result.current.mutateAsync({
          batchRunId: BATCH_RUN.id,
        })
      ).status,
    ).toBe("running");
  });

  it("retries failed batch items", async () => {
    server.use(
      http.post(apiUrl(`/api/batch-runs/${BATCH_RUN.id}/retry-failed`), () =>
        HttpResponse.json(BATCH_RUN),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useRetryFailedBatchItems({
        projectId: "proj",
        workflowName: "importContacts",
      }),
    );
    const retried = await result.current.mutateAsync({
      batchRunId: BATCH_RUN.id,
    });
    expect(retried.id).toBe(BATCH_RUN.id);
  });
});
