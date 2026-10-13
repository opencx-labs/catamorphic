// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { SidebarSurface, SidebarTabConfig } from "../../shared/sidebar.js";
import type { WorkspaceConfig } from "../../shared/workspace-config.js";
import type { SidebarContentState } from "./sidebar-contribution.js";
import { TabbedSidebar } from "./tabbed-sidebar.js";

it("reports an empty section as invisible even when another section keeps its tab selected", async () => {
  function Empty({
    visible,
    report,
  }: {
    visible: boolean;
    report: (state: SidebarContentState) => void;
  }) {
    useEffect(() => report("empty"), [report]);
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
                { id: "empty", type: "app", app: "widget", hideEmpty: true },
                { id: "other", type: "custom" },
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
    report: (state: SidebarContentState) => void;
  }) {
    useEffect(() => report("empty"), [report]);
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
                { id: "changes", type: "git", hideEmpty: true },
                { id: "other", type: "custom" },
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
  report: (state: SidebarContentState) => void;
}) {
  useEffect(() => report(state), [state, report]);
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
          sections: [{ id: "children", type: "subsessions", hideEmpty: true }],
        },
        {
          id: "all",
          title: "Always",
          sections: [{ id: "links", type: "custom" }],
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
    // It collapses first (inert at once), then hides once the motion ends.
    expect(widget?.hasAttribute("inert")).toBe(true);
    expect(
      widget
        ?.querySelector("[data-collapsible]")
        ?.getAttribute("data-collapsible"),
    ).toBe("closed");
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(widget?.hasAttribute("hidden")).toBe(true);
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
                  sections: [{ id: "list", type: "custom" }],
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

describe("contextual tabs (ADR 0225)", () => {
  const tabs: SidebarTabConfig[] = [
    {
      id: "this-session",
      title: "This session",
      icon: "MessageSquareText",
      sections: [
        {
          id: "session",
          type: "session",
          when: { surface: ["chat"], session: true },
        },
      ],
    },
    {
      id: "companion",
      title: "Activity",
      sections: [{ id: "links", type: "custom" }],
    },
  ];
  const chat: SidebarSurface = { kind: "chat", sessionId: "s1" };
  const page: SidebarSurface = { kind: "browser" };

  async function mount(scope: string) {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const render = (surface: SidebarSurface) =>
      act(async () =>
        root.render(
          <TabbedSidebar
            side="right"
            scope={scope}
            open
            tabs={tabs}
            surface={surface}
            onCustomize={() => {}}
            renderSection={(section) => <span>{section.id} rows</span>}
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
    const settle = () =>
      act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    const cleanup = async () => {
      await act(async () => root.unmount());
      node.remove();
    };
    return { node, render, tab, selected, settle, cleanup };
  }

  it("arrives beside a chat without taking the panel, and leaves the way it came", async () => {
    localStorage.clear();
    const view = await mount("arrive");
    try {
      // A chat in front at first sight still opens on the tab that stays.
      await view.render(chat);
      expect(view.tab("This session")).toBeTruthy();
      expect(view.selected()).toBe("Activity");
      await view.render(page);
      expect(view.node.querySelector('[role="tablist"]')).toBeNull();
      // The strip opens and the tab grows in; the panel stays where it was.
      await view.render(chat);
      const strip = view.node.querySelector('[role="tablist"]')?.parentElement;
      expect(strip?.className).toContain("animate-sidebar-strip-in");
      expect(view.tab("This session")?.className).toContain(
        "animate-sidebar-tab-icon-in",
      );
      expect(view.tab("Activity")?.className).not.toContain(
        "animate-sidebar-tab-icon-in",
      );
      expect(view.selected()).toBe("Activity");
      await view.settle();
      expect(view.tab("This session")?.className).not.toContain("animate-");
      expect(strip?.className).not.toContain("animate-");
      // Leaving: no longer a tab at once, while what it showed folds away.
      await view.render(page);
      expect(view.tab("This session")).toBeNull();
      expect(view.node.querySelector('[role="tablist"]')).toBeNull();
      const leaving = view.node.querySelector("[data-sidebar-strip-leaving]");
      expect(leaving?.className).toContain("animate-sidebar-strip-out");
      expect(leaving?.getAttribute("aria-hidden")).toBe("true");
      expect(
        leaving?.querySelector(".animate-sidebar-tab-icon-out"),
      ).toBeTruthy();
      await view.settle();
      expect(
        view.node.querySelector("[data-sidebar-strip-leaving]"),
      ).toBeNull();
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
      // One tab left: no strip, its panel shown, and the swap cross-fades.
      expect(aside?.getAttribute("data-tab-motion")).toBe("true");
      const panels = [...view.node.querySelectorAll('[role="tabpanel"]')];
      expect(panels.map((panel) => panel.hasAttribute("hidden"))).toEqual([
        true,
        false,
      ]);
      // The person's choice comes back with the chat.
      await view.render(chat);
      expect(view.selected()).toBe("This session");
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
      expect(
        view.node.querySelector("[data-sidebar-strip-leaving]"),
      ).toBeNull();
    } finally {
      window.matchMedia = original;
      await view.cleanup();
    }
  });
});
