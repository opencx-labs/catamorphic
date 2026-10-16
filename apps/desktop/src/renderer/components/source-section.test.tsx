// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SidebarSectionConfig,
  SidebarSurface,
} from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { capabilitiesOf, type SectionSource } from "../sources/contract.js";
import {
  SidebarContribution,
  type SidebarStatus,
} from "./sidebar-contribution.js";
import { type SidebarHost, SidebarHostProvider } from "./sidebar-host.js";
import { SourceSection } from "./source-section.js";

const chat = vi.hoisted(() => ({
  fields: null as {
    id: string;
    title: string | null;
    metadata: Record<string, unknown>;
  } | null,
  error: null as Error | null,
  refetch: vi.fn(async () => undefined),
}));

vi.mock("@catamorphic/react", () => ({
  useAgentSessionFields: () => ({
    fields: chat.fields,
    isLoading: false,
    error: chat.error,
    refetch: chat.refetch,
  }),
}));
vi.mock("./session-access.js", () => ({
  SessionAccess: ({ children }: { children: ReactNode }) => children,
}));
// The tree virtualizes; jsdom has no layout.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

afterEach(() => {
  chat.fields = null;
  chat.error = null;
  chat.refetch.mockClear();
  document.body.replaceChildren();
});

/** A source over rows in memory, recording what it was asked. */
function memorySource(
  rows: SidebarSourceItem[],
  extra: Partial<SectionSource> = {},
): SectionSource & { loads: Array<{ session?: unknown }> } {
  const loads: Array<{ session?: unknown }> = [];
  const source: SectionSource & { loads: typeof loads } = {
    title: "Things",
    empty: "No things.",
    loads,
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, session }) => {
      loads.push({ session });
      return {
        items: rows.filter((row) => (row.parentId ?? null) === parentId),
      };
    },
    ...extra,
  };
  return source;
}

async function mount({
  source,
  section = { id: "things", source: ".work/things.ts" },
  surface = { kind: "none" },
  open = () => {},
  host,
}: {
  source: SectionSource;
  section?: SidebarSectionConfig;
  surface?: SidebarSurface;
  open?: (url: string, mode: string) => void;
  host?: SidebarHost;
}) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const reports: SidebarStatus[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SidebarContribution
          value={{
            section,
            surface,
            visible: true,
            relevant: true,
            status: { state: "loading" },
            report: (status) => reports.push(status),
            open,
            registerRefresh: () => () => {},
          }}
        >
          {host ? (
            <SidebarHostProvider value={host}>
              <SourceSection projectId="p" source={source} />
            </SidebarHostProvider>
          ) : (
            <SourceSection projectId="p" source={source} />
          )}
        </SidebarContribution>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    node,
    reports,
    row: (id: string) =>
      node.querySelector<HTMLElement>(`[data-sidebar-item-id="${id}"]`),
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

describe("every list draws one way (ADR 0234)", () => {
  it("draws a row's signal and badges, and opens its address", async () => {
    const opened: Array<[string, string]> = [];
    const view = await mount({
      source: memorySource([
        {
          id: "deploy",
          label: "Deploy",
          url: "workflow:deploy",
          icon: "Rocket",
          signal: "attention",
          badges: [{ label: "main", icon: "GitBranch" }, "Draft"],
        },
      ]),
      open: (url, mode) => opened.push([url, mode]),
    });
    try {
      const row = view.row("deploy");
      expect(row?.textContent).toContain("Deploy");
      expect(row?.textContent).toContain("main");
      expect(row?.textContent).toContain("Draft");
      expect(row?.querySelector('[data-signal="attention"]')).toBeTruthy();
      await act(async () =>
        row?.querySelector<HTMLButtonElement>("[data-tree-primary]")?.click(),
      );
      expect(opened).toEqual([["workflow:deploy", "replace"]]);
      expect(view.reports.at(-1)).toMatchObject({ state: "ready" });
    } finally {
      await view.cleanup();
    }
  });

  it("removes a row's overflow menu when its menu is empty", async () => {
    const view = await mount({
      source: memorySource([
        { id: "quiet", label: "Quiet", url: "https://quiet.test", menu: [] },
        { id: "full", label: "Full", url: "https://full.test" },
      ]),
    });
    try {
      expect(
        view.row("quiet")?.querySelector('[aria-haspopup="menu"]'),
      ).toBeNull();
      expect(
        view.row("full")?.querySelector('[aria-haspopup="menu"]'),
      ).toBeTruthy();
    } finally {
      await view.cleanup();
    }
  });

  it("hands a tab row's drag to the window only while it lasts", async () => {
    const onTabDrag = vi.fn();
    const host: SidebarHost = {
      projectId: "p",
      agentsData: null,
      defaultAgentId: null,
      projectAgentNames: {},
      onSessionCommand: () => {},
      onSessionAction: () => {},
      commandAvailable: () => true,
      openTab: (url) =>
        url === "browser:b1"
          ? {
              key: url,
              kind: "browser",
              title: "Docs",
              bookmarkUrl: "https://docs.test",
            }
          : undefined,
      onTabDrag,
    };
    const view = await mount({
      source: memorySource([
        { id: "browser:b1", label: "Docs", url: "browser:b1" },
      ]),
      host,
    });
    try {
      // Drawing the row is not dragging it.
      expect(onTabDrag).not.toHaveBeenCalled();
      const item = view.row("browser:b1")?.closest("[draggable]");
      const data = new Map<string, string>();
      const transfer = {
        setData: (type: string, value: string) => data.set(type, value),
        getData: (type: string) => data.get(type) ?? "",
        get types() {
          return [...data.keys()];
        },
        effectAllowed: "",
      };
      await act(async () => {
        const start = new Event("dragstart", { bubbles: true });
        Object.assign(start, { dataTransfer: transfer });
        item?.dispatchEvent(start);
      });
      expect(onTabDrag).toHaveBeenLastCalledWith("browser:b1");
      await act(async () => {
        const end = new Event("dragend", { bubbles: true });
        Object.assign(end, { dataTransfer: transfer });
        item?.dispatchEvent(end);
      });
      expect(onTabDrag).toHaveBeenLastCalledWith(null);
    } finally {
      await view.cleanup();
    }
  });

  it("highlights the row whose address is in front", async () => {
    const view = await mount({
      source: memorySource([
        { id: "a", label: "A", url: "file:docs/a.md" },
        { id: "b", label: "B", url: "file:docs/b.md" },
      ]),
      surface: { kind: "editor", path: "docs/b.md" },
    });
    try {
      expect(
        view.row("b")?.querySelector("[aria-current]")?.textContent,
      ).toContain("B");
      expect(view.row("a")?.querySelector("[aria-current]")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it("runs a row without an address through its source", async () => {
    const actions: Array<{ itemId: string; action: string }> = [];
    const opened: string[] = [];
    const view = await mount({
      source: memorySource([{ id: "change", label: "README.md" }], {
        action: async ({ itemId, action }) => {
          actions.push({ itemId, action });
          return { open: "file:README.md" };
        },
      }),
      open: (url) => opened.push(url),
    });
    try {
      await act(async () =>
        view
          .row("change")
          ?.querySelector<HTMLButtonElement>("[data-tree-primary]")
          ?.click(),
      );
      // A plain click passes the mode it opens in as its verb.
      expect(actions).toEqual([{ itemId: "change", action: "open-here" }]);
      expect(opened).toEqual(["file:README.md"]);
    } finally {
      await view.cleanup();
    }
  });

  it("asks for an action's values first and says what happened", async () => {
    const actions: Array<{ action: string; values?: Record<string, string> }> =
      [];
    const view = await mount({
      source: memorySource(
        [
          {
            id: "todo",
            label: "Milk",
            actions: [
              {
                label: "Rename",
                action: "rename",
                icon: "Pencil",
                input: {
                  title: "Rename todo",
                  fields: [{ name: "text", label: "Todo", value: "Milk" }],
                },
              },
            ],
          },
        ],
        {
          action: async ({ action, values }) => {
            actions.push({ action, values });
            return { message: "Renamed." };
          },
        },
      ),
    });
    try {
      await act(async () =>
        view
          .row("todo")
          ?.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')
          ?.click(),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const input =
        document.querySelector<HTMLInputElement>('input[name="text"]');
      expect(input?.value).toBe("Milk");
      expect(document.body.textContent).toContain("Rename todo");
      // The form submits what is typed.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        if (input) setter?.call(input, "Oat milk");
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        input?.form?.requestSubmit();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(actions).toEqual([
        { action: "rename", values: { text: "Oat milk" } },
      ]);
      expect(view.node.textContent).toContain("Renamed.");
    } finally {
      await view.cleanup();
    }
  });

  it("draws root rows as tiles and folders as a tree", async () => {
    const view = await mount({
      section: {
        id: "pins",
        source: "work:pinned",
        title: "",
        presentation: "tiles",
      },
      source: memorySource([
        { id: "docs", label: "Docs", url: "https://docs.example.com" },
        { id: "folder", label: "Folder", hasChildren: true },
      ]),
    });
    try {
      expect(
        view.node.querySelector('ul[aria-label="Tiles"] [data-item-id="docs"]'),
      ).toBeTruthy();
      expect(view.node.querySelector('[role="tree"]')?.textContent).toContain(
        "Folder",
      );
      expect(
        view.node.querySelector('[role="tree"]')?.textContent,
      ).not.toContain("Docs");
    } finally {
      await view.cleanup();
    }
  });

  it("runs a session-scoped source only with its chat, and hands it the chat", async () => {
    chat.error = new Error("Session not found");
    const failing = memorySource([]);
    const first = await mount({
      source: failing,
      section: {
        id: "deploys",
        source: ".work/deploys.ts",
        when: { session: true },
      },
      surface: { kind: "browser", sessionId: "s1" },
    });
    try {
      expect(first.reports.at(-1)).toMatchObject({
        state: "error",
        error: "Could not read this chat.",
      });
      expect(failing.loads).toHaveLength(0);
    } finally {
      await first.cleanup();
    }
    chat.error = null;
    chat.fields = { id: "s1", title: "Ship it", metadata: { deploy: "ok" } };
    const source = memorySource([]);
    const second = await mount({
      source,
      section: {
        id: "deploys",
        source: ".work/deploys.ts",
        when: { session: true },
      },
      surface: { kind: "browser", sessionId: "s1" },
    });
    try {
      expect(source.loads.at(-1)?.session).toEqual({
        id: "s1",
        title: "Ship it",
        metadata: { deploy: "ok" },
      });
      expect(second.reports.at(-1)).toMatchObject({
        state: "empty",
        empty: "No things.",
      });
    } finally {
      await second.cleanup();
    }
  });
});
