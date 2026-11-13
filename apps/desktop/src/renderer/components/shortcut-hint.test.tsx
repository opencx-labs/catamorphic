// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShortcutHint } from "./shortcut-hint.js";

let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

it.each([false, true])(
  "dismisses a hint without taking Escape from the menu (immediate=%s)",
  async (immediate) => {
    await act(async () => {
      root.render(
        <ShortcutHint label="Copy" showImmediately={immediate || undefined}>
          <button type="button">Copy</button>
        </ShortcutHint>,
      );
    });
    const button = node.querySelector("button")!;
    if (!immediate) {
      act(() =>
        button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
      );
      act(() => vi.advanceTimersByTime(800));
    }
    const tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.classList.contains("opacity-100")).toBe(true);
    // MenuPortal handles Escape at window. A nonmodal hint must let it arrive.
    const menuEscape = vi.fn();
    window.addEventListener("keydown", menuEscape);
    const key = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    try {
      act(() => button.dispatchEvent(key));
      expect(menuEscape).toHaveBeenCalledOnce();
      expect(key.defaultPrevented).toBe(false);
      expect(tooltip.classList.contains("opacity-0")).toBe(true);
    } finally {
      window.removeEventListener("keydown", menuEscape);
    }
  },
);
