// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./desktop-api.js";
import { useSidebarReveal } from "./use-sidebar-reveal.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
const listeners = vi.hoisted(
  () => new Set<(zone: "edge" | "inside" | "outside") => void>(),
);
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    windowSetControlsVisible: vi.fn().mockResolvedValue(undefined),
    windowSetSidebarEdgeEnabled: vi.fn().mockResolvedValue(undefined),
    onSidebarPointerZone: (
      listener: (zone: "edge" | "inside" | "outside") => void,
    ) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));

function Preview() {
  const { sidebarRef, revealed, reveal, revealOnHover } =
    useSidebarReveal(true);
  return (
    <>
      <aside ref={sidebarRef} data-revealed={revealed}>
        <div>
          <button type="button" aria-label="Expand sidebar">
            Pin
          </button>
          <input aria-label="Address" />
        </div>
      </aside>
      <button
        type="button"
        data-sidebar-reveal-edge
        onPointerEnter={revealOnHover}
        onFocus={reveal}
        onClick={reveal}
      >
        Reveal
      </button>
      <button type="button" data-page>
        Page
      </button>
    </>
  );
}

let root: Root | undefined;
let container: HTMLDivElement;
function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Preview />));
  return container;
}
function point(zone: "edge" | "inside" | "outside") {
  act(() => {
    for (const listener of listeners) listener(zone);
  });
}
function revealed() {
  return container.querySelector("aside")?.dataset.revealed === "true";
}
function staleHover(selector: string, clientX: number) {
  act(() => {
    container.querySelector(selector)?.dispatchEvent(
      new MouseEvent("pointerover", {
        bubbles: true,
        clientX,
        clientY: 200,
      }),
    );
  });
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.clearAllMocks();
});

describe("collapsed sidebar native hover", () => {
  it("reveals without a click and ignores stale guest and edge hover events", () => {
    mount();
    point("edge");
    expect(revealed()).toBe(true);
    staleHover("[data-page]", 400);
    expect(revealed()).toBe(true);
    point("inside");
    expect(revealed()).toBe(true);
    point("outside");
    expect(revealed()).toBe(false);
    staleHover("[data-sidebar-reveal-edge]", 2);
    expect(revealed()).toBe(false);
    point("inside");
    expect(revealed()).toBe(false);
  });

  it("keeps the address field usable, then dismisses when focus returns to the page", () => {
    mount();
    point("edge");
    act(() => container.querySelector("input")?.focus());
    point("outside");
    expect(revealed()).toBe(true);
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-page]")?.focus(),
    );
    expect(revealed()).toBe(false);
  });

  it("preserves keyboard reveal after native pointer tracking starts", () => {
    mount();
    point("outside");
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-sidebar-reveal-edge]")
        ?.focus(),
    );
    expect(revealed()).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Expand sidebar",
    );
    point("outside");
    expect(revealed()).toBe(true);
  });

  it("stops tracking and restores native controls when unmounted", () => {
    mount();
    expect(listeners.size).toBe(1);
    expect(desktopApi.windowSetSidebarEdgeEnabled).toHaveBeenLastCalledWith(
      true,
    );
    act(() => root?.unmount());
    root = undefined;
    expect(listeners.size).toBe(0);
    expect(desktopApi.windowSetSidebarEdgeEnabled).toHaveBeenLastCalledWith(
      false,
    );
    expect(desktopApi.windowSetControlsVisible).toHaveBeenLastCalledWith(true);
  });
});
