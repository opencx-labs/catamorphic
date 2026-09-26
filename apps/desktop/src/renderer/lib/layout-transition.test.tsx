// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useSteadyWidthDuringLayoutTransitions } from "./layout-transition.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function Pane() {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useSteadyWidthDuringLayoutTransitions(content, box);
  return (
    <div ref={box} data-testid="box">
      <div ref={content} data-testid="content" style={{ width: "100%" }} />
    </div>
  );
}

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Pane />));
  const box = document.querySelector<HTMLElement>('[data-testid="box"]');
  const content = document.querySelector<HTMLElement>(
    '[data-testid="content"]',
  );
  if (!box || !content) throw new Error("not mounted");
  return { box, content };
}

function sized(element: HTMLElement, width: number) {
  element.getBoundingClientRect = () =>
    ({
      width,
      height: 10,
      top: 0,
      left: 0,
      right: width,
      bottom: 10,
    }) as DOMRect;
}

function transition(type: string, target: HTMLElement, propertyName: string) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  target.dispatchEvent(event);
}

describe("steady width during layout transitions", () => {
  it("holds content at the wider end and releases it once", () => {
    const { box, content } = mount();
    const sidebar = document.createElement("aside");
    sidebar.setAttribute("data-layout-transition", "");
    document.body.append(sidebar);

    // A 260px sidebar closing: the content will grow by 260px.
    sized(box, 1000);
    sidebar.style.width = "0px";
    sized(sidebar, 260);
    transition("transitionrun", sidebar, "width");
    expect(content.style.width).toBe("1260px");
    expect(box.style.overflow).toBe("hidden");

    transition("transitionend", sidebar, "width");
    expect(content.style.width).toBe("100%");
    expect(box.style.overflow).toBe("");
  });

  it("ignores elements and properties that do not move the layout", () => {
    const { content } = mount();
    const button = document.createElement("button");
    document.body.append(button);
    transition("transitionrun", button, "width");
    const sidebar = document.createElement("aside");
    sidebar.setAttribute("data-layout-transition", "");
    document.body.append(sidebar);
    transition("transitionrun", sidebar, "opacity");
    expect(content.style.width).toBe("100%");
  });
});
