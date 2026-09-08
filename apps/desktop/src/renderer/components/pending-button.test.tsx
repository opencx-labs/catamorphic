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
});
