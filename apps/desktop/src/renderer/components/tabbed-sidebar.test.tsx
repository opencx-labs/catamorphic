// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { SidebarSurface } from "../../shared/sidebar.js";
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
    expect(
      node.querySelector('[role="tab"][aria-label="Chat tools"]'),
    ).toBeTruthy();
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
  const getAnimations = HTMLElement.prototype.getAnimations;
  Reflect.set(globalThis, "CSSTransition", SlideTransition);
  HTMLElement.prototype.getAnimations = function (this: HTMLElement) {
    if (!this.classList.contains("sidebar-inner")) return [];
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return [new SlideTransition(finished) as unknown as Animation];
  };
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
    HTMLElement.prototype.getAnimations = getAnimations;
    Reflect.deleteProperty(globalThis, "CSSTransition");
  }
});
