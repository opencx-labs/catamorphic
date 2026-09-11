// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { PrsNav } from "./prs-nav.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    getPrefs: vi.fn().mockResolvedValue({}),
    onPrefsChanged: vi.fn(() => () => {}),
    onGithubConnected: vi.fn(() => () => {}),
    githubConnectStart: vi.fn().mockResolvedValue({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    }),
    prList: vi.fn(),
    prFiles: vi.fn(),
    onGitChanged: vi.fn(() => () => {}),
  },
}));
it("opens a PR review directly without fetching or expanding its files", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(desktopApi.prList).mockResolvedValue([
    {
      number: 3,
      title: "Review",
      url: "https://example.test/pr/3",
      author: "test",
      viewerLogin: "reviewer",
      requestedReviewers: ["reviewer"],
      head: "feature",
      base: "main",
      draft: false,
      updatedAt: "1",
    },
  ]);
  const node = document.createElement("div");
  const root = createRoot(node);
  const open = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PrsNav projectId="p" onOpenDiff={open} onOpenUrl={() => {}} />,
      ),
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>("[data-tree-primary]")?.click(),
    );
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      name: "review:3",
      source: { type: "review", prNumber: 3 },
    });
    expect(desktopApi.prFiles).not.toHaveBeenCalled();
    expect(node.textContent).not.toContain("Open review guide");
  } finally {
    await act(async () => root.unmount());
  }
});

it("opens connection settings without starting the separate GitHub flow", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(desktopApi.prList).mockRejectedValue(
    new Error("[github-cli-required] Sign in with gh auth login"),
  );
  const open = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <PrsNav
          projectId="existing-project"
          onOpenDiff={open}
          onOpenUrl={() => {}}
        />,
      ),
    );
    expect(node.textContent).toContain(
      "Choose the optional GitHub CLI connection in Settings",
    );
    expect(node.textContent).not.toContain("GithubNotConnectedError");
    await act(async () =>
      node.querySelector<HTMLButtonElement>("button")?.click(),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "settings",
        destination: expect.objectContaining({ id: "connections" }),
      }),
    );
    expect(desktopApi.githubConnectStart).not.toHaveBeenCalled();
    vi.mocked(desktopApi.prList).mockResolvedValue([]);
    await act(async () =>
      [...node.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Retry after signing in")
        ?.click(),
    );
    expect(desktopApi.prList).toHaveBeenLastCalledWith("existing-project");
    expect(node.textContent).toContain("No open pull requests.");
  } finally {
    await act(async () => root.unmount());
  }
});
