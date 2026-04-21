import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CatamorphicError } from "../../lib/errors.js";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useCancelWorkflowRun } from "../use-cancel-workflow-run.js";
import { useTriggerWorkflowRun } from "../use-trigger-workflow-run.js";
import { useWorkflowRun } from "../use-workflow-run.js";
import { useWorkflowRuns } from "../use-workflow-runs.js";

const RUN_BASE = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-0000000000aa",
  workflowName: "sample",
  commitSha: "abc",
  isTest: false,
  status: "completed" as const,
  triggerData: null,
  result: null,
  error: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("useWorkflowRuns", () => {
  it("returns runs list on happy path", async () => {
    server.use(
      http.get(apiUrl("/api/projects/proj/workflows/sample/runs"), () =>
        HttpResponse.json({ items: [RUN_BASE], total: 1 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useWorkflowRuns("proj", "sample"),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(1);
  });

  it("maps 503 into sandbox_unavailable", async () => {
    server.use(
      http.get(apiUrl("/api/projects/proj/workflows/sample/runs"), () =>
        HttpResponse.json({ error: "sandbox down" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useWorkflowRuns("proj", "sample"),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(CatamorphicError);
    expect(result.current.error?.code).toBe("sandbox_unavailable");
  });
});

describe("useWorkflowRun", () => {
  it("returns a run detail on happy path", async () => {
    server.use(
      http.get(apiUrl("/api/runs/run-1"), () =>
        HttpResponse.json({ ...RUN_BASE, id: "run-1", steps: [] }),
      ),
    );
    const { result } = renderHookWithProviders(() => useWorkflowRun("run-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe("run-1");
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.get(apiUrl("/api/runs/missing"), () =>
        HttpResponse.json({ error: "gone" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useWorkflowRun("missing"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("not_found");
  });
});

describe("useTriggerWorkflowRun", () => {
  it("returns the newly created run", async () => {
    server.use(
      http.post(apiUrl("/api/projects/proj/workflows/sample/runs"), () =>
        HttpResponse.json(
          { ...RUN_BASE, id: "new-run", status: "pending" },
          { status: 201 },
        ),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useTriggerWorkflowRun("proj", "sample"),
    );
    const run = await result.current.mutateAsync();
    expect(run.id).toBe("new-run");
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.post(apiUrl("/api/projects/proj/workflows/missing/runs"), () =>
        HttpResponse.json({ error: "nope" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useTriggerWorkflowRun("proj", "missing"),
    );
    await expect(result.current.mutateAsync()).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("useCancelWorkflowRun", () => {
  it("returns the cancelled run", async () => {
    server.use(
      http.post(apiUrl("/api/runs/run-1/cancel"), () =>
        HttpResponse.json({ ...RUN_BASE, id: "run-1", status: "cancelled" }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useCancelWorkflowRun("proj", "sample"),
    );
    const cancelled = await result.current.mutateAsync("run-1");
    expect(cancelled.status).toBe("cancelled");
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.post(apiUrl("/api/runs/missing/cancel"), () =>
        HttpResponse.json({ error: "gone" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useCancelWorkflowRun("proj", "sample"),
    );
    await expect(result.current.mutateAsync("missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
