// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingButton } from "./pending-button";

describe("PendingButton layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("keeps every state label on one line without flex shrinking", async () => {
    await act(async () => {
      root.render(
        <PendingButton pending={false} pendingLabel="Opening…">
          Use another account
        </PendingButton>,
      );
    });

    const stack = container.querySelector("button > span");
    expect(Array.from(stack?.classList ?? [])).toEqual(
      expect.arrayContaining(["min-w-max", "shrink-0", "whitespace-nowrap"]),
    );
    for (const label of stack?.children ?? []) {
      expect(label.classList.contains("whitespace-nowrap")).toBe(true);
    }
  });
  it("exposes only the active label and stops the spinner after pending", async () => {
    for (const pending of [false, true, false]) {
      await act(async () => {
        root.render(<PendingButton pending={pending}>Save</PendingButton>);
      });
      const button = container.querySelector("button");
      expect(button?.disabled).toBe(pending);
      expect(button?.getAttribute("aria-busy")).toBe(pending ? "true" : null);
      expect(container.querySelectorAll('[aria-hidden="false"]')).toHaveLength(
        1,
      );
      expect(container.querySelector(".animate-spin") !== null).toBe(pending);
      expect(button?.textContent).toContain("Save");
    }
  });
  it("keeps one active label when completion arrives before the request settles", async () => {
    for (const [pending, done, label] of [
      [false, false, "Install"],
      [true, false, "Installing…"],
      [true, true, "Installing…"],
      [false, true, "Installed"],
    ] as const) {
      await act(async () => {
        root.render(
          <PendingButton
            pending={pending}
            done={done}
            pendingLabel="Installing…"
            doneLabel="Installed"
          >
            Install
          </PendingButton>,
        );
      });
      const visible = container.querySelectorAll('[aria-hidden="false"]');
      expect(visible).toHaveLength(1);
      expect(visible[0]?.textContent).toBe(label);
    }
  });

  it("retains the action label when a completed button has no replacement label", async () => {
    await act(async () => {
      root.render(
        <PendingButton pending={false} done>
          Save
        </PendingButton>,
      );
    });
    expect(container.querySelector('[aria-hidden="false"]')?.textContent).toBe(
      "Save",
    );
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
});
