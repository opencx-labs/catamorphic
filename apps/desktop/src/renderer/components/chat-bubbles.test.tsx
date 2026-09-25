// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
