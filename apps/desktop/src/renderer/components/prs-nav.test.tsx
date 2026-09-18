// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../shared/app-prefs.js";
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
    remoteStatus: vi.fn().mockResolvedValue(null),
    onGitChanged: vi.fn(() => () => {}),
  },
}));
it("opens a PR review directly without fetching or expanding its files", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(desktopApi.getPrefs).mockResolvedValue({
    ...DEFAULT_PREFS,
    githubCliEnabled: true,
  });
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
  vi.mocked(desktopApi.getPrefs).mockResolvedValue({
    ...DEFAULT_PREFS,
    githubCliEnabled: true,
  });
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
    expect(node.textContent).toContain("GitHub not connected");
    expect(node.textContent).toContain("Sign in to the GitHub CLI");
    expect(node.textContent).not.toContain("GithubNotConnectedError");
    expect(node.querySelectorAll("button")).toHaveLength(1);
    await act(async () =>
      node.querySelector<HTMLButtonElement>("button")?.click(),
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "settings",
        destination: expect.objectContaining({ id: "github-cli" }),
      }),
    );
    expect(desktopApi.githubConnectStart).not.toHaveBeenCalled();
    // Signing in happens outside the app, so returning to the window re-checks.
    const requests = vi.mocked(desktopApi.prList).mock.calls.length;
    vi.mocked(desktopApi.prList).mockResolvedValue([]);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(desktopApi.prList).toHaveBeenLastCalledWith("existing-project");
    expect(vi.mocked(desktopApi.prList).mock.calls.length).toBeGreaterThan(
      requests,
    );
    // Empty copy belongs to the section chrome; the connect card is gone.
    expect(node.textContent).not.toContain("GitHub not connected");
  } finally {
    await act(async () => root.unmount());
  }
});

it("never asks the main process while the GitHub CLI connection is off", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(desktopApi.getPrefs).mockResolvedValue({
    ...DEFAULT_PREFS,
    githubCliEnabled: false,
  });
  vi.mocked(desktopApi.prList).mockClear();
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <PrsNav projectId="p" onOpenDiff={() => {}} onOpenUrl={() => {}} />,
      ),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(desktopApi.prList).not.toHaveBeenCalled();
    expect(node.textContent).toContain("Connect the GitHub CLI");
  } finally {
    await act(async () => root.unmount());
  }
});

it("lists a company project's proposals with the GitHub CLI connection off", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(desktopApi.getPrefs).mockResolvedValue({
    ...DEFAULT_PREFS,
    githubCliEnabled: false,
  });
  vi.mocked(desktopApi.remoteStatus).mockResolvedValueOnce({
    capabilities: {},
  } as never);
  vi.mocked(desktopApi.prList).mockClear();
  vi.mocked(desktopApi.prList).mockResolvedValue([
    {
      number: 7,
      title: "Proposal",
      url: "https://example.test/pr/7",
      author: "member",
      head: "feature",
      base: "main",
      draft: false,
      updatedAt: "1",
    },
  ]);
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <PrsNav
          projectId="remote"
          onOpenDiff={() => {}}
          onOpenUrl={() => {}}
        />,
      ),
    );
    expect(desktopApi.prList).toHaveBeenCalledWith("remote");
    expect(node.textContent).toContain("Proposal");
    expect(node.textContent).not.toContain("GitHub not connected");
  } finally {
    await act(async () => root.unmount());
  }
});
