// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityText } from "./activity-text.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function mount(text: string) {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  cleanup = () => act(() => root.unmount());
  const render = (next: string) =>
    act(() => root.render(<ActivityText text={next} />));
  render(text);
  const line = () => {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="activity-text"]',
    );
    if (!element) throw new Error("activity line missing");
    return element;
  };
  // jsdom runs no CSS, so the test ends each animation itself. Without
  // AnimationEvent, React listens for the vendor-prefixed name; send both.
  const finish = (animationName: string) =>
    act(() => {
      for (const type of ["animationend", "webkitAnimationEnd"]) {
        const event = new Event(type, { bubbles: true });
        Object.assign(event, { animationName });
        line().dispatchEvent(event);
      }
    });
  return { render, line, finish };
}

describe("ActivityText", () => {
  it("breathes without animating its first text", () => {
    const { line } = mount("Waiting for agent");
    expect(line().dataset.phase).toBe("breathing");
    expect(line().className).toContain("animate-pulse");
    expect(line().textContent).toBe("Waiting for agent");
  });

  it("swaps text on one beat: the old leaves, then the new arrives", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    expect(line().dataset.phase).toBe("leaving");
    expect(line().className).toContain("animate-activity-leave");
    // The old text stays until it has left.
    expect(line().textContent).toBe("Waiting for agent");
    finish("activity-leave");
    expect(line().dataset.phase).toBe("arriving");
    expect(line().className).toContain("animate-activity-arrive");
    expect(line().textContent).toBe("Reading files");
    finish("activity-arrive");
    expect(line().dataset.phase).toBe("breathing");
    expect(line().className).toContain("animate-pulse");
  });

  it("collapses activities that arrive mid-beat into the latest", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    render("Running tests");
    render("Writing");
    finish("activity-leave");
    expect(line().textContent).toBe("Writing");
    finish("activity-arrive");
    expect(line().dataset.phase).toBe("breathing");
  });

  it("starts another beat when the text changed while arriving", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    finish("activity-leave");
    render("Running tests");
    expect(line().textContent).toBe("Reading files");
    finish("activity-arrive");
    expect(line().dataset.phase).toBe("leaving");
    finish("activity-leave");
    expect(line().textContent).toBe("Running tests");
  });

  it("ignores animations it did not start", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    finish("pulse");
    expect(line().dataset.phase).toBe("leaving");
  });
});
