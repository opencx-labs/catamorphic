// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ProjectInspectorSnapshot,
  ProjectInspectorView,
} from "./project-inspector";

const snapshot: ProjectInspectorSnapshot = {
  root: "/projects/alpha",
  git: {
    available: true,
    worktrees: [
      {
        path: "/projects/alpha",
        branch: "main",
        isMain: true,
        isCurrent: true,
        branchChanges: [],
        changes: [],
      },
      {
        path: "/projects/alpha-feature",
        branch: "feature",
        isMain: false,
        isCurrent: false,
        branchChanges: [],
        changes: [{ path: "README.md", kind: "modified", mode: "unstaged" }],
      },
    ],
  },
  prs: Array.from({ length: 5 }, (_, index) => ({
    number: 42 + index,
    title: `Improve desktop ${index + 1}`,
    url: "https://example.test/42",
    author: "tabaza",
    head: "feature",
    base: "main",
    draft: false,
    updatedAt: "2026-08-29T00:00:00.000Z",
  })),
  remote: null,
  checkouts: [],
  errors: [],
};

const project = {
  id: "alpha",
  name: "Alpha",
  storageType: "managed" as const,
  remoteUrl: null,
  defaultBranch: "main",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

describe("ProjectInspectorView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("shows project health and keeps delete behind the actions button", async () => {
    const onDelete = vi.fn();
    await act(async () => {
      root.render(
        <ProjectInspectorView
          project={project}
          current
          snapshot={snapshot}
          sessions={[]}
          sessionsLoading={false}
          loading={false}
          onDelete={onDelete}
        />,
      );
    });
    expect(container.textContent).toContain("feature");
    expect(container.textContent).toContain("#42");
    expect(container.textContent).toContain("#46");
    expect(container.textContent).not.toContain("Sessions");
    expect(container.textContent).not.toContain("Delete project");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label^="Project actions"]')
        ?.click(),
    );
    const deleteButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Delete project"),
    );
    await act(async () => deleteButton?.click());
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("bounds large worktree lists and reveals the last row on scroll", async () => {
    const worktrees = Array.from({ length: 86 }, (_, index) => ({
      path: `/projects/tree-${index}`,
      branch: `branch-${index}`,
      isMain: index === 0,
      isCurrent: index === 0,
      branchChanges: [],
      changes: [],
    }));
    await act(async () => {
      root.render(
        <ProjectInspectorView
          project={project}
          current
          snapshot={{ ...snapshot, git: { available: true, worktrees } }}
          sessions={[]}
          sessionsLoading={false}
          loading={false}
          onDelete={() => undefined}
        />,
      );
    });
    const list = container.querySelector<HTMLElement>(
      '[aria-label="Project worktrees"]',
    );
    expect(list).not.toBeNull();
    expect(list?.style.height).toBe("224px");
    expect(list?.querySelectorAll("[data-windowed-index]").length).toBeLessThan(
      25,
    );
    expect(list?.textContent).not.toContain("branch-85");
    await act(async () => {
      if (!list) throw new Error("Missing list");
      list.scrollTop = 86 * 28 - 224;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(list?.textContent).toContain("branch-85");
    expect(list?.querySelectorAll("[data-windowed-index]").length).toBeLessThan(
      25,
    );
    expect(container.textContent).toContain("Local only");
  });

  it("shows session status only for another project", async () => {
    await act(async () => {
      root.render(
        <ProjectInspectorView
          project={{ ...project, id: "beta", name: "Beta" }}
          current={false}
          snapshot={snapshot}
          sessions={[
            { id: "session-1", title: "Working chat", running: true },
            {
              id: "session-2",
              title: "Closed chat",
              running: false,
              status: "closed",
            },
          ]}
          sessionsLoading={false}
          loading={false}
          onDelete={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain("Sessions");
    expect(container.textContent).toContain("Working chat");
    expect(container.textContent).toContain("Working");
    expect(container.textContent).not.toContain("Closed chat");
  });

  it("hides repository mechanics for a project member", async () => {
    await act(async () => {
      root.render(
        <ProjectInspectorView
          project={project}
          current
          snapshot={{
            ...snapshot,
            remote: {
              serverUrl: "https://catamorphic.example.test/api",
              remoteProjectId: "remote-alpha",
              remoteProjectName: "Alpha",
              lastSyncAt: null,
              capabilities: {
                builder: false,
                source: null,
                permissions: [],
                agents: ["csm"],
                documents: [{ path: "store/**", access: "write" }],
                features: {
                  publications: "members",
                  proposals: false,
                  proposalsOpenPullRequests: false,
                  mcp: true,
                  agentSessions: true,
                  storeUploadMaxBytes: 10_000_000,
                },
              },
              connection: {
                state: "connected",
                checkedAt: "2026-09-04T00:00:00.000Z",
                message: "Connected",
              },
              local: { modified: [], deleted: [], programEdits: [] },
            },
          }}
          sessions={[]}
          sessionsLoading={false}
          loading={false}
          onDelete={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Team project");
    expect(container.textContent).not.toContain("/projects/alpha");
    expect(container.textContent).not.toContain("Worktrees");
    expect(container.textContent).not.toContain("Open pull requests");
  });
});
