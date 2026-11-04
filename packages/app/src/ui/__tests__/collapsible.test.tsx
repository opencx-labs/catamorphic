// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Collapsible } from "../collapsible.js";

it("keeps closed content mounted but inert and tweens its measured height", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <Collapsible open={false}>
        <button type="button">inside</button>
      </Collapsible>,
    ),
  );
  const box = node.querySelector(".cat-collapsible") as HTMLElement;
  expect(box.dataset.state).toBe("closed");
  expect(box.hasAttribute("inert")).toBe(true);
  expect(node.querySelector("button")).not.toBeNull();
  await act(async () =>
    root.render(
      <Collapsible open>
        <button type="button">inside</button>
      </Collapsible>,
    ),
  );
  expect(box.dataset.state).toBe("open");
  expect(box.hasAttribute("inert")).toBe(false);
  // Geometry is inline so hosts without the kit sheet share the motion.
  expect(box.style.overflow).toBe("hidden");
  expect(box.style.transitionProperty).toBe("height, opacity");
  await act(async () => root.unmount());
});

it("keeps disclosure motion when a descendant resizes and the toggle reverses quickly", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const rects = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue({ length: 1 } as DOMRectList);
  const height = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockReturnValue(88);
  class HeightTransition {
    playState = "running";
    transitionProperty = "height";
  }
  vi.stubGlobal("CSSTransition", HeightTransition);
  const observers: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  const node = document.createElement("div");
  const root = createRoot(node);
  const render = async (open: boolean) =>
    act(async () => root.render(<Collapsible open={open}>Rows</Collapsible>));
  try {
    await render(true);
    const box = node.querySelector<HTMLElement>(".cat-collapsible");
    const inner = node.querySelector<HTMLElement>(".cat-collapsible-inner");
    if (!box || !inner) throw new Error("Missing collapsible");
    // A paging tail starts its own height transition as the section closes.
    Object.defineProperty(inner, "getAnimations", {
      value: () => [new HeightTransition()],
    });
    await render(false);
    expect(box.style.height).toBe("0px");
    expect(box.style.transitionDuration).toBe("200ms, 200ms");
    // Reversing inside the continuous-resize window is still a disclosure.
    await render(true);
    expect(box.style.height).toBe("88px");
    expect(box.style.transitionDuration).toBe("200ms, 200ms");
    // A later observer callback cannot cancel or restart the disclosure.
    height.mockReturnValue(924);
    clock.mockReturnValue(1050);
    await act(async () => observers.at(-1)?.());
    expect(box.style.height).toBe("924px");
    expect(box.style.transitionDuration).toBe("150ms, 200ms");
  } finally {
    await act(async () => root.unmount());
    rects.mockRestore();
    height.mockRestore();
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});
