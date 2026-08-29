// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TodoProgress } from "./todo-progress";

const todos = [
  {
    id: "first",
    title: "Inspect the project",
    description: "Read the current implementation and its tests.",
    status: "completed" as const,
  },
  {
    id: "second",
    title: "Implement the change",
    description: "Add the new behavior without duplicating state.",
    status: "in_progress" as const,
  },
];

describe("TodoProgress", () => {
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

  it("shows completion and keeps descriptions collapsed until expanded", async () => {
    await act(async () => root.render(<TodoProgress todos={todos} />));
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="todo-progress-trigger"]',
    );
    expect(trigger?.textContent).toContain("1/2");
    await act(async () => trigger?.click());
    await act(async () => new Promise(requestAnimationFrame));

    const panel = container.querySelector(
      '[data-testid="todo-progress-popover"]',
    );
    expect(panel?.textContent).toContain("1 of 2 done");
    const item = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Implement the change"),
    );
    expect(item?.getAttribute("aria-expanded")).toBe("false");
    expect(item?.nextElementSibling?.getAttribute("aria-hidden")).toBe("true");

    await act(async () => item?.click());
    expect(item?.getAttribute("aria-expanded")).toBe("true");
    expect(item?.nextElementSibling?.getAttribute("aria-hidden")).toBe("false");
    expect(item?.nextElementSibling?.textContent).toContain(
      "without duplicating state",
    );
  });
});
