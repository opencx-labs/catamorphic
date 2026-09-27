import { ConnectionUnavailableError } from "@catamorphic/core";
import { GithubApiError } from "@catamorphic/github";
import { describe, expect, it } from "vitest";
import { throughCodeHost } from "./code-host-fallback.js";

/** A code host whose pull request list answers with `result`. */
const fakeCodeHost = (result: () => Promise<string[]>) => ({
  listPullRequests: result,
});

const list = (input: {
  codeHosts: ReturnType<typeof fakeCodeHost> | null;
  cliEnabled: boolean;
}) =>
  throughCodeHost({
    ...input,
    run: (codeHosts) => codeHosts.listPullRequests(),
  });

describe("throughCodeHost", () => {
  it("answers through the person's connection when it reaches the repository", async () => {
    const codeHosts = fakeCodeHost(async () => ["#1"]);
    expect(await list({ codeHosts, cliEnabled: true })).toEqual({
      value: ["#1"],
    });
  });

  it("falls through to the CLI without a connection", async () => {
    expect(await list({ codeHosts: null, cliEnabled: false })).toBeNull();
  });

  it("falls through to the CLI when the connection cannot reach the repository", async () => {
    for (const denied of [
      new GithubApiError(404, "Not Found"),
      new GithubApiError(403, "Resource not accessible by integration"),
      new GithubApiError(401, "Bad credentials"),
      new ConnectionUnavailableError("github", "Connection expired"),
    ]) {
      const codeHosts = fakeCodeHost(() => Promise.reject(denied));
      expect(await list({ codeHosts, cliEnabled: true }), denied.message).toBe(
        null,
      );
      // With the CLI off, the person sees why the connection failed.
      await expect(list({ codeHosts, cliEnabled: false })).rejects.toBe(denied);
    }
  });

  it("keeps other failures", async () => {
    const failure = new GithubApiError(422, "Pull request is not mergeable");
    const codeHosts = fakeCodeHost(() => Promise.reject(failure));
    await expect(list({ codeHosts, cliEnabled: true })).rejects.toBe(failure);
  });
});
