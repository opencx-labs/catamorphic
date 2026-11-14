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

it("keeps a requested hint when the previous hint's exit ends before its reveal frame", async () => {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const draw = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const frame of pending) frame(0);
    });
  await act(async () => {
    root.render(
      <ShortcutHint label="Talk">
        <button type="button">Microphone</button>
      </ShortcutHint>,
    );
  });
  const button = node.querySelector("button")!;
  act(() =>
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
  );
  act(() => vi.advanceTimersByTime(800));
  draw();
  const previous = document.querySelector('[role="tooltip"]')!;
  expect(previous.classList.contains("opacity-100")).toBe(true);
  act(() => button.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await act(async () => {
    root.render(
      <ShortcutHint label="Press and hold" showImmediately>
        <button type="button">Microphone</button>
      </ShortcutHint>,
    );
  });
  // The old fade can end while the new hint waits for its first frame.
  act(() =>
    previous.dispatchEvent(new Event("transitionend", { bubbles: true })),
  );
  draw();
  const requested = document.querySelector('[role="tooltip"]');
  expect(requested?.textContent).toBe("Press and hold");
  expect(requested?.classList.contains("opacity-100")).toBe(true);
  act(() =>
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  act(() =>
    requested?.dispatchEvent(new Event("transitionend", { bubbles: true })),
  );
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
