// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function mount() {
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
        menus={{}}
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
  return { bubble, onToggle, onOpenAs };
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
