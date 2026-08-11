import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import type { Run, RunDetail, RunItem } from "../../types.js";
import {
  runKeys,
  useCancelRun,
  usePauseRunProcessing,
  useResumeRunProcessing,
  useRun,
  useRunItemSteps,
  useRunItems,
  useRuns,
  useSubmitRunInput,
  useTriggerRun,
} from "../use-runs.js";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const PROJECT_ID = "00000000-0000-0000-0000-0000000000aa";
const ATTEMPT_ID = "00000000-0000-0000-0000-000000000002";
const ITEM_ID = "00000000-0000-0000-0000-000000000003";
const PAUSE_ID = "00000000-0000-0000-0000-000000000004";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    workflowName: "sample",
    correlationKey: null,
    capabilities: {
      cancel: true,
      pauseProcessing: true,
      resumeProcessing: false,
      submitInput: false,
      inspectItems: true,
    },
    status: "running",
    phase: "process",
    currentStepIndex: 0,
    activePause: null,
    batchScopes: [
      {
        workflowStepAttemptId: ATTEMPT_ID,
        stepIndex: 0,
        nodeId: "batch",
        attempt: 1,
        status: "running",
        estimated: 2,
        discovered: 2,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        sinkCompletedChunks: 0,
        sinkTotalChunks: 0,
        artifact: null,
      },
    ],
    provenance: { commitSha: "a".repeat(40) },
    artifact: { deploymentArtifactId: ATTEMPT_ID },
    initiatedBy: "user-1",
    input: { value: 1 },
    result: null,
    error: null,
    parentRunId: null,
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:01.000Z",
    startedAt: "2026-07-25T12:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<Run> = {}): RunDetail {
  return {
    ...makeRun(overrides),
    steps: [
      {
        id: "00000000-0000-0000-0000-000000000005",
        runId: RUN_ID,
        nodeId: "normalize",
        occurrence: 0,
        attempt: 1,
        name: "Normalize",
        status: "completed",
        input: null,
        output: null,
        error: null,
        startedAt: "2026-07-25T12:00:00.000Z",
        completedAt: "2026-07-25T12:00:01.000Z",
      },
    ],
    workflowStepAttempts: [
      {
        id: ATTEMPT_ID,
        runId: RUN_ID,
        stepIndex: 0,
        nodeId: "batch",
        executor: "batch",
        attempt: 1,
        status: "running",
        input: null,
        output: null,
        error: null,
        startedAt: "2026-07-25T12:00:00.000Z",
        completedAt: null,
      },
    ],
  };
}

const ITEM: RunItem = {
  id: ITEM_ID,
  runId: RUN_ID,
  workflowStepAttemptId: ATTEMPT_ID,
  key: "contact-1",
  sourceOrder: 0,
  status: "failed",
  value: { email: "invalid" },
  output: null,
  error: "Invalid email",
  currentNodeId: "normalize",
  attempt: 1,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:01.000Z",
  completedAt: "2026-07-25T12:00:01.000Z",
};

describe("unified run queries", () => {
  it("lists runs with unified filters and cache keys", async () => {
    server.use(
      http.get(
        apiUrl(`/api/projects/${PROJECT_ID}/workflows/sample/runs`),
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("limit")).toBe("10");
          expect(url.searchParams.get("offset")).toBe("20");
          return HttpResponse.json({ items: [makeRun()], total: 1 });
        },
      ),
    );

    const options = {
      projectId: PROJECT_ID,
      workflowName: "sample",
      limit: 10,
      offset: 20,
      pollInterval: false as const,
    };
    const { result, queryClient } = renderHookWithProviders(() =>
      useRuns(options),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(1);
    expect(
      queryClient.getQueryData(
        runKeys.list({
          projectId: options.projectId,
          workflowName: options.workflowName,
          limit: options.limit,
          offset: options.offset,
        }),
      ),
    ).toEqual(result.current.data);
  });

  it("gets unified run detail", async () => {
    server.use(
      http.get(apiUrl(`/api/runs/${RUN_ID}`), () =>
        HttpResponse.json(makeDetail()),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useRun({ runId: RUN_ID, pollInterval: false }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.workflowStepAttempts[0]?.id).toBe(ATTEMPT_ID);
  });

  it("polls active and child-waiting runs only", async () => {
    let runningRequests = 0;
    let childRequests = 0;
    let pauseRequests = 0;
    server.use(
      http.get(apiUrl("/api/runs/running"), () => {
        runningRequests += 1;
        return HttpResponse.json(makeDetail({ id: "running" }));
      }),
      http.get(apiUrl("/api/runs/child"), () => {
        childRequests += 1;
        return HttpResponse.json(
          makeDetail({ id: "child", status: "waiting", phase: "child" }),
        );
      }),
      http.get(apiUrl("/api/runs/pause"), () => {
        pauseRequests += 1;
        return HttpResponse.json(
          makeDetail({ id: "pause", status: "waiting", phase: "pause" }),
        );
      }),
    );

    const running = renderHookWithProviders(() =>
      useRun({ runId: "running", pollInterval: 10 }),
    );
    const child = renderHookWithProviders(() =>
      useRun({ runId: "child", pollInterval: 10 }),
    );
    const pause = renderHookWithProviders(() =>
      useRun({ runId: "pause", pollInterval: 10 }),
    );

    await waitFor(() => expect(runningRequests).toBeGreaterThan(1));
    await waitFor(() => expect(childRequests).toBeGreaterThan(1));
    await waitFor(() => expect(pause.result.current.isSuccess).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pauseRequests).toBe(1);

    running.unmount();
    child.unmount();
    pause.unmount();
  });

  it("loads run-scoped items and item steps", async () => {
    server.use(
      http.get(
        apiUrl(`/api/runs/${RUN_ID}/steps/${ATTEMPT_ID}/items`),
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("status")).toBe("failed");
          expect(url.searchParams.get("limit")).toBe("25");
          expect(url.searchParams.get("offset")).toBe("50");
          return HttpResponse.json({ items: [ITEM], total: 1 });
        },
      ),
      http.get(
        apiUrl(
          `/api/runs/${RUN_ID}/steps/${ATTEMPT_ID}/items/${ITEM_ID}/steps`,
        ),
        () =>
          HttpResponse.json([
            {
              id: "00000000-0000-0000-0000-000000000006",
              itemId: ITEM_ID,
              nodeId: "normalize",
              occurrence: 0,
              attempt: 1,
              name: "Normalize",
              status: "failed",
              input: null,
              output: null,
              error: "Invalid email",
              startedAt: "2026-07-25T12:00:00.000Z",
              completedAt: "2026-07-25T12:00:01.000Z",
            },
          ]),
      ),
    );

    const items = renderHookWithProviders(() =>
      useRunItems({
        run: makeRun(),
        workflowStepAttemptId: ATTEMPT_ID,
        status: "failed",
        limit: 25,
        offset: 50,
        pollInterval: false,
      }),
    );
    const steps = renderHookWithProviders(() =>
      useRunItemSteps({
        run: makeRun(),
        workflowStepAttemptId: ATTEMPT_ID,
        itemId: ITEM_ID,
      }),
    );

    await waitFor(() => expect(items.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(steps.result.current.isSuccess).toBe(true));
    expect(items.result.current.data?.items[0]?.error).toBe("Invalid email");
    expect(steps.result.current.data?.[0]?.nodeId).toBe("normalize");
  });

  it("polls waiting items and selected item steps while processing is active", async () => {
    let itemRequests = 0;
    let stepRequests = 0;
    server.use(
      http.get(apiUrl(`/api/runs/${RUN_ID}/steps/${ATTEMPT_ID}/items`), () => {
        itemRequests += 1;
        return HttpResponse.json({
          items: [{ ...ITEM, status: "waiting" }],
          total: 1,
        });
      }),
      http.get(
        apiUrl(
          `/api/runs/${RUN_ID}/steps/${ATTEMPT_ID}/items/${ITEM_ID}/steps`,
        ),
        () => {
          stepRequests += 1;
          return HttpResponse.json([]);
        },
      ),
    );

    const items = renderHookWithProviders(() =>
      useRunItems({
        run: makeRun(),
        workflowStepAttemptId: ATTEMPT_ID,
        pollInterval: 10,
      }),
    );
    const steps = renderHookWithProviders(() =>
      useRunItemSteps({
        run: makeRun(),
        workflowStepAttemptId: ATTEMPT_ID,
        itemId: ITEM_ID,
        pollInterval: 10,
      }),
    );

    await waitFor(() => expect(itemRequests).toBeGreaterThan(1));
    await waitFor(() => expect(stepRequests).toBeGreaterThan(1));
    items.unmount();
    steps.unmount();
  });

  it("polls an empty Item page from the parent Run and scope state", async () => {
    let requests = 0;
    server.use(
      http.get(apiUrl(`/api/runs/${RUN_ID}/steps/${ATTEMPT_ID}/items`), () => {
        requests += 1;
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );

    const items = renderHookWithProviders(() =>
      useRunItems({
        run: makeRun(),
        workflowStepAttemptId: ATTEMPT_ID,
        pollInterval: 10,
      }),
    );

    await waitFor(() => expect(requests).toBeGreaterThan(1));
    items.unmount();
  });
});

describe("unified run mutations", () => {
  it("triggers runs through the canonical path", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(
        apiUrl(`/api/projects/${PROJECT_ID}/workflows/sample/runs`),
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json(makeRun({ status: "pending" }), {
            status: 201,
          });
        },
      ),
    );

    const trigger = renderHookWithProviders(() =>
      useTriggerRun({ projectId: PROJECT_ID, workflowName: "sample" }),
    );

    const run = await trigger.result.current.mutateAsync({
      input: { value: 1 },
    });
    expect(run.status).toBe("pending");
    expect(bodies).toEqual([{ input: { value: 1 } }]);
  });

  it("updates detail and list caches and invalidates run item hierarchies", async () => {
    const canceled = makeRun({ status: "canceled" });
    server.use(
      http.post(apiUrl(`/api/runs/${RUN_ID}/cancel`), () =>
        HttpResponse.json(canceled),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useCancelRun({ runId: RUN_ID }),
    );
    const listKey = runKeys.list({
      projectId: PROJECT_ID,
      workflowName: "sample",
      limit: undefined,
      offset: undefined,
    });
    const itemsKey = runKeys.itemList({
      runId: RUN_ID,
      workflowStepAttemptId: ATTEMPT_ID,
      status: undefined,
      limit: undefined,
      offset: undefined,
    });
    queryClient.setQueryData(runKeys.detail(RUN_ID), makeDetail());
    queryClient.setQueryData(listKey, { items: [makeRun()], total: 1 });
    queryClient.setQueryData(itemsKey, { items: [ITEM], total: 1 });

    await result.current.mutateAsync({ reason: "operator request" });

    expect(queryClient.getQueryData<RunDetail>(runKeys.detail(RUN_ID))).toEqual(
      expect.objectContaining({ status: "canceled", steps: expect.any(Array) }),
    );
    expect(
      queryClient.getQueryData<{ items: Run[] }>(listKey)?.items[0]?.status,
    ).toBe("canceled");
    expect(queryClient.getQueryState(itemsKey)?.isInvalidated).toBe(true);
  });

  it("pauses, resumes, and submits input with unified run controls", async () => {
    let submitted: unknown;
    server.use(
      http.post(apiUrl(`/api/runs/${RUN_ID}/pause`), () =>
        HttpResponse.json(makeRun({ status: "paused" })),
      ),
      http.post(apiUrl(`/api/runs/${RUN_ID}/resume`), () =>
        HttpResponse.json(makeRun()),
      ),
      http.post(
        apiUrl(`/api/runs/${RUN_ID}/pauses/${PAUSE_ID}/resume`),
        async ({ request }) => {
          submitted = await request.json();
          return HttpResponse.json(makeRun({ phase: "boundary" }));
        },
      ),
    );

    const pause = renderHookWithProviders(() =>
      usePauseRunProcessing({ runId: RUN_ID }),
    );
    const resume = renderHookWithProviders(() =>
      useResumeRunProcessing({ runId: RUN_ID }),
    );
    const submit = renderHookWithProviders(() =>
      useSubmitRunInput({ runId: RUN_ID, pauseId: PAUSE_ID }),
    );

    expect((await pause.result.current.mutateAsync()).status).toBe("paused");
    expect((await resume.result.current.mutateAsync()).status).toBe("running");
    await submit.result.current.mutateAsync({
      idempotencyKey: "approval-1",
      value: { approved: true },
    });
    expect(submitted).toEqual({
      idempotencyKey: "approval-1",
      value: { approved: true },
    });
  });
});
