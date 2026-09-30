import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CatamorphicError } from "../../lib/errors.js";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { workflowKeys } from "../../workflow-keys.js";
import { useCommitChanges } from "../use-commit-changes.js";
import { useDeployProject } from "../use-deploy-project.js";
import { useProjectCommits } from "../use-project-commits.js";
import { useProjectGit } from "../use-project-git.js";

const STATUS = {
  branch: "main",
  dirty: false,
  modifiedFiles: [],
  ahead: 0,
  behind: 0,
  baseCommit: "abc",
  remoteHead: "abc",
  remoteHeadTimestamp: 123,
};

function seedWorkflowQueries(queryClient: QueryClient) {
  const listKey = workflowKeys.list({ projectId: "p1", ref: undefined });
  const detailKey = workflowKeys.detail({
    projectId: "p1",
    name: "sample",
    ref: undefined,
  });
  queryClient.setQueryData(listKey, []);
  queryClient.setQueryData(detailKey, { name: "sample" });
  return { listKey, detailKey };
}

describe("useProjectGit", () => {
  it("returns the status on happy path", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/status"), () =>
        HttpResponse.json(STATUS),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useProjectGit("p1", { refetchInterval: false }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.branch).toBe("main");
  });

  it("maps 503 to sandbox_unavailable", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/status"), () =>
        HttpResponse.json({ error: "down" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useProjectGit("p1", { refetchInterval: false }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(CatamorphicError);
    expect(result.current.error?.code).toBe("sandbox_unavailable");
  });
});

describe("useProjectCommits", () => {
  it("returns commits list", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/commits"), () =>
        HttpResponse.json({
          items: [
            {
              sha: "abc",
              message: "m",
              author: { name: "a", email: "b" },
              timestamp: 1,
            },
          ],
          total: 1,
        }),
      ),
    );
    const { result } = renderHookWithProviders(() => useProjectCommits("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.total).toBe(1);
  });

  it("maps errors to CatamorphicError", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/commits"), () =>
        HttpResponse.json({ error: "fail" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useProjectCommits("p1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("sandbox_unavailable");
  });
});

describe("useCommitChanges / useDeployProject", () => {
  it("commits on happy path", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/deploy"), () =>
        HttpResponse.json({
          status: "deployed",
          commitSha: "abc",
          remoteSha: "abc",
          conflicts: [],
        }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useCommitChanges("p1"),
    );
    const keys = seedWorkflowQueries(queryClient);
    const out = await result.current.mutateAsync({ message: "x" });
    expect(out.status).toBe("deployed");
    expect(queryClient.getQueryState(keys.listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(keys.detailKey)?.isInvalidated).toBe(true);
  });

  it("deploys on happy path", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/deploy"), () =>
        HttpResponse.json({
          status: "deployed",
          commitSha: "abc",
          remoteSha: "abc",
          conflicts: [],
        }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useDeployProject("p1"),
    );
    const keys = seedWorkflowQueries(queryClient);
    const out = await result.current.mutateAsync();
    expect(out.status).toBe("deployed");
    expect(queryClient.getQueryState(keys.listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(keys.detailKey)?.isInvalidated).toBe(true);
  });

  it("maps server errors", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/deploy"), () =>
        HttpResponse.json({ error: "boom" }, { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useDeployProject("p1"));
    await expect(result.current.mutateAsync()).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });
});
