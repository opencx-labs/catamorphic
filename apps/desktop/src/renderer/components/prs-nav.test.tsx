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
    remoteStatus: vi.fn().mockResolvedValue(null),
    onGitChanged: vi.fn(() => () => {}),
  },
}));
it("opens a PR review directly without fetching or expanding its files", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(desktopApi.prList).mockResolvedValue({
    status: "ready",
    items: [
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
    ],
  });
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
  vi.mocked(desktopApi.prList).mockResolvedValue({
    status: "unavailable",
    reason: "sign-in-required",
    message: "Sign in with gh auth login, then try again.",
  });
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
    expect(node.textContent).toContain("Sign in with gh auth login");
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
    vi.mocked(desktopApi.prList).mockResolvedValue({
      status: "ready",
      items: [],
    });
    await act(async () =>
      [...node.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Retry")
        ?.click(),
    );
    expect(desktopApi.prList).toHaveBeenLastCalledWith("existing-project");
    expect(node.textContent).toContain("No open pull requests.");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not poll or refresh on focus while a connection is unavailable", async () => {
  vi.useFakeTimers();
  vi.mocked(desktopApi.prList).mockClear().mockResolvedValue({
    status: "unavailable",
    reason: "connection-disabled",
    message: "Connect GitHub CLI in Settings to see pull requests.",
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <PrsNav projectId="plain" onOpenDiff={() => {}} onOpenUrl={() => {}} />,
      ),
    );
    const requests = vi.mocked(desktopApi.prList).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(desktopApi.prList).toHaveBeenCalledTimes(requests);
    expect(node.querySelector('[role="alert"]')).toBeNull();
    vi.mocked(desktopApi.prList).mockRejectedValue(
      new Error("Network unavailable"),
    );
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")
        ?.click(),
    );
    expect(node.querySelector('[role="alert"]')?.textContent).toBe(
      "Network unavailable",
    );
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
