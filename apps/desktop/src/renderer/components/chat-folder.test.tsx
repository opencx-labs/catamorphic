import { describe, expect, it, vi } from "vitest";
import type { SessionCheckoutDetail } from "../lib/desktop-api.js";
import { chatFolderView } from "./chat-folder.js";

vi.mock("../lib/desktop-api.js", () => ({ desktopApi: {} }));

const detail = (
  patch: Partial<SessionCheckoutDetail>,
): SessionCheckoutDetail => ({
  kind: "primary",
  path: "/work/project",
  branch: null,
  present: true,
  projectFolder: "/work/project",
  worktreesAvailable: true,
  changedFiles: null,
  ...patch,
});

const actions = (view: ReturnType<typeof chatFolderView>) =>
  view.actions.map((action) => action.label);

describe("chatFolderView (ADR 0215)", () => {
  it("offers a worktree to a new chat only in a project that can start one", () => {
    const view = chatFolderView({
      started: false,
      detail: undefined,
      draftWorktree: false,
      worktreesAvailable: true,
    });
    expect(view).toMatchObject({ kind: "primary", value: "Project folder" });
    expect(actions(view)).toEqual(["Use own worktree"]);
    expect(
      actions(
        chatFolderView({
          started: false,
          detail: undefined,
          draftWorktree: false,
          worktreesAvailable: false,
        }),
      ),
    ).toEqual([]);
  });

  it("says a new chat's worktree comes with its first message", () => {
    const view = chatFolderView({
      started: false,
      detail: undefined,
      draftWorktree: true,
      worktreesAvailable: true,
    });
    expect(view).toMatchObject({
      kind: "managed",
      value: "Own worktree",
      tag: "with the first message",
    });
    expect(actions(view)).toEqual(["Use project folder"]);
  });

  it("names a checked-out worktree by its branch, folder and changes", () => {
    const view = chatFolderView({
      started: true,
      detail: detail({
        kind: "managed",
        path: "/data/worktrees/p/s/project",
        branch: "work/abc",
        changedFiles: 3,
      }),
      draftWorktree: false,
      worktreesAvailable: true,
    });
    expect(view.value).toBe("work/abc");
    expect(view.tag).toBeUndefined();
    expect(view.lines).toEqual([
      "/data/worktrees/p/s/project",
      "3 changed files",
    ]);
    expect(actions(view)).toEqual(["Bring to project folder", "Discard"]);
  });

  it("moves a worktree with nothing to bring straight back", () => {
    const view = chatFolderView({
      started: true,
      detail: detail({
        kind: "managed",
        branch: "work/abc",
        present: false,
        changedFiles: 0,
      }),
      draftWorktree: false,
      worktreesAvailable: true,
    });
    expect(view).toMatchObject({ tag: "put away" });
    expect(view.lines).toEqual([
      "Checked out again with the next message.",
      "No changes yet",
    ]);
    expect(view.actions).toEqual([
      { id: "bring", label: "Use project folder" },
    ]);
  });

  it("lets a chosen worktree be unchosen before it is checked out", () => {
    const view = chatFolderView({
      started: true,
      detail: detail({ kind: "managed", branch: null, present: false }),
      draftWorktree: false,
      worktreesAvailable: true,
    });
    expect(view).toMatchObject({ tag: "with the next message" });
    expect(view.actions).toEqual([
      { id: "project-folder", label: "Use project folder" },
    ]);
  });

  it("returns from a worktree the chat was assigned without touching it", () => {
    const view = chatFolderView({
      started: true,
      detail: detail({
        kind: "external",
        path: "/elsewhere",
        branch: "feature",
      }),
      draftWorktree: false,
      worktreesAvailable: true,
    });
    expect(view).toMatchObject({
      value: "External worktree",
      tag: "feature",
      lines: ["/elsewhere"],
    });
    expect(view.actions).toEqual([
      { id: "project-folder", label: "Use project folder" },
    ]);
  });
});
