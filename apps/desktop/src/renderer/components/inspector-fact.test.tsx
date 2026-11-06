// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorFact } from "./inspector-fact.js";

describe("InspectorFact", () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("copies the whole value from its row, and says so", async () => {
    await act(async () => {
      root.render(
        <dl>
          <InspectorFact
            term="Location"
            copy="/Users/ada/alpha/notes/plan.md"
            copyLabel="Copy file path"
          >
            plan.md
          </InspectorFact>
          <InspectorFact term="Status">Saved on this device</InspectorFact>
        </dl>,
      );
    });
    const [location, status] = [...container.querySelectorAll("dl > div")];
    // The row is what reveals the button (styles.css: [data-copyable]).
    expect(location?.hasAttribute("data-copyable")).toBe(true);
    const button = location?.querySelector<HTMLButtonElement>(
      '[aria-label="Copy file path"]',
    );
    expect(button?.classList.contains("copy-reveal")).toBe(true);
    await act(async () => button?.click());
    expect(writeText).toHaveBeenCalledWith("/Users/ada/alpha/notes/plan.md");
    expect(button?.dataset.copied).toBe("true");
    expect(location?.querySelector('[role="status"]')?.textContent).toBe(
      "Copied",
    );
    // Nothing to copy: no button, and nothing to reveal.
    expect(status?.hasAttribute("data-copyable")).toBe(false);
    expect(status?.querySelector("button")).toBeNull();
  });

  it("names its copy after its label by default", async () => {
    await act(async () => {
      root.render(
        <dl>
          <InspectorFact term="Permission mode" copy="Plan" oneLine>
            Plan
          </InspectorFact>
        </dl>,
      );
    });
    expect(
      container.querySelector('[aria-label="Copy permission mode"]'),
    ).not.toBeNull();
  });
});
