import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { listLocalPullRequests } from "./github-cli.js";

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  run: vi.fn(),
  viewer: vi.fn(),
  prs: vi.fn(),
}));
vi.mock("@catamorphic/git", () => ({ nativeGit: mocks.git }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.run }),
}));
vi.mock("@catamorphic/github", async (original) => ({
  ...(await original<typeof import("@catamorphic/github")>()),
  GithubApi: class {
    getUser = mocks.viewer;
    listPullRequests = mocks.prs;
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.git.mockResolvedValue("https://github.com/example/project.git\n");
  mocks.run.mockResolvedValue({ stdout: "test-token\n" });
  mocks.viewer.mockResolvedValue({ login: "reviewer" });
  mocks.prs.mockResolvedValue([]);
});

it("returns disconnected without reading a folder, token, or network", async () => {
  const resolveRoot = vi.fn();
  await expect(
    listLocalPullRequests({ enabled: false, resolveRoot }),
  ).resolves.toMatchObject({
    status: "unavailable",
    reason: "connection-disabled",
  });
  expect(resolveRoot).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.viewer).not.toHaveBeenCalled();
});
it.each([null, "git@gitlab.com:example/project.git"])(
  "does not ask for authentication when a GitHub remote is absent (%s)",
  async (remote) => {
    if (remote) mocks.git.mockResolvedValue(remote);
    else mocks.git.mockRejectedValue(new Error("not a git repository"));
    await expect(
      listLocalPullRequests({
        enabled: true,
        resolveRoot: async () => "/project",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "no-github-remote",
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.viewer).not.toHaveBeenCalled();
  },
);
it("distinguishes signed-out from an empty PR inbox", async () => {
  mocks.run.mockRejectedValue(new Error("not authenticated"));
  await expect(
    listLocalPullRequests({
      enabled: true,
      resolveRoot: async () => "/project",
    }),
  ).resolves.toMatchObject({
    status: "unavailable",
    reason: "sign-in-required",
  });
  expect(mocks.prs).not.toHaveBeenCalled();
});
it("returns the viewer with successful PR results", async () => {
  mocks.prs.mockResolvedValue([{ number: 3, title: "Review" }]);
  await expect(
    listLocalPullRequests({
      enabled: true,
      resolveRoot: async () => "/project",
    }),
  ).resolves.toEqual({
    status: "ready",
    items: [{ number: 3, title: "Review", viewerLogin: "reviewer" }],
  });
  expect(mocks.prs).toHaveBeenCalledWith("example/project");
});
it("keeps real request failures visible instead of reporting an empty inbox", async () => {
  mocks.prs.mockRejectedValue(new Error("Network unavailable"));
  await expect(
    listLocalPullRequests({
      enabled: true,
      resolveRoot: async () => "/project",
    }),
  ).rejects.toThrow("Network unavailable");
});
