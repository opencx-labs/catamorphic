// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { SidebarConfig, SidebarSurface } from "../../shared/sidebar.js";
import type { SidebarContentState } from "./sidebar-contribution.js";
import { TabbedSidebar } from "./tabbed-sidebar.js";

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
  const config: SidebarConfig = {
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
  };
  const render = async (surface: SidebarSurface, state: SidebarContentState) =>
    act(async () =>
      root.render(
        <TabbedSidebar
          side="right"
          scope="test"
          open
          tabs={config.right}
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
    expect(
      node
        .querySelector('[data-sidebar-widget="children"]')
        ?.hasAttribute("hidden"),
    ).toBe(true);
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
