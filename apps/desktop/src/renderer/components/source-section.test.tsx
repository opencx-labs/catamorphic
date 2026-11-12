// @vitest-environment jsdom
import type { CollectionChange } from "@catamorphic/app";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SidebarSectionConfig,
  SidebarSurface,
} from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { TAB_DRAG_TYPE } from "../lib/tab-drag.js";
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

/** A section's chrome: what the list reports is the status it shows. */
function Contributed({
  section,
  surface,
  open,
  onReport,
  visible = true,
  children,
}: {
  section: SidebarSectionConfig;
  surface: SidebarSurface;
  open: (url: string, mode: string) => void;
  onReport: (status: SidebarStatus) => void;
  visible?: boolean;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<SidebarStatus>({ state: "loading" });
  const report = useCallback(
    (next: SidebarStatus) => {
      onReport(next);
      setStatus(next);
    },
    [onReport],
  );
  return (
    <SidebarContribution
      value={{
        section,
        surface,
        visible,
        relevant: true,
        status,
        report,
        open,
        registerRefresh: () => () => {},
      }}
    >
      {children}
    </SidebarContribution>
  );
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
  let visible = true;
  let shownSurface = surface;
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <Contributed
          section={section}
          visible={visible}
          surface={shownSurface}
          open={open}
          onReport={(status) => reports.push(status)}
        >
          {host ? (
            <SidebarHostProvider value={host}>
              <SourceSection projectId="p" source={source} />
            </SidebarHostProvider>
          ) : (
            <SourceSection projectId="p" source={source} />
          )}
        </Contributed>
      </QueryClientProvider>,
    );
  await act(async () => render());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    node,
    reports,
    show: async (next: boolean) => {
      visible = next;
      await act(async () => render());
    },
    context: async (next: SidebarSurface) => {
      shownSurface = next;
      await act(async () => render());
    },
    row: (id: string) =>
      node.querySelector<HTMLElement>(`[data-sidebar-item-id="${id}"]`),
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

describe("every list draws one way (ADR 0234)", () => {
  it("reads each subscribed view once per explicit recovery and retains a failed read until retry", async () => {
    let failing = true;
    const listeners = new Set<
      (change: CollectionChange<SidebarSourceItem>) => void
    >();
    const load = vi.fn(async () => {
      if (failing) throw new Error("Service unavailable: 503");
      return { items: [{ id: "service", label: "Service item 3" }] };
    });
    const retry = vi.fn(async () => {
      for (const publish of listeners) publish({ type: "invalidate" });
    });
    const source = memorySource([], {
      load,
      retry,
      subscribe: (publish) => {
        listeners.add(publish);
        return () => {
          listeners.delete(publish);
        };
      },
    });
    const first = await mount({ source });
    const second = await mount({ source });
    try {
      load.mockClear();
      await act(async () => {
        await first.reports.at(-1)?.retry?.();
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledTimes(2);
      expect(first.reports.at(-1)).toMatchObject({
        state: "error",
        error: "Service unavailable: 503",
      });
      expect(second.reports.at(-1)).toMatchObject({
        state: "error",
        error: "Service unavailable: 503",
      });
      failing = false;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(first.reports.at(-1)).toMatchObject({ state: "error" });
      await act(async () => {
        await first.reports.at(-1)?.retry?.();
      });
      expect(load).toHaveBeenCalledTimes(4);
      expect(first.row("service")).toBeTruthy();
      expect(second.row("service")).toBeTruthy();
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("reads an approved module once through its shared invalidation", async () => {
    let approved = false;
    let publish:
      | ((change: CollectionChange<SidebarSourceItem>) => void)
      | undefined;
    const load = vi.fn(async () => ({
      items: approved ? [{ id: "ready", label: "Ready" }] : [],
    }));
    const allow = vi.fn(async () => {
      approved = true;
      publish?.({ type: "invalidate" });
    });
    const source = memorySource([], {
      load,
      access: () =>
        approved
          ? null
          : {
              request: {
                module: ".work/things/index.ts",
                beyond: ["Read files"],
                all: ["Read files"],
                network: false,
                fingerprint: "files",
              },
              allow,
            },
      subscribe: (next) => {
        publish = next;
        return () => {};
      },
    });
    const view = await mount({ source });
    try {
      load.mockClear();
      await act(async () => {
        await view.reports.at(-1)?.access?.allow();
      });
      expect(allow).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledOnce();
      expect(view.row("ready")).toBeTruthy();
    } finally {
      await view.cleanup();
    }
  });

  it("runs recovery only for the person's Retry, never a passive invalidation", async () => {
    let unlocked = false;
    let publish:
      | ((change: CollectionChange<SidebarSourceItem>) => void)
      | undefined;
    const retry = vi.fn(async () => {
      unlocked = true;
      publish?.({ type: "invalidate" });
    });
    const source = memorySource([], {
      retry,
      load: async () => {
        if (!unlocked) throw new Error("Saved access is locked");
        return { items: [{ id: "ready", label: "Ready" }] };
      },
      subscribe: (next) => {
        publish = next;
        return () => {};
      },
    });
    const view = await mount({ source });
    try {
      expect(view.reports.at(-1)).toMatchObject({ state: "error" });
      await act(async () => publish?.({ type: "invalidate", quiet: true }));
      expect(retry).not.toHaveBeenCalled();
      expect(view.reports.at(-1)).toMatchObject({ state: "error" });
      await act(async () => {
        await view.reports.at(-1)?.retry?.();
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(view.reports.at(-1)).toMatchObject({ state: "ready" });
      expect(view.row("ready")).toBeTruthy();
    } finally {
      await view.cleanup();
    }
  });

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

  it("indicates every matching row while keeping one keyboard starting row", async () => {
    const view = await mount({
      source: memorySource([
        { id: "first", label: "First", url: "file:docs/a.md" },
        {
          id: "second",
          label: "Second",
          url: "file:docs/a.md",
          contextualIndicator: "icon",
        },
        {
          id: "quiet",
          label: "Quiet",
          url: "file:docs/a.md",
          contextualIndicator: "none",
        },
      ]),
      surface: { kind: "editor", path: "docs/a.md" },
    });
    try {
      expect(view.row("first")?.getAttribute("data-contextual")).toBe("row");
      expect(view.row("second")?.getAttribute("data-contextual")).toBe("icon");
      expect(view.row("quiet")?.getAttribute("data-contextual")).toBe("none");
      expect(
        view.node.querySelectorAll('[role="treeitem"][aria-selected="true"]'),
      ).toHaveLength(1);
    } finally {
      await view.cleanup();
    }
  });

  it("passes surface and chat context without a visibility predicate", async () => {
    chat.fields = { id: "s1", title: "Plan", metadata: { todo: "milk" } };
    const seen: Array<{ session?: unknown; surface?: unknown }> = [];
    const source = memorySource([], {
      load: async ({ session, surface }) => {
        seen.push({ session, surface });
        return { items: [] };
      },
    });
    const surface = { kind: "browser", key: "browser:docs", sessionId: "s1" };
    const view = await mount({ source, surface });
    try {
      expect(seen.at(-1)).toEqual({ session: chat.fields, surface });
    } finally {
      await view.cleanup();
    }
  });

  it("keeps inline, overflow and context menus independent through overrides", async () => {
    const calls: string[] = [];
    const view = await mount({
      section: {
        id: "things",
        source: ".work/things.ts",
        itemDefaults: { contextMenu: [] },
        itemOverrides: { todo: { descriptionVisibility: "hover", menu: [] } },
      },
      source: memorySource(
        [
          {
            id: "todo",
            label: "Milk",
            description: "Tomorrow",
            menu: [{ label: "Rename", action: "rename" }],
            actions: [{ label: "Done", action: "done", icon: "Check" }],
          },
        ],
        {
          action: async ({ action }) => {
            calls.push(action);
          },
        },
      ),
    });
    try {
      expect(
        view.row("todo")?.querySelector('[aria-haspopup="menu"]'),
      ).toBeNull();
      expect(
        view.row("todo")?.querySelector('[data-description-visibility="hover"]')
          ?.textContent,
      ).toBe("Tomorrow");
      await act(async () =>
        view
          .row("todo")
          ?.querySelector<HTMLButtonElement>('[aria-label="Done"]')
          ?.click(),
      );
      expect(calls).toEqual(["done"]);
      await act(async () =>
        view
          .row("todo")
          ?.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
          ),
      );
      expect(document.querySelector('[role="menu"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it("dispatches layout-provided actions and open modes to an addressless source row", async () => {
    const requests: Array<{ action: string; mode?: string }> = [];
    const view = await mount({
      section: {
        id: "things",
        source: ".work/tasks.ts",
        itemDefaults: {
          actions: [
            { label: "Complete", action: "complete", icon: "Check" },
            { label: "Open beside", action: "open-side", icon: "Columns2" },
          ],
        },
      },
      source: memorySource([{ id: "todo", label: "Milk" }], {
        action: async ({ action, mode }) => {
          requests.push({ action, mode });
          return undefined;
        },
      }),
    });
    try {
      const complete = view
        .row("todo")
        ?.querySelector<HTMLButtonElement>('[aria-label="Complete"]');
      const beside = view
        .row("todo")
        ?.querySelector<HTMLButtonElement>('[aria-label="Open beside"]');
      expect(complete?.disabled).toBe(false);
      expect(beside?.disabled).toBe(false);
      await act(async () => complete?.click());
      await act(async () => beside?.click());
      expect(requests).toEqual([
        { action: "complete", mode: undefined },
        { action: "open", mode: "side" },
      ]);
      expect(view.node.querySelector('[role="alert"]')).toBeNull();
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
      expect(actions).toEqual([{ itemId: "change", action: "open" }]);
      expect(opened).toEqual(["file:README.md"]);
    } finally {
      await view.cleanup();
    }
  });

  it("clears a section error only after different source code loads successfully", async () => {
    let publish:
      | ((change: CollectionChange<SidebarSourceItem>) => void)
      | undefined;
    let loadedRevision = "first";
    let nextRevision = "first";
    let failing = false;
    const source = memorySource([{ id: "todo", label: "Milk" }], {
      revision: () => loadedRevision,
      load: async () => {
        if (failing) throw new Error("Reload failed");
        loadedRevision = nextRevision;
        return { items: [{ id: "todo", label: "Milk" }] };
      },
      action: async () => {
        throw new Error("Old action failed");
      },
      subscribe: (next) => {
        publish = next;
        return () => {};
      },
    });
    const view = await mount({ source });
    try {
      await act(async () =>
        view
          .row("todo")
          ?.querySelector<HTMLButtonElement>("[data-tree-primary]")
          ?.click(),
      );
      expect(view.node.textContent).toContain("Old action failed");
      await act(async () => publish?.({ type: "invalidate", quiet: true }));
      expect(view.node.textContent).toContain("Old action failed");
      nextRevision = "second";
      failing = true;
      await act(async () => publish?.({ type: "invalidate", quiet: true }));
      expect(view.node.textContent).toContain("Old action failed");
      failing = false;
      await act(async () => publish?.({ type: "invalidate", quiet: true }));
      expect(view.node.textContent).not.toContain("Old action failed");
    } finally {
      await view.cleanup();
    }
  });

  it("drops an older revision's section error while its cached view is hidden", async () => {
    let loadedRevision = "first";
    const source = memorySource([{ id: "todo", label: "Milk" }], {
      revision: () => loadedRevision,
      action: async () => {
        throw new Error("Old action failed");
      },
    });
    const view = await mount({ source });
    try {
      await act(async () =>
        view
          .row("todo")
          ?.querySelector<HTMLButtonElement>("[data-tree-primary]")
          ?.click(),
      );
      expect(view.node.textContent).toContain("Old action failed");
      await view.show(false);
      loadedRevision = "second";
      await view.show(false);
      expect(view.node.textContent).not.toContain("Old action failed");
    } finally {
      await view.cleanup();
    }
  });

  it("clears an inline action's error after revised code loads without remounting its row", async () => {
    let loadedRevision = "first";
    let nextRevision = "first";
    let publish:
      | ((change: CollectionChange<SidebarSourceItem>) => void)
      | undefined;
    const row: SidebarSourceItem = {
      id: "todo",
      label: "Milk",
      actions: [{ label: "Done", action: "done", icon: "Check" }],
    };
    const source = memorySource([row], {
      revision: () => loadedRevision,
      load: async () => {
        loadedRevision = nextRevision;
        return { items: [row] };
      },
      action: async () => {
        throw new Error("Old inline action failed");
      },
      subscribe: (next) => {
        publish = next;
        return () => {};
      },
    });
    const view = await mount({ source });
    try {
      const originalRow = view.row("todo");
      await act(async () =>
        originalRow
          ?.querySelector<HTMLButtonElement>('[aria-label="Done"]')
          ?.click(),
      );
      expect(originalRow?.textContent).toContain("Old inline action failed");
      await act(async () => publish?.({ type: "invalidate", quiet: true }));
      expect(originalRow?.textContent).toContain("Old inline action failed");
      nextRevision = "second";
      await act(async () => publish?.({ type: "invalidate", quiet: true }));
      expect(view.row("todo")).toBe(originalRow);
      expect(originalRow?.textContent).not.toContain(
        "Old inline action failed",
      );
    } finally {
      await view.cleanup();
    }
  });

  it("asks for an action's values first and says what happened", async () => {
    const actions: Array<{
      action: string;
      values?: import("@catamorphic/work-customization").SidebarInputValues;
    }> = [];
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

  it("makes an empty list's sentence its place to drop, before and through a drag", async () => {
    let publish:
      | ((change: CollectionChange<SidebarSourceItem>) => void)
      | undefined;
    const source = memorySource([], {
      drop: async () => {},
      subscribe: (next) => {
        publish = next;
        return () => {};
      },
    });
    const view = await mount({ source });
    const place = () => view.node.querySelector('[data-drop-zone="things"]');
    try {
      // There before any drag: a drag never adds space to the sidebar.
      expect(place()?.textContent).toBe("No things.");
      const before = place();
      await act(async () => {
        const start = new Event("dragstart", { bubbles: true });
        Object.assign(start, {
          dataTransfer: { types: [TAB_DRAG_TYPE], getData: () => "" },
        });
        document.dispatchEvent(start);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(place()).toBe(before);
      // A read again keeps it under the pointer.
      const reads: Array<() => void> = [];
      source.load = () =>
        new Promise((resolve) => {
          reads.push(() => resolve({ items: [] }));
        });
      await act(async () => publish?.({ type: "invalidate" }));
      expect(reads).toHaveLength(1);
      expect(place()).toBeTruthy();
      await act(async () => reads[0]?.());
      expect(place()).toBeTruthy();
    } finally {
      await view.cleanup();
    }
  });

  it("retains rows, expansion and focus while rebinding one active subscription to current chat context", async () => {
    const seen: Array<{
      parentId: string | null;
      session?: string;
      surface?: string;
    }> = [];
    let active = 0;
    let mostActive = 0;
    const bindings: Array<{ session?: string; surface?: string }> = [];
    const listeners = new Map<string, () => void>();
    const stop = vi.fn();
    const subscribe: NonNullable<SectionSource["subscribe"]> = (
      publish,
      context,
    ) => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      bindings.push({
        session: context.session?.id,
        surface: context.surface?.kind,
      });
      const key = context.session?.id ?? "none";
      listeners.set(key, () =>
        publish({ type: "invalidate", parentId: null, quiet: true }),
      );
      return () => {
        stop(key);
        active -= 1;
        listeners.delete(key);
      };
    };
    const source = memorySource([], {
      subscribe,
      load: async ({ parentId, session, surface }) => {
        seen.push({ parentId, session: session?.id, surface: surface?.kind });
        return {
          items:
            parentId === null
              ? [{ id: "folder", label: "Tasks", hasChildren: true }]
              : [
                  {
                    id: "task",
                    parentId: "folder",
                    label: "Task",
                    description: session?.title ?? surface?.kind,
                    url: "file:task.md",
                  },
                ],
        };
      },
    });
    const view = await mount({ source, surface: { kind: "browser" } });
    try {
      await act(async () =>
        view
          .row("folder")
          ?.querySelector<HTMLButtonElement>("[data-row-disclosure]")
          ?.click(),
      );
      const folder = view.row("folder");
      const task = view.row("task");
      const primary = task?.querySelector<HTMLButtonElement>(
        "[data-tree-primary]",
      );
      expect(task).not.toBeNull();
      await act(async () => primary?.focus());
      const contexts: Array<{
        fields: typeof chat.fields;
        surface: SidebarSurface;
        description: string;
      }> = [
        {
          fields: { id: "s1", title: "First chat", metadata: {} },
          surface: { kind: "chat", sessionId: "s1" },
          description: "First chat",
        },
        {
          fields: { id: "s2", title: "Second chat", metadata: {} },
          surface: { kind: "editor", sessionId: "s2" },
          description: "Second chat",
        },
        { fields: null, surface: { kind: "browser" }, description: "browser" },
      ];
      for (const context of contexts) {
        const start = seen.length;
        chat.fields = context.fields;
        await view.context(context.surface);
        expect(view.row("folder")).toBe(folder);
        expect(view.row("task")).toBe(task);
        expect(document.activeElement).toBe(primary);
        expect(
          folder
            ?.querySelector("[data-row-disclosure]")
            ?.getAttribute("aria-expanded"),
        ).toBe("true");
        expect(task?.textContent).toContain(context.description);
        expect(active).toBe(1);
        expect(mostActive).toBe(1);
        expect(bindings.at(-1)).toEqual({
          session: context.fields?.id,
          surface: context.surface.kind,
        });
        expect([...listeners.keys()]).toEqual([context.fields?.id ?? "none"]);
        expect(stop).toHaveBeenCalledTimes(bindings.length - 1);
        expect(seen.slice(start)).toEqual([
          {
            parentId: null,
            session: context.fields?.id,
            surface: context.surface.kind,
          },
          {
            parentId: "folder",
            session: context.fields?.id,
            surface: context.surface.kind,
          },
        ]);
      }
    } finally {
      await view.cleanup();
    }
    expect(active).toBe(0);
    expect(listeners.size).toBe(0);
    expect(bindings).toEqual([
      { session: undefined, surface: "browser" },
      { session: "s1", surface: "chat" },
      { session: "s2", surface: "editor" },
      { session: undefined, surface: "browser" },
    ]);
    expect(stop.mock.calls.map(([key]) => key)).toEqual([
      "none",
      "s1",
      "s2",
      "none",
    ]);
  });

  it("keeps explicit session-scoped collections apart while the next chat's fields load", async () => {
    const seen: string[] = [];
    const stop = vi.fn();
    const subscribe = vi.fn(() => stop);
    const source = memorySource([], {
      subscribe,
      load: async ({ session }) => {
        if (!session) throw new Error("Missing session");
        seen.push(session.id);
        return { items: [{ id: "task", label: session.title ?? session.id }] };
      },
    });
    chat.fields = { id: "s1", title: "First task", metadata: {} };
    const view = await mount({
      source,
      section: {
        id: "tasks",
        source: ".work/tasks.ts",
        when: { session: true },
      },
      surface: { kind: "chat", sessionId: "s1" },
    });
    try {
      expect(view.row("task")?.textContent).toBe("First task");
      const first = view.row("task");
      const start = seen.length;
      chat.fields = null;
      await view.context({ kind: "chat", sessionId: "s2" });
      expect(seen.slice(start)).toEqual([]);
      expect(view.row("task")).not.toBe(first);
      expect(view.node.textContent).not.toContain("First task");
      chat.fields = { id: "s2", title: "Second task", metadata: {} };
      await view.context({ kind: "chat", sessionId: "s2" });
      expect(seen.slice(start).every((id) => id === "s2")).toBe(true);
      expect(view.row("task")?.textContent).toBe("Second task");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      await view.cleanup();
    }
  });

  it("runs a session-scoped source only with its chat, and hands it the chat", async () => {
    chat.error = new Error("Session not found");
    const retry = vi.fn(async () => {});
    const failing = memorySource([], { retry });
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
      await act(async () => {
        await first.reports.at(-1)?.retry?.();
      });
      expect(chat.refetch).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
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
