// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { PrsNav } from "./prs-nav.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    prList: vi.fn(),
    prFiles: vi.fn(),
    onGitChanged: vi.fn(() => () => {}),
  },
}));
vi.mock("./sidebar-item-row.js", () => ({ MenuPortal: () => null }));
it("refreshes expanded PR patches and reports errors instead of claiming there are no files", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const pr = {
    number: 3,
    title: "Review",
    url: "https://example.test/pr/3",
    author: "test",
    head: "feature",
    base: "trunk",
    draft: false,
    updatedAt: "1",
  };
  vi.mocked(desktopApi.prList).mockResolvedValue([pr]);
  vi.mocked(desktopApi.prFiles).mockResolvedValue([
    {
      path: "notes.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "+first",
    },
  ]);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const open = vi.fn();
  const empty = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PrsNav
          projectId="p"
          onOpenDiff={open}
          onOpenUrl={() => {}}
          onEmptyChange={empty}
        />,
      ),
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click(),
    );
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("notes.txt"))!
        .click(),
    );
    expect(open.mock.calls[0]?.[0].source.patch).toBe("+first");
    vi.mocked(desktopApi.prList).mockResolvedValue([{ ...pr, updatedAt: "2" }]);
    vi.mocked(desktopApi.prFiles).mockRejectedValue(
      new Error("Permission denied"),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "Permission denied",
    );
    expect(node.textContent).not.toContain("No files.");
    vi.mocked(desktopApi.prList).mockRejectedValue(new Error("Sign in again"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "Sign in again",
    );
    expect(empty).toHaveBeenLastCalledWith(false);
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
