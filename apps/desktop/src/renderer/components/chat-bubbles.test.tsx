// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMenuEntry } from "../lib/chat-session-actions.js";
import { ChatBubbles } from "./chat-bubbles.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

function mount({
  menus = {},
}: {
  menus?: Record<string, ChatSessionMenuEntry[]>;
} = {}) {
  const onToggle = vi.fn();
  const onOpenAs = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <ChatBubbles
        entries={[{ localId: "a", mode: "min" }]}
        labels={{ a: "Launch plan" }}
        icons={{}}
        forks={{}}
        signals={{}}
        unread={{}}
        attention={{}}
        menus={menus}
        autoCollapse={false}
        folded={false}
        onFoldedChange={() => {}}
        onToggle={onToggle}
        onOpenAs={onOpenAs}
        onClose={() => {}}
        onMenuAction={() => {}}
        onNewChat={() => {}}
      />,
    );
  });
  const bubble = container.querySelector<HTMLButtonElement>(
    '[data-chat-bubble="a"] button[aria-label^="Open"]',
  );
  if (!bubble) throw new Error("bubble not rendered");
  return { bubble, container, onToggle, onOpenAs };
}

function click(target: HTMLElement, init: MouseEventInit) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("ChatBubbles open modifiers", () => {
  it("floats on a plain click and opens as a tab or to the side with the app's modifiers", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    const { bubble, onToggle, onOpenAs } = mount();
    click(bubble, {});
    expect(onToggle).toHaveBeenCalledWith("a");
    expect(onOpenAs).not.toHaveBeenCalled();

    click(bubble, { metaKey: true });
    expect(onOpenAs).toHaveBeenLastCalledWith("a", "tab");

    click(bubble, { metaKey: true, shiftKey: true });
    expect(onOpenAs).toHaveBeenLastCalledWith("a", "side");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("ChatBubbles context menu", () => {
  const archiveMenu = () =>
    [...document.querySelectorAll("[role=menuitem]")].find(
      (item) => item.textContent?.trim() === "Archive",
    );

  it("stays open while another surface scrolls and closes when the page scrolls", () => {
    const { bubble, container } = mount({
      menus: { a: [{ label: "Archive", action: "archive" }] },
    });
    act(() => {
      bubble.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      );
    });
    expect(archiveMenu()?.closest(".animate-pop-in")).toBeTruthy();

    // A streaming chat timeline following its output is not the bubble's
    // scroller; its scroll events must leave the menu open.
    const timeline = document.createElement("div");
    document.body.append(timeline);
    containers.push(timeline);
    act(() => {
      timeline.dispatchEvent(new Event("scroll"));
    });
    expect(archiveMenu()?.closest(".animate-pop-in")).toBeTruthy();

    act(() => {
      container.dispatchEvent(new Event("scroll"));
    });
    expect(archiveMenu()?.closest(".animate-pop-out")).toBeTruthy();
  });
});

describe("ChatBubbles fold", () => {
  // jsdom has no media queries; the strip asks for reduced motion as it folds.
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The strip under one set of props; returns its state and a re-render. */
  function strip(props: {
    folded: boolean;
    autoCollapse?: boolean;
    open?: boolean;
  }) {
    const onFoldedChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const render = (next: typeof props) =>
      act(() => {
        root.render(
          <ChatBubbles
            entries={[{ localId: "a", mode: next.open ? "partial" : "min" }]}
            labels={{ a: "Launch plan" }}
            icons={{}}
            forks={{}}
            signals={{}}
            unread={{}}
            attention={{}}
            menus={{}}
            activeLocalId="a"
            autoCollapse={next.autoCollapse ?? false}
            folded={next.folded}
            onFoldedChange={onFoldedChange}
            onToggle={() => {}}
            onClose={() => {}}
            onMenuAction={() => {}}
            onNewChat={() => {}}
          />,
        );
      });
    render(props);
    const collapsed = () =>
      container
        .querySelector("[data-dock-rail]")
        ?.getAttribute("data-dock-collapsed");
    return { collapsed, render, container, onFoldedChange };
  }

  it("keeps the person's fold until they open it, beside an open chat only for as long as it is open", () => {
    const { collapsed, render } = strip({ folded: true });
    expect(collapsed()).toBe("true");
    render({ folded: true, open: true });
    expect(collapsed()).toBe("false");
    render({ folded: true, open: false });
    expect(collapsed()).toBe("true");
  });

  it("folds behind a chat tab and returns to the person's choice after it", () => {
    const { collapsed, render } = strip({ folded: true });
    render({ folded: true, autoCollapse: true });
    expect(collapsed()).toBe("true");
    render({ folded: true, autoCollapse: false });
    expect(collapsed()).toBe("true");
    render({ folded: false, autoCollapse: true });
    expect(collapsed()).toBe("true");
    render({ folded: false, autoCollapse: false });
    expect(collapsed()).toBe("false");
  });

  it("asks to change the fold only from the person's own controls", () => {
    const { container, onFoldedChange, render } = strip({ folded: false });
    // A chat opening and a chat tab folding it change nothing saved.
    render({ folded: false, open: true });
    render({ folded: false, autoCollapse: true });
    render({ folded: false });
    expect(onFoldedChange).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse chat bubbles"]',
        )
        ?.click(),
    );
    expect(onFoldedChange).toHaveBeenLastCalledWith(true);
    render({ folded: true });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Expand chat bubbles"]',
        )
        ?.click(),
    );
    expect(onFoldedChange).toHaveBeenLastCalledWith(false);
    expect(onFoldedChange).toHaveBeenCalledTimes(2);
  });
});
