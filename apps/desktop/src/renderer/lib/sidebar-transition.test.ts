// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleSidebarContent } from "./sidebar-transition.js";

interface FakeTransition {
  nameAtStart: string;
  settlingAtStart: boolean;
  finish: () => void;
}

describe("settleSidebarContent", () => {
  let sidebar: HTMLElement;
  let content: HTMLElement;
  let transitions: FakeTransition[];
  let resized: boolean;

  const rect = (left: number, width: number) => ({
    left,
    right: left + width,
    top: 0,
    bottom: 600,
    width,
    height: 600,
    x: left,
    y: 0,
    toJSON: () => ({}),
  });
  const from = (axis: "x" | "y") =>
    document.documentElement.style.getPropertyValue(`--content-from-${axis}`);

  beforeEach(() => {
    document.body.innerHTML = `<div data-workspace-visible="true"><div><aside></aside><main class="workspace-surface"></main></div></div>`;
    const row = document.querySelector("main")?.parentElement ?? document.body;
    sidebar = row.querySelector("aside") ?? document.body;
    content = row.querySelector("main") ?? document.body;
    resized = false;
    // The sidebar opens: the content box gives it 200px on the left.
    Reflect.set(content, "getBoundingClientRect", () =>
      resized ? rect(200, 800) : rect(0, 1000),
    );
    transitions = [];
    Reflect.set(document, "startViewTransition", (update: () => void) => {
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      transitions.push({
        nameAtStart: content.style.viewTransitionName,
        settlingAtStart: "contentSettling" in document.documentElement.dataset,
        finish,
      });
      update();
      return {
        ready: Promise.resolve(),
        finished,
        updateCallbackDone: Promise.resolve(),
        skipTransition: () => finish(),
      };
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    document.documentElement.style.removeProperty("--content-from-x");
    document.documentElement.style.removeProperty("--content-from-y");
    document.body.innerHTML = "";
  });

  const update = vi.fn(() => {
    resized = true;
  });
  beforeEach(() => update.mockClear());

  it("fades the visible content in place, keeping the old snapshot where it was, then clears up", async () => {
    settleSidebarContent({ sidebar, wanted: () => true, update });
    expect(update).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.nameAtStart).toBe("workspace-content");
    // The chats over the content take layers of their own meanwhile.
    expect(transitions[0]?.settlingAtStart).toBe(true);
    // The box moved 200px right; the old snapshot is drawn 200px back.
    expect(from("x")).toBe("-200px");
    expect(from("y")).toBe("0px");
    transitions[0]?.finish();
    await vi.waitFor(() => expect(content.style.viewTransitionName).toBe(""));
    expect(from("x")).toBe("");
    expect("contentSettling" in document.documentElement.dataset).toBe(false);
  });

  it("applies at once in a workspace that is not showing", () => {
    sidebar
      .closest("[data-workspace-visible]")
      ?.setAttribute("data-workspace-visible", "false");
    settleSidebarContent({ sidebar, wanted: () => true, update });
    expect(update).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(0);
  });

  it("applies without a transition once the sidebar has moved again", () => {
    settleSidebarContent({ sidebar, wanted: () => false, update });
    expect(update).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(0);
  });

  it("keeps the newer transition's name when an older one finishes", async () => {
    settleSidebarContent({ sidebar, wanted: () => true, update });
    settleSidebarContent({ sidebar, wanted: () => true, update });
    expect(transitions).toHaveLength(2);
    // Starting the second skipped the first; its end must not unname the
    // content the second is animating.
    await Promise.resolve();
    expect(content.style.viewTransitionName).toBe("workspace-content");
    transitions[1]?.finish();
    await vi.waitFor(() => expect(content.style.viewTransitionName).toBe(""));
  });
});
