import { describe, expect, it } from "vitest";
import { GithubApi, gitCredentialsFor } from "../api.js";
import { GithubApiError } from "../types.js";

const REPO = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  full_name: "octo/hello",
  name: "hello",
  owner: { login: "octo" },
  private: false,
  default_branch: "main",
  clone_url: "https://github.com/octo/hello.git",
  description: null,
  pushed_at: "2026-07-01T00:00:00Z",
  ...over,
});

function fetchRouting(routes: Record<string, unknown>) {
  return (async (url: unknown) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    for (const [prefix, payload] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
    });
  }) as typeof fetch;
}

describe("GithubApi", () => {
  it("maps the authenticated user", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/user": { login: "octo", id: 7, avatar_url: "a", name: "Octo" },
      }),
    });
    expect(await api.getUser()).toEqual({
      login: "octo",
      id: 7,
      avatarUrl: "a",
      name: "Octo",
    });
  });

  it("lists the authenticated user's repos sorted by pushed_at", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/user/repos": [
          REPO({ id: 1, pushed_at: "2026-01-01T00:00:00Z" }),
          REPO({
            id: 2,
            full_name: "org/newer",
            pushed_at: "2026-06-01T00:00:00Z",
          }),
        ],
      }),
    });
    const repos = await api.listAccessibleRepos();
    expect(repos.map((r) => r.id)).toEqual([2, 1]);
    expect(repos[1]?.cloneUrl).toBe("https://github.com/octo/hello.git");
  });

  it("throws GithubApiError with status on failures", async () => {
    const api = new GithubApi("tok", { fetch: fetchRouting({}) });
    await expect(api.getUser()).rejects.toMatchObject({ status: 404 });
    await expect(api.getUser()).rejects.toThrow(GithubApiError);
  });
});

describe("gitCredentialsFor", () => {
  it("uses the x-access-token username convention", () => {
    expect(gitCredentialsFor("ghu_abc")).toEqual({
      username: "x-access-token",
      password: "ghu_abc",
    });
  });
});
