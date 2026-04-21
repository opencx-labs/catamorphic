import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CatamorphicError } from "../../lib/errors.js";
import { apiUrl, HttpResponse, http } from "../../test/handlers.js";
import { renderHookWithProviders } from "../../test/render.js";
import { server } from "../../test/server.js";
import { useCheckoutBranch } from "../use-checkout-branch.js";
import { useCommitChanges } from "../use-commit-changes.js";
import { useCreateBranch } from "../use-create-branch.js";
import { useDeployProject } from "../use-deploy-project.js";
import { useProjectBranches } from "../use-project-branches.js";
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

describe("useProjectBranches", () => {
  it("returns branches on happy path", async () => {
    server.use(
      http.get(apiUrl("/api/projects/p1/branches"), () =>
        HttpResponse.json([
          {
            name: "main",
            commit: "abc",
            isCurrent: true,
            createdAt: null,
          },
        ]),
      ),
    );
    const { result } = renderHookWithProviders(() => useProjectBranches("p1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.name).toBe("main");
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.get(apiUrl("/api/projects/missing/branches"), () =>
        HttpResponse.json({ error: "gone" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useProjectBranches("missing"),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("not_found");
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

describe("useCreateBranch", () => {
  it("creates the branch", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/branches"), () =>
        HttpResponse.json({ branch: "dev", created: true }),
      ),
    );
    const { result } = renderHookWithProviders(() => useCreateBranch("p1"));
    const created = await result.current.mutateAsync({ name: "dev" });
    expect(created.branch).toBe("dev");
  });

  it("maps 404 to not_found", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/branches"), () =>
        HttpResponse.json({ error: "x" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useCreateBranch("p1"));
    await expect(result.current.mutateAsync()).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("useCheckoutBranch", () => {
  it("checks out a branch", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/checkout"), () =>
        HttpResponse.json({ ...STATUS, branch: "dev" }),
      ),
    );
    const { result } = renderHookWithProviders(() => useCheckoutBranch("p1"));
    const status = await result.current.mutateAsync("dev");
    expect(status.branch).toBe("dev");
  });

  it("maps errors", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/checkout"), () =>
        HttpResponse.json({ error: "nope" }, { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useCheckoutBranch("p1"));
    await expect(result.current.mutateAsync("dev")).rejects.toMatchObject({
      code: "not_found",
    });
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
    const { result } = renderHookWithProviders(() => useCommitChanges("p1"));
    const out = await result.current.mutateAsync({ message: "x" });
    expect(out.status).toBe("deployed");
  });

  it("deploys on happy path", async () => {
    server.use(
      http.post(apiUrl("/api/projects/p1/deploy"), () =>
        HttpResponse.json({
          status: "nothing-to-deploy",
          commitSha: null,
          remoteSha: null,
          conflicts: [],
        }),
      ),
    );
    const { result } = renderHookWithProviders(() => useDeployProject("p1"));
    const out = await result.current.mutateAsync();
    expect(out.status).toBe("nothing-to-deploy");
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
