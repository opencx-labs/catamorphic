// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectInspector } from "./project-inspector.js";

const mocks = vi.hoisted(() => ({
  prefs: { githubCliEnabled: false },
  list: vi.fn(),
}));
vi.mock("@catamorphic/react", () => ({
  useAgentSessions: () => ({ data: { items: [] }, isLoading: false }),
}));
vi.mock("../lib/use-app-preferences.js", () => ({
  useAppPreferences: () => ({ prefs: mocks.prefs }),
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    remoteStatus: async () => null,
    projectRoot: async () => "/project",
    gitOverview: async () => ({ available: false, worktrees: [] }),
    sessionCheckouts: async () => [],
    prList: mocks.list,
  },
}));
it("refreshes an open inspector when GitHub connection preferences change", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  mocks.list.mockResolvedValue({
    status: "unavailable",
    reason: "connection-disabled",
    message: "Connect GitHub CLI in Settings to see pull requests.",
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  const view = () => (
    <ProjectInspector
      project={{
        id: "project",
        name: "Project",
        storageType: "managed",
        remoteUrl: null,
        defaultBranch: "main",
        createdAt: "2026-09-18",
        updatedAt: "2026-09-18",
      }}
      current
      onDelete={() => {}}
    />
  );
  try {
    await act(async () => root.render(view()));
    expect(node.textContent).toContain("Connect GitHub CLI");
    const before = mocks.list.mock.calls.length;
    mocks.prefs.githubCliEnabled = true;
    mocks.list.mockResolvedValue({
      status: "unavailable",
      reason: "no-github-remote",
      message: "This project has no GitHub origin remote.",
    });
    await act(async () => root.render(view()));
    expect(mocks.list).toHaveBeenCalledTimes(before + 1);
    expect(node.textContent).toContain("no GitHub origin remote");
    expect(node.textContent).not.toContain("Connect GitHub CLI");
  } finally {
    await act(async () => root.unmount());
    mocks.prefs.githubCliEnabled = false;
  }
});
