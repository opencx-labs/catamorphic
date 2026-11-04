// @vitest-environment jsdom

import { act, type ReactNode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceEvent,
  WorkspaceNavigation,
} from "../shared/desktop-workspace.js";
import { desktopApi } from "./lib/desktop-api.js";
import { useWorkspace } from "./lib/workspace-context.js";
import { WorkspaceRoot } from "./workspace-root.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const {
  listeners,
  invalidateQueries,
  cancelQueries,
  consumed,
  projectList,
  attention,
} = vi.hoisted(() => ({
  listeners: new Set<(event: WorkspaceEvent) => void>(),
  invalidateQueries: vi.fn<() => Promise<void>>(),
  cancelQueries: vi.fn<() => Promise<void>>(),
  consumed: vi.fn<(surface: WorkspaceNavigation["surface"]) => void>(),
  projectList: {
    data: {
      items: [
        { id: "project", name: "Project" },
        { id: "other", name: "Other project" },
      ],
    },
    isFetching: false,
  },
  attention: { data: [] },
}));

vi.mock("@catamorphic/react", () => ({
  useAgentAttention: () => attention,
}));
vi.mock("./lib/use-desktop-projects.js", () => ({
  useDesktopProjects: () => projectList,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries,
    cancelQueries,
  }),
}));
vi.mock("./lib/desktop-api.js", () => ({
  desktopApi: {
    workspaceInitial: vi.fn(),
    onProfilesChanged: vi.fn(() => () => {}),
    workspaceClaim: vi.fn(),
    workspaceActive: vi.fn(),
    setPrefs: vi.fn(),
    onWorkspaceEvent: (listener: (event: WorkspaceEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));
vi.mock("./app.js", () => ({
  // Observe the real root's context at App's consumption boundary. Like App,
  // consume each nonce once, only after a visible workspace commits.
  App: function SurfaceConsumer() {
    const runtime = useWorkspace();
    const lastNonce = useRef<string | undefined>(undefined);
    useEffect(() => {
      const surface = runtime.navigation;
      if (!runtime.visible || !surface || surface.nonce === lastNonce.current)
        return;
      lastNonce.current = surface.nonce;
      consumed(surface);
    }, [runtime.navigation, runtime.visible]);
    return null;
  },
}));
vi.mock("./components/dock-host.js", () => ({ DockHost: () => null }));
vi.mock("./components/modal.js", () => ({ Modal: () => null }));
vi.mock("./components/project-authority-provider.js", () => ({
  ProjectAuthorityProvider: ({ children }: { children: ReactNode }) => children,
  useRemoteAuthority: () => undefined,
}));
vi.mock("./lib/theme.js", () => ({
  ProjectTheme: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./lib/workspace-persistence.js", () => ({
  flushWorkspaceSaves: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateQueries.mockResolvedValue(undefined);
  cancelQueries.mockResolvedValue(undefined);
  vi.mocked(desktopApi.workspaceClaim).mockResolvedValue(true);
  vi.mocked(desktopApi.workspaceInitial).mockResolvedValue({
    projectIds: ["project"],
    activeProjectId: "project",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  expect(listeners.size).toBe(0);
});

async function mount() {
  await act(async () => root?.render(<WorkspaceRoot />));
}

function navigate(event: WorkspaceNavigation) {
  for (const listener of listeners) listener({ kind: "navigate", ...event });
}

function fileSurface(
  nonce: string,
): NonNullable<WorkspaceNavigation["surface"]> {
  return { url: `file:${nonce}.txt`, title: nonce, mode: "tab", nonce };
}

describe("workspace surface navigation", () => {
  it("keeps a file request when an older bare reveal finishes refreshing in the same commit", async () => {
    await mount();
    const revealRefresh = deferred<void>();
    const fileRefresh = deferred<void>();
    const surface = fileSurface("existing");
    invalidateQueries
      .mockReturnValueOnce(revealRefresh.promise)
      .mockReturnValueOnce(fileRefresh.promise);

    await act(async () => {
      navigate({ projectId: "project" });
      navigate({ projectId: "project", surface });
    });
    expect(desktopApi.workspaceClaim).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(consumed).not.toHaveBeenCalled();

    await act(async () => {
      fileRefresh.resolve();
      await fileRefresh.promise;
      // Both continuations queue their state before React commits. The
      // earlier reveal has no surface command to cancel the file request.
      revealRefresh.resolve();
      await revealRefresh.promise;
    });
    expect(consumed.mock.calls).toEqual([[surface]]);
  });

  it("does not replay a consumed request on reveal, and still consumes a later explicit request", async () => {
    await mount();
    const first = fileSurface("first");
    const second = fileSurface("second");

    await act(async () => navigate({ projectId: "project", surface: first }));
    await act(async () => navigate({ projectId: "project" }));
    expect(consumed.mock.calls).toEqual([[first]]);
    await act(async () => navigate({ projectId: "project", surface: second }));
    expect(consumed.mock.calls).toEqual([[first], [second]]);
  });

  it("leaves another window's project alone when its ownership claim is refused", async () => {
    await mount();
    vi.mocked(desktopApi.workspaceClaim).mockResolvedValueOnce(false);
    await act(async () =>
      navigate({ projectId: "other", surface: fileSurface("private") }),
    );
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-project-runtime="other"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-project-runtime="project"]')
        ?.getAttribute("data-workspace-visible"),
    ).toBe("true");
  });
});

it("restarts an initial catalog read after another window changes profiles", async () => {
  await mount();
  const receive = vi
    .mocked(desktopApi.onProfilesChanged)
    .mock.calls.at(-1)?.[0];
  const data = { profiles: [], defaultProfileId: "default" };
  await act(async () => receive?.(data));
  expect(cancelQueries).toHaveBeenCalledWith({ queryKey: ["cat", "projects"] });
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: ["cat", "projects"],
  });
  expect(cancelQueries.mock.invocationCallOrder[0]).toBeLessThan(
    invalidateQueries.mock.invocationCallOrder[0] ?? Infinity,
  );
});

it("keeps a retained project when a refreshed catalog omits its record", async () => {
  const original = projectList.data;
  try {
    await mount();
    projectList.data = { items: [] };
    await mount();
    expect(
      container.querySelector('[data-project-runtime="project"]'),
    ).not.toBeNull();
    await act(async () => {
      for (const receive of listeners)
        receive({ kind: "forget", projectId: "project" });
    });
    expect(
      container.querySelector('[data-project-runtime="project"]'),
    ).toBeNull();
  } finally {
    projectList.data = original;
  }
});
