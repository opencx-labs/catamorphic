// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleSidebarContent } from "./sidebar-transition.js";

interface FakeTransition {
  nameAtStart: string;
  finish: () => void;
}

describe("settleSidebarContent", () => {
  let row: HTMLElement;
  let sidebar: HTMLElement;
  let content: HTMLElement;
  let anchor: HTMLElement;
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
  const shift = () =>
    document.documentElement.style.getPropertyValue("--content-shift");

  beforeEach(() => {
    document.body.innerHTML = `<div data-workspace-visible="true"><div><aside></aside><main class="workspace-surface"><div></div></main></div></div>`;
    row = document.querySelector("main")?.parentElement ?? document.body;
    sidebar = row.querySelector("aside") ?? document.body;
    content = row.querySelector("main") ?? document.body;
    anchor = content.querySelector("div") ?? document.body;
    resized = false;
    // The content box gives 200px to the sidebar; its centred column moves
    // 100px within it.
    Reflect.set(content, "getBoundingClientRect", () =>
      resized ? rect(200, 800) : rect(0, 1000),
    );
    Reflect.set(anchor, "getBoundingClientRect", () =>
      resized ? rect(400, 400) : rect(300, 400),
    );
    Reflect.set(document, "elementFromPoint", () => anchor);
    transitions = [];
    Reflect.set(document, "startViewTransition", (update: () => void) => {
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      transitions.push({
        nameAtStart: content.style.viewTransitionName,
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
    Reflect.deleteProperty(document, "elementFromPoint");
    document.documentElement.style.removeProperty("--content-shift");
    document.body.innerHTML = "";
  });

  const update = vi.fn(() => {
    resized = true;
  });
  beforeEach(() => update.mockClear());

  it("morphs the visible content by how far its column moves, then clears up", async () => {
    settleSidebarContent({ sidebar, wanted: () => true, update });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.nameAtStart).toBe("workspace-content");
    // The column was 300px into the box and is 200px into it now.
    expect(shift()).toBe("-100px");
    transitions[0]?.finish();
    await vi.waitFor(() => expect(content.style.viewTransitionName).toBe(""));
    expect(shift()).toBe("");
  });

  it("applies at once in a workspace that is not showing", () => {
    sidebar
      .closest("[data-workspace-visible]")
      ?.setAttribute("data-workspace-visible", "false");
    settleSidebarContent({ sidebar, wanted: () => true, update });
    expect(update).toHaveBeenCalledTimes(1);
    expect(transitions).toHaveLength(0);
  });

  it("applies without a transition once the sidebar has moved again", async () => {
    settleSidebarContent({ sidebar, wanted: () => false, update });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(transitions).toHaveLength(0);
  });

  it("keeps the newer transition's name when an older one finishes", async () => {
    settleSidebarContent({ sidebar, wanted: () => true, update });
    await vi.waitFor(() => expect(transitions).toHaveLength(1));
    settleSidebarContent({ sidebar, wanted: () => true, update });
    await vi.waitFor(() => expect(transitions).toHaveLength(2));
    // Starting the second skipped the first; its end must not unname the
    // content the second is animating.
    await Promise.resolve();
    expect(content.style.viewTransitionName).toBe("workspace-content");
    transitions[1]?.finish();
    await vi.waitFor(() => expect(content.style.viewTransitionName).toBe(""));
  });

  it("still settles beside a page that cannot answer", async () => {
    const page = document.createElement("webview");
    Reflect.set(page, "checkVisibility", () => true);
    Reflect.set(page, "getBoundingClientRect", () => rect(0, 1000));
    Reflect.set(page, "executeJavaScript", () => {
      throw new Error("The WebView must be attached to the DOM");
    });
    content.append(page);
    settleSidebarContent({ sidebar, wanted: () => true, update });
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // Assumed centred: half of the 200px the box gave up.
    expect(shift()).toBe("-100px");
  });
});
