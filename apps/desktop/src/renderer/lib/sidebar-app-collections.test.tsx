// @vitest-environment jsdom
import type { AppCollections } from "@catamorphic/app";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSidebarAppCollections } from "./sidebar-app-collections.js";
import type { WorkspaceTab } from "./workspace-types.js";

const mocks = vi.hoisted(() => ({
  GET: vi.fn(),
  open: vi.fn(),
  session: vi.fn(),
  listen: vi.fn((_options: { listener: () => void }) => () => {}),
  query: {
    fetchQuery: vi.fn(
      async ({
        queryFn,
      }: {
        queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
      }) => queryFn({ signal: new AbortController().signal }),
    ),
    getQueryCache: () => ({ subscribe: () => () => {} }),
  },
}));
vi.mock("@catamorphic/react", () => ({
  useCatamorphic: () => ({ apiClient: mocks }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.query }));
vi.mock("./sidebar-sessions.js", async (original) => ({
  ...(await original<typeof import("./sidebar-sessions.js")>()),
  subscribeSidebarSessions: mocks.listen,
}));
vi.mock("../components/files-nav.js", () => ({
  buildTree: () => [],
  isVisibleProjectFile: () => true,
}));
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    onGitChanged: () => () => {},
    onBookmarksChanged: () => () => {},
  },
}));

it("checks grants and advertised item actions, forwards open modes, and updates live tabs", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  let broker: AppCollections | undefined;
  function Probe({ tabs }: { tabs: WorkspaceTab[] }) {
    broker = useSidebarAppCollections({
      projectId: "project",
      profileId: "profile",
      surface: { kind: "chat", sessionId: "parent" },
      tabs,
      granted: ["chats", "tabs"],
      builder: false,
      onOpenSession: mocks.open,
      onOpenTab: mocks.open,
      onOpenFile: mocks.open,
      onOpenUrl: mocks.open,
      onSessionAction: mocks.session,
    });
    return null;
  }
  const signal = new AbortController().signal;
  try {
    await act(async () =>
      root.render(<Probe tabs={[{ kind: "editor", name: "notes.md" }]} />),
    );
    if (!broker) throw new Error("Missing collection broker");
    const current = broker;
    await expect(current.read({ source: "git", signal })).rejects.toThrow(
      "not granted",
    );
    expect(mocks.GET).not.toHaveBeenCalled();
    await expect(
      current.execute({
        source: "chats",
        itemId: "unread",
        action: "archive",
        signal,
      }),
    ).rejects.toThrow("does not support");
    mocks.GET.mockResolvedValue({
      data: {
        items: [
          {
            id: "child",
            title: "Child",
            visibility: "promoted",
            childCount: 2,
          },
        ],
        total: 1,
      },
    });
    const page = await current.read({ source: "chats", signal });
    expect(page.items[0]?.hasChildren).toBe(true);
    await current.execute({
      source: "chats",
      itemId: "child",
      action: "open-floating",
      signal,
    });
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ id: "child" }),
      "floating",
    );
    await current.execute({
      source: "chats",
      itemId: "child",
      action: "mark-read",
      signal,
    });
    expect(mocks.session).toHaveBeenCalledWith("child", "mark-read");
    await current.read({ source: "chats", parentId: "child", signal });
    const childUpdates = vi.fn();
    const stopChildren = current.subscribe?.({
      source: "chats",
      publish: childUpdates,
    });
    mocks.listen.mock.calls.at(-1)?.[0].listener();
    expect(childUpdates.mock.calls.map(([change]) => change)).toEqual([
      { type: "invalidate" },
      { type: "invalidate", parentId: "child" },
    ]);
    stopChildren?.();
    const publish = vi.fn();
    const unsubscribe = current.subscribe?.({ source: "tabs", publish });
    await act(async () =>
      root.render(<Probe tabs={[{ kind: "editor", name: "new.md" }]} />),
    );
    expect(broker).toBe(current);
    expect(publish).toHaveBeenCalledWith({ type: "invalidate" });
    expect(
      (await current.read({ source: "tabs", signal })).items[0]?.label,
    ).toBe("new.md");
    unsubscribe?.();
    publish.mockClear();
    await act(async () => root.render(<Probe tabs={[]} />));
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
