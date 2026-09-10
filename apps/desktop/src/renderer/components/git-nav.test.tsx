// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { desktopApi, type GitOverview } from "../lib/desktop-api.js";
import { GitNav } from "./git-nav.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    getPrefs: vi.fn().mockResolvedValue({}),
    onPrefsChanged: vi.fn(() => () => {}),
    sessionCheckouts: vi.fn().mockResolvedValue([]),
    gitOverview: vi.fn(),
    onGitChanged: vi.fn(() => () => {}),
  },
}));
afterEach(() => vi.clearAllMocks());
const overview: GitOverview = {
  available: true,
  worktrees: [
    {
      path: "/project",
      branch: "trunk",
      isMain: true,
      isCurrent: true,
      changes: [
        { path: "same.txt", kind: "modified", mode: "staged" },
        { path: "same.txt", kind: "modified", mode: "unstaged" },
      ],
      branchChanges: [],
    },
    {
      path: "/other/project",
      branch: "feature",
      isMain: false,
      isCurrent: false,
      baseRef: "refs/heads/trunk",
      baseLabel: "trunk",
      changes: [],
      branchChanges: [
        {
          path: "same.txt",
          previousPath: "old.txt",
          kind: "renamed",
          mode: "branch",
        },
      ],
    },
  ],
};
it("renders collapsible worktrees, keeps diff identities separate, and passes the real base and rename path", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(desktopApi.gitOverview).mockResolvedValue(overview);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const open = vi.fn();
  try {
    await act(async () =>
      root.render(<GitNav projectId="p" onOpenDiff={open} />),
    );
    const sections = node.querySelectorAll("[data-worktree-path]");
    expect(sections).toHaveLength(2);
    expect(node.textContent).toContain("Committed vs trunk");
    const rows = node.querySelectorAll<HTMLButtonElement>(
      "[data-change-group] button",
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) await act(async () => row.click());
    expect(new Set(open.mock.calls.map((call) => call[0].name)).size).toBe(3);
    expect(open.mock.calls[2]?.[0].source).toMatchObject({
      worktreePath: "/other/project",
      mode: "branch",
      previousPath: "old.txt",
      baseRef: "refs/heads/trunk",
    });
    const header = sections[1]!.querySelector<HTMLButtonElement>("h4 button")!;
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(
      document
        .getElementById(header.getAttribute("aria-controls")!)
        ?.querySelector("[data-collapsible]")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(header.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
it("keeps failures and clean multi-worktree sections visible", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  const empty = vi.fn();
  try {
    vi.mocked(desktopApi.gitOverview).mockResolvedValue({
      ...overview,
      worktrees: overview.worktrees.map((tree) => ({
        ...tree,
        changes: [],
        branchChanges: [],
      })),
    });
    await act(async () =>
      root.render(
        <GitNav projectId="p" onOpenDiff={() => {}} onEmptyChange={empty} />,
      ),
    );
    expect(empty).toHaveBeenLastCalledWith(false);
    expect(node.querySelectorAll("[data-worktree-path]")).toHaveLength(2);
    vi.mocked(desktopApi.gitOverview).mockRejectedValue(
      new Error("Checkout unavailable"),
    );
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      "Checkout unavailable",
    );
    expect(empty).toHaveBeenLastCalledWith(false);
  } finally {
    await act(async () => root.unmount());
  }
});
