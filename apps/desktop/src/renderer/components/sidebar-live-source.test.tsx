// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidebarSectionConfig } from "../../shared/sidebar.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  SidebarContribution,
  type SidebarStatus,
} from "./sidebar-contribution.js";
import { SidebarLiveSource } from "./sidebar-live-source.js";

const chat = vi.hoisted(() => ({
  fields: null as {
    id: string;
    title: string | null;
    metadata: Record<string, unknown>;
  } | null,
  error: null as Error | null,
  live: [] as boolean[],
  refetch: vi.fn(async () => undefined),
}));

vi.mock("@catamorphic/react", () => ({
  useAgentSessionFields: (
    _projectId: string,
    _sessionId: string | undefined,
    options: { live?: boolean } = {},
  ) => {
    chat.live.push(options.live ?? false);
    return {
      fields: chat.fields,
      isLoading: false,
      error: chat.error,
      refetch: chat.refetch,
    };
  },
}));
vi.mock("./session-details.js", () => ({
  SessionAccess: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    sidebarSourceRequest: vi.fn(async () => ({ items: [] })),
    sidebarSourceCancel: vi.fn(async () => {}),
    sidebarSourceSubscribe: vi.fn(async () => {}),
    sidebarSourceUnsubscribe: vi.fn(async () => {}),
    onSidebarSourceChanged: vi.fn(() => () => {}),
  },
}));

const section: SidebarSectionConfig = {
  id: "deploys",
  type: "custom",
  source: { type: "custom", module: ".work/sidebar/deploys.ts" },
  when: { session: true },
};

afterEach(() => {
  chat.fields = null;
  chat.error = null;
  chat.live = [];
  chat.refetch.mockClear();
  vi.mocked(desktopApi.sidebarSourceRequest).mockClear();
});

async function mount() {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const reports: SidebarStatus[] = [];
  const refreshes: Array<() => unknown> = [];
  await act(async () =>
    root.render(
      <SidebarContribution
        value={{
          section,
          surface: { kind: "browser", sessionId: "s1" },
          visible: true,
          relevant: true,
          status: { state: "loading" },
          report: (status) => reports.push(status),
          open: () => {},
          registerRefresh: (refresh) => {
            refreshes.push(refresh);
            return () => {};
          },
        }}
      >
        <SidebarLiveSource projectId="p" />
      </SidebarContribution>,
    ),
  );
  const cleanup = async () => {
    await act(async () => root.unmount());
    node.remove();
  };
  return { reports, refreshes, cleanup };
}

describe("a session-scoped live source (ADR 0225)", () => {
  it("says a failed read of its chat, and runs the module only with the chat", async () => {
    chat.error = new Error("Session not found");
    const view = await mount();
    try {
      expect(view.reports.at(-1)).toMatchObject({
        state: "error",
        error: "Could not read this chat.",
      });
      // Refresh (the header's, or Retry) reads the chat again, never the
      // person's module without one.
      await act(async () => {
        await view.refreshes.at(-1)?.();
      });
      expect(chat.refetch).toHaveBeenCalledTimes(1);
      expect(desktopApi.sidebarSourceRequest).not.toHaveBeenCalled();
    } finally {
      await view.cleanup();
    }
  });

  it("follows its chat while shown and hands the module the chat", async () => {
    chat.fields = { id: "s1", title: "Ship it", metadata: { deploy: "ok" } };
    const view = await mount();
    try {
      expect(chat.live.at(-1)).toBe(true);
      expect(desktopApi.sidebarSourceRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "load",
          session: { id: "s1", title: "Ship it", metadata: { deploy: "ok" } },
        }),
      );
      expect(view.reports.at(-1)?.state).toBe("empty");
    } finally {
      await view.cleanup();
    }
  });
});
