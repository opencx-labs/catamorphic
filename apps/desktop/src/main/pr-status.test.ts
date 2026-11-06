import {
  CodeHostNotConnectedError,
  type PullRequestStatus,
} from "@catamorphic/core";
import { GithubApiError } from "@catamorphic/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullRequestAddress, readPullRequestStatus } from "./pr-status.js";

const URL_42 = "https://github.com/acme/web/pull/42";

const STATUS: PullRequestStatus = {
  number: 42,
  title: "Chips",
  url: URL_42,
  repository: "acme/web",
  author: "octo",
  head: "work/chips",
  base: "main",
  state: "open",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  comments: 1,
  updatedAt: "2026-10-16T09:00:00.000Z",
};

/** GitHub's REST answers for #42 as the CLI's token reads them. */
const GITHUB = {
  pull: {
    number: 42,
    title: "Chips",
    html_url: URL_42,
    user: { login: "octo" },
    head: { ref: "work/chips", sha: "abc" },
    base: { ref: "main" },
    state: "closed",
    merged: true,
    additions: 10,
    deletions: 2,
    changed_files: 3,
    comments: 1,
    review_comments: 0,
    updated_at: "2026-10-16T09:00:00.000Z",
  },
};

describe("readPullRequestStatus", () => {
  const requests: string[] = [];
  let answer: () => Response;
  beforeEach(() => {
    requests.length = 0;
    answer = () => Response.json(GITHUB.pull);
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(url);
      return answer();
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const read = (input: {
    viaConnection: (url: string) => Promise<PullRequestStatus | null>;
    cliEnabled: boolean;
    url?: string;
  }) =>
    readPullRequestStatus({
      url: input.url ?? URL_42,
      viaConnection: input.viaConnection,
      cliEnabled: input.cliEnabled,
      cliToken: async () => "cli-token",
    });

  it("reads through the person's connection first", async () => {
    expect(
      await read({ viaConnection: async () => STATUS, cliEnabled: true }),
    ).toEqual({ status: STATUS, source: "connection" });
    expect(requests).toEqual([]);
  });

  it("falls back to the CLI when the connection cannot read it", async () => {
    for (const denied of [
      new CodeHostNotConnectedError("github"),
      new GithubApiError(404, "Not Found"),
      new GithubApiError(403, "Forbidden"),
    ]) {
      const status = await read({
        viaConnection: () => Promise.reject(denied),
        cliEnabled: true,
      });
      expect(status, denied.message).toMatchObject({
        status: { number: 42, state: "merged", repository: "acme/web" },
        source: "github-cli",
      });
    }
    expect(requests[0]).toBe("https://api.github.com/repos/acme/web/pulls/42");
  });

  it("reads public status without enabling or consulting the CLI", async () => {
    const cliToken = vi.fn();
    const anonymous = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      return Response.json({ ...GITHUB.pull, state: "open", merged: false });
    });
    vi.stubGlobal("fetch", anonymous);
    expect(
      await readPullRequestStatus({
        url: URL_42,
        viaConnection: async () => null,
        cliEnabled: false,
        cliToken,
      }),
    ).toMatchObject({ status: { state: "open" }, source: "public" });
    expect(cliToken).not.toHaveBeenCalled();
    expect(anonymous).toHaveBeenCalledTimes(1);
  });

  it("shows what the chat recorded when public data is unavailable", async () => {
    const none = async () => null;
    expect(
      await read({ viaConnection: none, cliEnabled: false }),
    ).toMatchObject({ status: { state: "merged" }, source: "public" });
    expect(
      await read({
        viaConnection: none,
        cliEnabled: true,
        url: "https://gitlab.com/acme/web/-/merge_requests/42",
      }),
    ).toMatchObject({ status: null });
    answer = () => Response.json({ message: "Not Found" }, { status: 404 });
    expect(await read({ viaConnection: none, cliEnabled: true })).toMatchObject(
      { status: null },
    );
    expect(
      await readPullRequestStatus({
        url: URL_42,
        viaConnection: none,
        cliEnabled: true,
        cliToken: async () => null,
      }),
    ).toMatchObject({ status: null });
  });

  it("keeps a failure worth retrying", async () => {
    const failure = new GithubApiError(502, "Bad Gateway");
    await expect(
      read({ viaConnection: () => Promise.reject(failure), cliEnabled: true }),
    ).rejects.toBe(failure);
    answer = () => Response.json({ message: "Down" }, { status: 503 });
    await expect(
      read({ viaConnection: async () => null, cliEnabled: true }),
    ).rejects.toMatchObject({ status: 503 });
    answer = () =>
      Response.json({ message: "API rate limit exceeded" }, { status: 403 });
    await expect(
      read({ viaConnection: async () => null, cliEnabled: false }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("pullRequestAddress", () => {
  it("takes a web address and nothing else", () => {
    expect(pullRequestAddress(URL_42)).toBe(URL_42);
    for (const raw of [
      42,
      "acme/web#42",
      "file:///etc/passwd",
      "https://github.com",
      `https://github.com/${"a".repeat(2100)}`,
    ])
      expect(() => pullRequestAddress(raw), String(raw)).toThrow("web address");
  });
});
