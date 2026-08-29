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
    expect(dialog?.textContent).toContain("Action");
    expect(trigger?.getAttribute("aria-details")).toBe(dialog?.id);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(document.querySelector('[role="dialog"]')?.className).toContain(
      "animate-pop-out",
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
    expect(dialog?.className).toContain("animate-pop-in");
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
