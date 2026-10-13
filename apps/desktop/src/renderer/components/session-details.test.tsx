// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarSectionConfig } from "../../shared/sidebar.js";
import { desktopApi, type SessionCheckoutDetail } from "../lib/desktop-api.js";
import { SessionDetails } from "./session-details.js";
import {
  SidebarContribution,
  type SidebarStatus,
} from "./sidebar-contribution.js";

const session = vi.hoisted(() => ({
  fields: null as { metadata: Record<string, unknown> } | null,
  isLoading: false,
  error: null as Error | null,
  asked: [] as Array<string | undefined>,
  /** Whether the section asked to follow the chat live. */
  live: [] as boolean[],
}));
const checkout = vi.hoisted(() => ({
  data: undefined as SessionCheckoutDetail | undefined,
  error: null as Error | null,
  remote: false,
  /** The project's access: read, being read, or failed. */
  access: "ready" as "ready" | "pending" | "failed",
  enabled: [] as boolean[],
}));

vi.mock("@catamorphic/react", () => ({
  useAgentSessionFields: (
    _projectId: string,
    sessionId?: string,
    options: { live?: boolean } = {},
  ) => {
    session.asked.push(sessionId);
    session.live.push(options.live ?? false);
    return {
      fields: session.fields,
      isLoading: session.isLoading,
      error: session.error,
      refetch: async () => undefined,
    };
  },
}));
vi.mock("../lib/use-session-checkout.js", () => ({
  // As the query does: disabled, it reads nothing.
  useSessionCheckout: (
    _projectId: string,
    _sessionId: string | undefined,
    options: { enabled?: boolean } = {},
  ) => {
    const enabled = options.enabled ?? true;
    checkout.enabled.push(enabled);
    return {
      data: enabled ? checkout.data : undefined,
      isLoading: false,
      isFetching: false,
      error: enabled ? checkout.error : null,
      refetch: async () => undefined,
    };
  },
}));
vi.mock("./project-authority-provider.js", () => ({
  // The project's own access: a connected project's chat is read inside it.
  ProjectAuthorityProvider: ({
    projectId,
    children,
    fallback,
  }: {
    projectId: string;
    children: React.ReactNode;
    fallback?: (error: Error | null) => React.ReactNode;
  }) =>
    checkout.access === "ready" ? (
      <div data-project-access={projectId}>{children}</div>
    ) : (
      fallback?.(
        checkout.access === "failed" ? new Error("Server unreachable") : null,
      )
    ),
  useRemoteAuthority: () =>
    checkout.remote ? { serverUrl: "https://s" } : null,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { revealFolder: vi.fn(async () => {}) },
}));

const section: SidebarSectionConfig = {
  id: "session",
  type: "session",
  when: { session: true },
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
  session.live = [];
  checkout.data = undefined;
  checkout.error = null;
  checkout.remote = false;
  checkout.access = "ready";
  checkout.enabled = [];
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
      // On screen it follows the chat itself: a change made outside a
      // turn shows while a page the chat opened is in front.
      expect(session.live.at(-1)).toBe(true);
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

  it("leaves status to the chrome: loading, empty, and errors only with nothing to show", async () => {
    session.isLoading = true;
    const view = await mount();
    try {
      await view.render("s1");
      expect(view.reports.at(-1)?.state).toBe("loading");
      expect(view.node.textContent).toBe("");
      session.isLoading = false;
      session.fields = { metadata: { pull_requests: pullRequests } };
      checkout.data = worktree;
      await view.render("s1");
      expect(view.rows()).toHaveLength(3);
      // A refresh that fails keeps the rows it had.
      session.error = new Error("offline");
      checkout.error = new Error("offline");
      await view.render("s1");
      expect(view.reports.at(-1)?.state).toBe("ready");
      expect(view.rows()).toHaveLength(3);
      // Nothing read at all: the chrome says so, with Retry.
      session.fields = null;
      await view.render("s1");
      expect(view.reports.at(-1)).toMatchObject({
        state: "error",
        error: "Could not read this chat.",
      });
      expect(view.rows()).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });

  it("reads a connected project's chat in the project's own access, with no folder here", async () => {
    session.fields = { metadata: { pull_requests: pullRequests } };
    checkout.data = worktree;
    checkout.remote = true;
    const view = await mount();
    try {
      await view.render("s1");
      // The rows read the session inside the project's access (its
      // server's cache, which the chat's stream keeps current).
      const access = view.node.querySelector('[data-project-access="p"]');
      expect(access?.querySelectorAll("[data-sidebar-item-id]").length).toBe(2);
      // The chat works on its server: no folder, and no checkout read.
      expect(view.rows().map((row) => row.id)).not.toContain("folder");
      expect(checkout.enabled.at(-1)).toBe(false);
      session.fields = { metadata: {} };
      await view.render("s1");
      expect(view.reports.at(-1)).toMatchObject({
        state: "empty",
        empty: "No pull requests yet.",
      });
      expect(view.node.textContent).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("shows the project's access being read, or failing, as section status", async () => {
    checkout.access = "pending";
    const view = await mount();
    try {
      await view.render("s1");
      expect(view.reports.at(-1)?.state).toBe("loading");
      expect(view.node.textContent).toBe("");
      checkout.access = "failed";
      await view.render("s1");
      expect(view.reports.at(-1)).toMatchObject({
        state: "error",
        error: "Server unreachable",
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
      // Leaving, it shows what it had and stops following.
      expect(session.live.at(-1)).toBe(false);
      expect(view.rows()).toHaveLength(2);
    } finally {
      await view.cleanup();
    }
  });
});
