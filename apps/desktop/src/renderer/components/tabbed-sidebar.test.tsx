// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { SidebarSurface, SidebarTabConfig } from "../../shared/sidebar.js";
import type { WorkspaceConfig } from "../../shared/workspace-config.js";
import type { SidebarContentState } from "./sidebar-contribution.js";
import { TabbedSidebar } from "./tabbed-sidebar.js";

// The panel's scroll position (overlay-scrollbar.tsx) follows its size.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

it("reports an empty section as invisible even when another section keeps its tab selected", async () => {
  function Empty({
    visible,
    report,
  }: {
    visible: boolean;
    report: (state: SidebarContentState, droppable: boolean) => void;
  }) {
    useEffect(() => report("empty", false), [report]);
    return <span data-testid="empty-widget" data-visible={visible} />;
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <TabbedSidebar
          side="right"
          scope="empty-test"
          open
          tabs={[
            {
              id: "shared",
              title: "Shared",
              sections: [
                { id: "empty", app: "widget", hideEmpty: true },
                { id: "other", items: [] },
              ],
            },
          ]}
          onCustomize={() => {}}
          renderSection={(section, visible, report) =>
            section.id === "empty" ? (
              <Empty visible={visible} report={report} />
            ) : (
              <span>Other section</span>
            )
          }
        />,
      ),
    );
    expect(
      node
        .querySelector("[data-testid=empty-widget]")
        ?.getAttribute("data-visible"),
    ).toBe("false");
    expect(node.textContent).toContain("Other section");
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});

it("asks a section hidden for being empty to keep observing", async () => {
  const seen: Array<{ visible: boolean; observeEmpty: boolean }> = [];
  function Empty({
    visible,
    observeEmpty,
    report,
  }: {
    visible: boolean;
    observeEmpty: boolean;
    report: (state: SidebarContentState, droppable: boolean) => void;
  }) {
    useEffect(() => report("empty", false), [report]);
    seen.push({ visible, observeEmpty });
    return null;
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <TabbedSidebar
          side="right"
          scope="observe-test"
          open
          tabs={[
            {
              id: "shared",
              title: "Shared",
              sections: [
                { id: "changes", source: "work:git", hideEmpty: true },
                { id: "other", items: [] },
              ],
            },
          ]}
          onCustomize={() => {}}
          renderSection={(section, visible, report, _relevant, observeEmpty) =>
            section.id === "changes" ? (
              <Empty
                visible={visible}
                observeEmpty={observeEmpty}
                report={report}
              />
            ) : (
              <span>Other section</span>
            )
          }
        />,
      ),
    );
    // Hidden as empty, yet still asked to observe; never both at once.
    expect(seen.at(-1)).toEqual({ visible: false, observeEmpty: true });
    expect(seen.every((entry) => !(entry.visible && entry.observeEmpty))).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});

function Probe({
  state,
  report,
}: {
  state: SidebarContentState;
  report: (state: SidebarContentState, droppable: boolean) => void;
}) {
  useEffect(() => report(state, false), [state, report]);
  return <input aria-label="Retained widget draft" defaultValue="Draft" />;
}
it("separates relevance and content states while preserving a hidden widget and tab preference", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const config: WorkspaceConfig = {
    sidebars: {
      left: [],
      right: [
        {
          id: "chat",
          title: "Chat tools",
          when: { surface: ["chat"], session: true },
          sections: [
            {
              id: "children",
              source: "work:subsessions",
              when: { session: true },
              hideEmpty: true,
            },
          ],
        },
        {
          id: "all",
          title: "Always",
          sections: [{ id: "links", items: [] }],
        },
      ],
    },
  };
  const render = async (surface: SidebarSurface, state: SidebarContentState) =>
    act(async () =>
      root.render(
        <TabbedSidebar
          side="right"
          scope="test"
          open
          tabs={config.sidebars.right}
          surface={surface}
          onCustomize={() => {}}
          renderSection={(section, _visible, report) =>
            section.id === "children" ? (
              <Probe state={state} report={report} />
            ) : (
              <span>Always available</span>
            )
          }
        />,
      ),
    );
  try {
    await render({ kind: "chat", sessionId: "a" }, "loading");
    // The person picks the contextual tab: the choice outlives its absence.
    const chatTools = node.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-label="Chat tools"]',
    );
    expect(chatTools).toBeTruthy();
    await act(async () => chatTools?.click());
    const input = node.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing widget");
    input.value = "Preserved";
    await render({ kind: "chat", sessionId: "a" }, "empty");
    const widget = node.querySelector('[data-sidebar-widget="children"]');
    // Its only section emptied, so the tab leaves: the panel fades out as it
    // was, the section inert at once but not folding while it goes (ADR 0226).
    expect(widget?.hasAttribute("inert")).toBe(true);
    expect(
      widget
        ?.querySelector("[data-collapsible]")
        ?.getAttribute("data-collapsible"),
    ).toBe("open");
    expect(widget?.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(
      true,
    );
    await render({ kind: "chat", sessionId: "a" }, "error");
    expect(
      node.querySelector(
        '[role="tab"][aria-label="Chat tools"][aria-selected="true"]',
      ),
    ).toBeTruthy();
    input.focus();
    await render({ kind: "editor", path: "notes.md" }, "ready");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Always");
    expect(
      node.querySelector('[role="tab"][aria-label="Chat tools"]'),
    ).toBeNull();
    await render({ kind: "chat", sessionId: "a" }, "ready");
    expect(node.querySelector("input")).toBe(input);
    expect(input.value).toBe("Preserved");
    expect(
      node.querySelector(
        '[role="tab"][aria-label="Chat tools"][aria-selected="true"]',
      ),
    ).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});

it("keeps its sections live while the panel slides away, on either side", async () => {
  // jsdom runs no transitions: stand in for the panel's transform slide.
  class SlideTransition {
    transitionProperty = "transform";
    constructor(readonly finished: Promise<void>) {}
  }
  let finish = () => {};
  // jsdom has no getAnimations; whatever was there is put back afterwards.
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getAnimations",
  );
  Reflect.set(globalThis, "CSSTransition", SlideTransition);
  Reflect.set(
    HTMLElement.prototype,
    "getAnimations",
    function (this: HTMLElement) {
      if (!this.classList.contains("sidebar-inner")) return [];
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return [new SlideTransition(finished)];
    },
  );
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  try {
    for (const side of ["left", "right"] as const) {
      const seen: boolean[] = [];
      const node = document.createElement("div");
      document.body.append(node);
      const root = createRoot(node);
      const render = (open: boolean) =>
        act(async () =>
          root.render(
            <TabbedSidebar
              side={side}
              scope={`slide-${side}`}
              open={open}
              tabs={[
                {
                  id: "only",
                  title: "Only",
                  sections: [{ id: "list", items: [] }],
                },
              ]}
              onCustomize={() => {}}
              renderSection={(_section, visible) => {
                seen.push(visible);
                return <span>Rows</span>;
              }}
            />,
          ),
        );
      try {
        await render(true);
        expect(seen.at(-1)).toBe(true);
        await render(false);
        // Sliding away: still shown, still live.
        expect(node.querySelector("aside")?.getAttribute("data-motion")).toBe(
          "closing",
        );
        expect(seen.at(-1)).toBe(true);
        await act(async () => finish());
        expect(node.querySelector("aside")?.getAttribute("data-motion")).toBe(
          "closed",
        );
        expect(seen.at(-1)).toBe(false);
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    }
  } finally {
    if (original)
      Object.defineProperty(HTMLElement.prototype, "getAnimations", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    Reflect.deleteProperty(globalThis, "CSSTransition");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  }
});

describe("contextual tabs (ADR 0226)", () => {
  const tabs: SidebarTabConfig[] = [
    {
      id: "this-session",
      title: "This session",
      icon: "MessageSquareText",
      sections: [
        { id: "session", source: "work:session", when: { session: true } },
      ],
    },
    {
      id: "companion",
      title: "Activity",
      sections: [{ id: "links", items: [] }],
    },
  ];
  const chat: SidebarSurface = { kind: "chat", sessionId: "s1" };
  const page: SidebarSurface = { kind: "browser" };
  // A page the chat opened: the chat's session stays beside it.
  const chatsPage: SidebarSurface = { kind: "browser", sessionId: "s1" };

  async function mount(scope: string) {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const render = (
      surface: SidebarSurface,
      opts: { tabs?: SidebarTabConfig[]; headerActions?: boolean } = {},
    ) =>
      act(async () =>
        root.render(
          <TabbedSidebar
            side="right"
            scope={scope}
            open
            tabs={opts.tabs ?? tabs}
            surface={surface}
            headerActions={
              opts.headerActions ? <button type="button">Toggle</button> : false
            }
            onCustomize={() => {}}
            renderSection={(section) => (
              <button type="button">{section.id} rows</button>
            )}
          />,
        ),
      );
    const tab = (title: string) =>
      node.querySelector<HTMLButtonElement>(
        `[role="tab"][aria-label="${title}"]`,
      );
    const selected = () =>
      node
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("aria-label");
    const strip = () => node.querySelector(".sidebar-strip");
    const moving = () =>
      [
        ...node.querySelectorAll(
          ".sidebar-tab-slot-arriving, .sidebar-tab-slot-leaving, .sidebar-strip-arriving, .sidebar-strip-folding",
        ),
      ].length;
    const settle = () =>
      act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    const cleanup = async () => {
      await act(async () => root.unmount());
      node.remove();
    };
    return { node, render, tab, selected, strip, moving, settle, cleanup };
  }

  it("arrives beside a chat without taking the panel, and leaves the way it came", async () => {
    localStorage.clear();
    const view = await mount("arrive");
    try {
      // A chat in front at first sight still opens on the tab that stays,
      // and the first list shown does not move.
      await view.render(chat);
      expect(view.tab("This session")).toBeTruthy();
      expect(view.selected()).toBe("Activity");
      expect(view.moving()).toBe(0);
      // Leaving: no longer a tab at once, while its place and the strip
      // fold away; nothing in them takes focus or reads as tabs.
      await view.render(page);
      expect(view.tab("This session")).toBeNull();
      const folding = view.strip();
      expect(folding?.className).toContain("sidebar-strip-folding");
      expect(folding?.getAttribute("aria-hidden")).toBe("true");
      expect(
        view.node.querySelector('[data-sidebar-tab-leaving="this-session"]')
          ?.parentElement?.className,
      ).toContain("sidebar-tab-slot-leaving");
      await view.settle();
      expect(view.strip()).toBeNull();
      // Arriving: the strip opens and the tab grows into its place; the
      // panel stays where it was.
      await view.render(chat);
      expect(view.strip()?.className).toContain("sidebar-strip-arriving");
      expect(view.tab("This session")?.parentElement?.className).toContain(
        "sidebar-tab-slot-arriving",
      );
      expect(view.tab("Activity")?.parentElement?.className).not.toContain(
        "sidebar-tab-slot-arriving",
      );
      expect(view.selected()).toBe("Activity");
      await view.settle();
      expect(view.moving()).toBe(0);
      // A page the chat opened keeps it.
      await view.render(chatsPage);
      expect(view.tab("This session")).toBeTruthy();
      expect(view.moving()).toBe(0);
    } finally {
      await view.cleanup();
    }
  });

  it("reverses a quick change back on the same elements", async () => {
    localStorage.clear();
    const view = await mount("reverse");
    try {
      await view.render(chat);
      await view.settle();
      const button = view.tab("This session");
      const strip = view.strip();
      await view.render(page);
      // Still the same elements, now leaving and folding.
      expect(view.node.querySelector("[data-sidebar-tab-leaving]")).toBe(
        button,
      );
      expect(view.strip()).toBe(strip);
      await view.render(chat);
      expect(view.tab("This session")).toBe(button);
      expect(view.strip()).toBe(strip);
      expect(button?.parentElement?.className).not.toContain(
        "sidebar-tab-slot-leaving",
      );
      expect(strip?.className).not.toContain("sidebar-strip-folding");
      await view.settle();
      expect(view.tab("This session")).toBe(button);
      expect(view.moving()).toBe(0);
    } finally {
      await view.cleanup();
    }
  });

  it("moves only for a change to tabs already shown, never on load or the sidebar's own opening", async () => {
    localStorage.clear();
    const view = await mount("load");
    try {
      // The workspace file arriving: the first tabs shown do not grow in.
      await view.render(chat, { tabs: [] });
      await view.render(chat);
      expect(view.moving()).toBe(0);
      // One tab, its strip held up by the sidebar's own controls (as the
      // right sidebar's toggle comes with its opening): no strip motion.
      const one = [tabs[1] as SidebarTabConfig];
      await view.render(page, { tabs: one });
      await view.settle();
      await view.render(page, { tabs: one, headerActions: true });
      expect(view.strip()).toBeTruthy();
      expect(view.moving()).toBe(0);
      await view.render(page, { tabs: one });
      expect(view.strip()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it("falls back with the panels cross-fading when the tab in front leaves, and returns to it", async () => {
    localStorage.clear();
    localStorage.setItem(
      "catamorphic:sidebar:fallback:right",
      JSON.stringify({ width: 320, selected: "this-session" }),
    );
    const view = await mount("fallback");
    try {
      await view.render(chat);
      expect(view.selected()).toBe("This session");
      const aside = view.node.querySelector("aside");
      // First paint stays still.
      expect(aside?.getAttribute("data-tab-motion")).toBe("false");
      await view.render(page);
      expect(view.selected()).toBeUndefined();
      // One tab left: its panel shown, and the swap cross-fades.
      expect(aside?.getAttribute("data-tab-motion")).toBe("true");
      const panels = [...view.node.querySelectorAll('[role="tabpanel"]')];
      expect(panels.map((panel) => panel.hasAttribute("hidden"))).toEqual([
        true,
        false,
      ]);
      // The leaving panel fades as it was: its section does not fold too.
      expect(
        view.node
          .querySelector('[data-sidebar-widget="session"] [data-collapsible]')
          ?.getAttribute("data-collapsible"),
      ).toBe("open");
      // The person's choice comes back with the chat.
      await view.render(chat);
      expect(view.selected()).toBe("This session");
    } finally {
      await view.cleanup();
    }
  });

  it("keeps focus in the sidebar when the strip folds", async () => {
    localStorage.clear();
    const view = await mount("focus");
    try {
      await view.render(chat);
      await view.settle();
      view.tab("Activity")?.focus();
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Activity",
      );
      await view.render(page);
      // The tab folds away with its strip; focus goes to the panel shown.
      expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
      expect(document.activeElement?.hasAttribute("hidden")).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  it("changes at once under reduced motion", async () => {
    localStorage.clear();
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const view = await mount("reduced");
    try {
      await view.render(chat);
      await act(async () => {});
      await view.render(page);
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
      expect(view.strip()).toBeNull();
    } finally {
      window.matchMedia = original;
      await view.cleanup();
    }
  });
});

it("shows a hidden empty section that takes drops while something it takes is dragged", async () => {
  vi.useFakeTimers();
  function Pins({
    report,
  }: {
    report: (state: SidebarContentState, droppable: boolean) => void;
  }) {
    useEffect(() => report("empty", true), [report]);
    return <span>Drop a tab here</span>;
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const slot = () =>
    node.querySelector<HTMLElement>('[data-sidebar-widget="pinned"]');
  const drag = (type: string, types: string[]) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: { types } });
    document.dispatchEvent(event);
  };
  try {
    await act(async () =>
      root.render(
        <TabbedSidebar
          side="left"
          scope="drop-test"
          open
          tabs={[
            {
              id: "project",
              title: "Project",
              sections: [
                { id: "pinned", source: "work:pinned", hideEmpty: true },
                { id: "links", items: [] },
              ],
            },
          ]}
          onCustomize={() => {}}
          renderSection={(section, _visible, report) =>
            section.id === "pinned" ? <Pins report={report} /> : <span />
          }
        />,
      ),
    );
    // It empties, then collapses away.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(slot()?.hidden).toBe(true);
    // Something that is not a page, chat or row: nothing to take.
    await act(async () => {
      drag("dragstart", ["text/plain"]);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(slot()?.hidden).toBe(true);
    await act(async () => {
      drag("dragstart", ["application/x-catamorphic-tab"]);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(slot()?.hidden).toBe(false);
    await act(async () => {
      drag("dragend", []);
      await vi.advanceTimersByTimeAsync(400);
    });
    // It waits a moment for what was dropped to arrive.
    expect(slot()?.hidden).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(slot()?.hidden).toBe(true);
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.useRealTimers();
  }
});
