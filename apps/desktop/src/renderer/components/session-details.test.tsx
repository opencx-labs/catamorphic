// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarSectionConfig } from "../../shared/sidebar.js";
import { desktopApi, type SessionCheckoutDetail } from "../lib/desktop-api.js";
import { SessionDetails, sessionPullRequests } from "./session-details.js";
import {
  SidebarContribution,
  type SidebarStatus,
} from "./sidebar-contribution.js";

const session = vi.hoisted(() => ({
  fields: null as { metadata: Record<string, unknown> } | null,
  isLoading: false,
  error: null as Error | null,
  asked: [] as Array<string | undefined>,
}));
const checkout = vi.hoisted(() => ({
  data: undefined as SessionCheckoutDetail | undefined,
  remote: false,
}));

vi.mock("@catamorphic/react", () => ({
  useAgentSessionFields: (_projectId: string, sessionId?: string) => {
    session.asked.push(sessionId);
    return {
      fields: session.fields,
      isLoading: session.isLoading,
      error: session.error,
      refetch: async () => undefined,
    };
  },
}));
vi.mock("../lib/use-session-checkout.js", () => ({
  useSessionCheckout: () => ({
    data: checkout.data,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: async () => undefined,
  }),
}));
vi.mock("./project-authority-provider.js", () => ({
  useRemoteProject: () => checkout.remote,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { revealFolder: vi.fn(async () => {}) },
}));

const section: SidebarSectionConfig = {
  id: "session",
  type: "session",
  when: { surface: ["chat"], session: true },
};
const worktree: SessionCheckoutDetail = {
  kind: "managed",
  path: "/data/worktrees/project/s1/project",
  branch: "work/s1",
  present: true,
  available: true,
  projectFolder: "/work/project",
  worktreesAvailable: true,
  changedFiles: 3,
};
const pullRequests = [
  {
    url: "https://github.com/acme/web/pull/42",
    number: 42,
    title: "Session metadata",
    state: "merged",
  },
  { url: "https://github.com/acme/web/pull/43", number: 43 },
];

afterEach(() => {
  session.fields = null;
  session.isLoading = false;
  session.error = null;
  session.asked = [];
  checkout.data = undefined;
  checkout.remote = false;
  vi.mocked(desktopApi.revealFolder).mockClear();
});

async function mount() {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const reports: SidebarStatus[] = [];
  const opened: Array<[string, string]> = [];
  const render = (sessionId: string | undefined) =>
    act(async () =>
      root.render(
        <SidebarContribution
          value={{
            section,
            surface: { kind: sessionId ? "chat" : "browser", sessionId },
            visible: true,
            relevant: Boolean(sessionId),
            status: { state: "loading" },
            report: (status) => reports.push(status),
            open: () => {},
          }}
        >
          <SessionDetails
            projectId="p"
            sessionId={sessionId}
            onOpenUrl={(url, mode) => opened.push([url, mode])}
          />
        </SidebarContribution>,
      ),
    );
  const rows = () =>
    [...node.querySelectorAll("[data-sidebar-item-id]")].map((row) => ({
      id: row.getAttribute("data-sidebar-item-id"),
      text: row.textContent,
    }));
  const cleanup = async () => {
    await act(async () => root.unmount());
    node.remove();
  };
  return { node, render, rows, reports, opened, cleanup };
}

describe("the session section (ADR 0225)", () => {
  it("shows where the chat works and the pull requests its agent recorded", async () => {
    session.fields = { metadata: { pull_requests: pullRequests } };
    checkout.data = worktree;
    const view = await mount();
    try {
      await view.render("s1");
      expect(view.reports.at(-1)?.state).toBe("ready");
      expect(
        [...view.node.querySelectorAll("[data-sidebar-subsection]")].map(
          (group) => group.getAttribute("data-sidebar-subsection"),
        ),
      ).toEqual(["Folder", "Pull requests"]);
      expect(view.rows()).toEqual([
        { id: "folder", text: "work/s13 changed files" },
        {
          id: "https://github.com/acme/web/pull/42",
          text: "Session metadata#42Merged",
        },
        {
          id: "https://github.com/acme/web/pull/43",
          text: "Pull request #43acme/web",
        },
      ]);
      await act(async () =>
        view.node
          .querySelector<HTMLButtonElement>(
            '[data-sidebar-item-id="https://github.com/acme/web/pull/42"] [data-tree-primary]',
          )
          ?.click(),
      );
      expect(view.opened).toEqual([
        ["https://github.com/acme/web/pull/42", "replace"],
      ]);
      await act(async () =>
        view.node
          .querySelector<HTMLButtonElement>(
            '[data-sidebar-item-id="folder"] [data-tree-primary]',
          )
          ?.click(),
      );
      expect(desktopApi.revealFolder).toHaveBeenCalledWith(worktree.path);
    } finally {
      await view.cleanup();
    }
  });

  it("follows a recorded pull request live, and says when there is none yet", async () => {
    session.fields = { metadata: {} };
    checkout.data = { ...worktree, kind: "primary", branch: "main" };
    const view = await mount();
    try {
      await view.render("s1");
      expect(view.rows().map((row) => row.text)).toEqual(["Project folder"]);
      // The hint is the chrome's own empty sentence, under its group.
      const hint = view.node.querySelector(
        '[data-sidebar-subsection="Pull requests"] .sidebar-empty-state',
      );
      expect(hint?.textContent).toBe("No pull requests yet.");
      expect(view.reports.at(-1)?.state).toBe("ready");
      session.fields = { metadata: { pull_requests: [pullRequests[0]] } };
      await view.render("s1");
      expect(view.node.querySelector(".sidebar-empty-state")).toBeNull();
      expect(view.rows().map((row) => row.id)).toEqual([
        "folder",
        "https://github.com/acme/web/pull/42",
      ]);
    } finally {
      await view.cleanup();
    }
  });

  it("leaves status to the chrome: loading, and empty without a folder", async () => {
    session.isLoading = true;
    const view = await mount();
    try {
      await view.render("s1");
      expect(view.reports.at(-1)?.state).toBe("loading");
      expect(view.node.textContent).toBe("");
      // A connected project's chat works on its server: no folder here.
      session.isLoading = false;
      session.fields = { metadata: {} };
      checkout.remote = true;
      await view.render("s1");
      expect(view.reports.at(-1)).toMatchObject({
        state: "empty",
        empty: "No pull requests yet.",
      });
      expect(view.node.textContent).toBe("");
      session.error = new Error("gone");
      await view.render("s1");
      expect(view.reports.at(-1)).toMatchObject({
        state: "error",
        error: "Could not read this chat.",
      });
    } finally {
      await view.cleanup();
    }
  });

  it("keeps showing its chat while it leaves", async () => {
    session.fields = { metadata: { pull_requests: pullRequests } };
    const view = await mount();
    checkout.remote = true;
    try {
      await view.render("s1");
      await view.render(undefined);
      expect(session.asked.at(-1)).toBe("s1");
      expect(view.rows()).toHaveLength(2);
    } finally {
      await view.cleanup();
    }
  });
});

describe("sessionPullRequests", () => {
  it("keeps entries of the convention's shape and nothing else", () => {
    expect(
      sessionPullRequests({
        pull_requests: [
          { url: " https://github.com/a/b/pull/1 ", number: 1, state: "open" },
          { url: "https://github.com/a/b/pull/1", number: 1 },
          { url: "javascript:alert(1)" },
          { number: 2 },
          "https://github.com/a/b/pull/3",
          {
            url: "https://gitlab.com/a/b/-/merge_requests/4",
            number: 4.5,
            title: "  ",
            state: "approved",
          },
        ],
      }),
    ).toEqual([
      { url: "https://github.com/a/b/pull/1", number: 1, state: "open" },
      { url: "https://gitlab.com/a/b/-/merge_requests/4" },
    ]);
    expect(sessionPullRequests({ pull_requests: "nope" })).toEqual([]);
    expect(sessionPullRequests(undefined)).toEqual([]);
  });
});
