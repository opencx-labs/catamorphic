// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeInspectorPosition,
  ResourceInspector,
} from "./resource-inspector";

describe("ResourceInspector", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelectorAll("[data-resource-inspector]").forEach((node) => {
      node.remove();
    });
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("opens immediately for focus and dismisses with Escape", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Project details"
          content={<button type="button">Action</button>}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    await act(async () => trigger?.focus());
    const dialog = document.querySelector('[role="dialog"]');
    // Focus can scroll a chat link into view after its focus event opens the card.
    await act(async () => container.dispatchEvent(new Event("scroll")));
    expect(dialog?.getAttribute("data-open")).toBe("true");
    await act(async () => dialog?.querySelector("button")?.focus());
    expect(dialog?.textContent).toContain("Action");
    expect(trigger?.getAttribute("aria-details")).toBe(dialog?.id);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(document.querySelector('[role="dialog"]')?.className).toContain(
      "animate-inspector-out-",
    );
  });

  it("removes the inspector during a drag so drop targets remain reachable", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector label="Project details" content={<p>Details</p>}>
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    await act(async () => container.querySelector("button")?.focus());
    expect(document.querySelector("[data-resource-inspector]")).not.toBeNull();
    await act(async () =>
      document.dispatchEvent(new Event("dragstart", { bubbles: true })),
    );
    expect(document.querySelector("[data-resource-inspector]")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(document.querySelector("[data-resource-inspector]")).toBeNull();
    await act(async () =>
      document.dispatchEvent(new Event("dragend", { bubbles: true })),
    );
  });

  it("stays open while its own bounded content scrolls", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Project details"
          content={<div className="h-[1000px]">Long project details</div>}
        >
          {(props) => (
            <button type="button" {...props}>
              Project
            </button>
          )}
        </ResourceInspector>,
      );
    });
    await act(async () => container.querySelector("button")?.focus());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.className).toContain("overflow-y-auto");
    await act(async () => dialog?.dispatchEvent(new Event("scroll")));
    expect(dialog?.className).toContain("animate-inspector-in-");
  });

  it("ignores sibling scrolling but dismisses when its ancestor scrolls", async () => {
    await act(async () => {
      root.render(
        <div data-scroll-parent>
          <div data-transcript />
          <ResourceInspector
            label="Terminal"
            content={<p>Preview</p>}
            pinOnClick
          >
            {(props) => (
              <button type="button" {...props}>
                Terminal
              </button>
            )}
          </ResourceInspector>
        </div>,
      );
    });
    await act(async () => container.querySelector("button")?.click());
    const dialog = document.querySelector("[data-resource-inspector]");
    expect(dialog?.getAttribute("data-open")).toBe("true");
    await act(async () =>
      container
        .querySelector("[data-transcript]")
        ?.dispatchEvent(new Event("scroll")),
    );
    expect(dialog?.getAttribute("data-open")).toBe("true");
    await act(async () =>
      container
        .querySelector("[data-scroll-parent]")
        ?.dispatchEvent(new Event("scroll")),
    );
    expect(dialog?.getAttribute("data-open")).toBeNull();
  });

  it("pins on click and dismisses on an outside pointer", async () => {
    await act(async () => {
      root.render(
        <ResourceInspector
          label="Session details"
          content={<button type="button">Archive</button>}
          pinOnClick
        >
          {(props) => (
            <button type="button" {...props}>
              Status
            </button>
          )}
        </ResourceInspector>,
      );
    });
    const trigger = container.querySelector("button");
    await act(async () => trigger?.click());
    expect(document.querySelector('[role="dialog"]')?.className).toContain(
      "animate-inspector-in-",
    );

    await act(async () =>
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')?.className).toContain(
      "animate-inspector-out-",
    );
  });

  it("flips left and clamps vertically at viewport edges", () => {
    expect(
      computeInspectorPosition({
        anchor: { top: 190, right: 295, bottom: 210, left: 250 },
        width: 100,
        height: 80,
        viewportWidth: 300,
        viewportHeight: 220,
      }),
    ).toEqual({ side: "left", left: 142, top: 132 });
  });
});

it("clamps a stale anchor after the viewport shrinks", () => {
  const position = computeInspectorPosition({
    anchor: { left: 1100, right: 1200, top: 900, bottom: 930 },
    width: 320,
    height: 250,
    viewportWidth: 600,
    viewportHeight: 500,
  });
  expect(position.left).toBe(272);
  expect(position.top).toBe(242);
});
