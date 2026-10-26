// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DisabledControlHints } from "./shortcut-hint.js";

it("keeps a disabled hint while another surface scrolls, and hides it with its anchor", async () => {
  vi.useFakeTimers();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <DisabledControlHints />
          <div data-fixture="chat" />
          <div data-fixture="inspector">
            <button
              disabled
              data-disabled-reason="Finish the current turn"
              type="button"
            >
              Model
            </button>
          </div>
        </>,
      ),
    );
    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new Event("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
      container
        .querySelector('[data-fixture="chat"]')
        ?.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Finish the current turn",
    );
    await act(async () => {
      container
        .querySelector('[data-fixture="chat"]')
        ?.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="tooltip"]')?.className).toContain(
      "opacity-100",
    );
    await act(async () => {
      container
        .querySelector('[data-fixture="inspector"]')
        ?.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="tooltip"]')?.className).toContain(
      "opacity-0",
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new Event("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(800);
      document.dispatchEvent(new Event("scroll"));
    });
    expect(document.querySelector('[role="tooltip"]')?.className).toContain(
      "opacity-0",
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  }
});

it("explains a native disabled control and animates its hint away", async () => {
  vi.useFakeTimers();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <DisabledControlHints />
          <button
            disabled
            data-disabled-reason="Connect a server first"
            type="button"
          >
            Move
          </button>
        </>,
      ),
    );
    await act(async () => {
      container
        .querySelector("button")
        ?.dispatchEvent(new Event("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Connect a server first",
    );
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')?.className).toContain(
      "opacity-0",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  }
});
