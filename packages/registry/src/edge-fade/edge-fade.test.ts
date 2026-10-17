import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fadeEdges } from "./edge-fade.js";

/** Observer stand-ins: jsdom has none, and lays nothing out. */
const callbacks: Array<() => void> = [];
class FakeObserver {
  constructor(callback: () => void) {
    callbacks.push(callback);
  }
  observe() {}
  disconnect() {}
}
const observed = () => {
  for (const callback of callbacks) callback();
};

/** A scroller of the given size, scrolled to `top`. */
function scroller(size: { client: number; content: number; top?: number }) {
  const element = document.createElement("div");
  element.append(document.createElement("div"));
  let top = size.top ?? 0;
  let content = size.content;
  Object.defineProperties(element, {
    clientHeight: { get: () => size.client },
    scrollHeight: { get: () => content },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    },
  });
  document.body.append(element);
  return {
    element,
    grow: (height: number) => {
      content = height;
    },
    scroll: (to: number) => {
      top = to;
      element.dispatchEvent(new Event("scroll"));
    },
    fades: () => [
      element.style.getPropertyValue("--cat-edge-fade-top"),
      element.style.getPropertyValue("--cat-edge-fade-bottom"),
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeObserver);
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  callbacks.length = 0;
  document.body.replaceChildren();
});

describe("fadeEdges", () => {
  it("fades each edge by how far the content goes on past it, up to the fade", () => {
    const list = scroller({ client: 100, content: 400 });
    const stop = fadeEdges(list.element);
    observed();
    // At the top: sharp above, a full fade below.
    expect(list.fades()).toEqual(["0px", "24px"]);
    list.scroll(10);
    expect(list.fades()).toEqual(["10px", "24px"]);
    list.scroll(290);
    expect(list.fades()).toEqual(["24px", "10px"]);
    // Within a pixel of the end (a sub-pixel position) is the end.
    list.scroll(299.5);
    expect(list.fades()).toEqual(["24px", "0px"]);
    stop();
    expect(list.fades()).toEqual(["", ""]);
    expect(list.element.querySelector("[data-edge-fade-end]")).toBeNull();
  });

  it("follows the content's end as it grows, kept after what is added", async () => {
    const list = scroller({ client: 100, content: 100 });
    fadeEdges(list.element);
    observed();
    // Everything fits: nothing fades, and nothing is masked.
    expect(list.fades()).toEqual(["0px", "0px"]);
    expect(list.element.hasAttribute("data-edge-faded")).toBe(false);
    expect(
      list.element.lastElementChild?.hasAttribute("data-edge-fade-end"),
    ).toBe(true);
    // A row arrives after the marker; the marker moves back to the end.
    list.element.append(document.createElement("div"));
    await new Promise((resolve) => setTimeout(resolve));
    expect(
      list.element.lastElementChild?.hasAttribute("data-edge-fade-end"),
    ).toBe(true);
    // The end passes the bottom edge: the observers watching it say so.
    list.grow(180);
    observed();
    expect(list.fades()).toEqual(["0px", "24px"]);
    expect(list.element.hasAttribute("data-edge-faded")).toBe(true);
  });

  it("does nothing without observers, or on a scroller it already fades", () => {
    const list = scroller({ client: 100, content: 400, top: 100 });
    fadeEdges(list.element);
    const again = fadeEdges(list.element);
    expect(
      list.element.querySelectorAll(":scope > [data-edge-fade-end]"),
    ).toHaveLength(1);
    again();
    expect(list.element.querySelector("[data-edge-fade-end]")).not.toBeNull();
    vi.unstubAllGlobals();
    const bare = scroller({ client: 100, content: 400 });
    fadeEdges(bare.element)();
    expect(bare.element.querySelector("[data-edge-fade-end]")).toBeNull();
    expect(bare.fades()).toEqual(["", ""]);
  });

  it("takes another length from --cat-edge-fade", () => {
    const list = scroller({ client: 100, content: 400, top: 100 });
    list.element.style.setProperty("--cat-edge-fade", "32px");
    fadeEdges(list.element);
    observed();
    expect(list.fades()).toEqual(["32px", "32px"]);
  });
});
