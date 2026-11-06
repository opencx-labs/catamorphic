// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityText, SwapText, useLinger } from "./activity-text.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.restoreAllMocks();
});

function mountInto(render: (root: Root) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  act(() => render(root));
  return container;
}

// jsdom runs no CSS, so a test ends each animation itself. Without
// AnimationEvent, React listens for the vendor-prefixed name; send both.
function end(element: Element, animationName: string) {
  act(() => {
    for (const type of ["animationend", "webkitAnimationEnd"]) {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { animationName });
      element.dispatchEvent(event);
    }
  });
}

function mount(text: string) {
  let root: Root | undefined;
  const container = mountInto((created) => {
    root = created;
    created.render(<ActivityText text={text} />);
  });
  const render = (next: string) =>
    act(() => root?.render(<ActivityText text={next} />));
  const line = () => {
    const element = container.querySelector<HTMLElement>(
      '[data-testid="activity-text"]',
    );
    if (!element) throw new Error("activity line missing");
    return element;
  };
  const finish = (animationName: string) => end(line(), animationName);
  return { render, line, finish };
}

describe("ActivityText", () => {
  it("breathes on one line without animating its first text", () => {
    const { line } = mount("Waiting for agent");
    expect(line().dataset.phase).toBe("breathing");
    expect(line().className).toContain("animate-pulse");
    // One line, whatever the words: its height never changes.
    expect(line().className).toContain("truncate");
    expect(line().textContent).toBe("Waiting for agent");
  });

  it("swaps text on one beat: the old fades out, then the new fades in", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    expect(line().dataset.phase).toBe("leaving");
    expect(line().className).toContain("cat-swap-out");
    expect(line().className).not.toContain("animate-pulse");
    // The old text stays until it has left.
    expect(line().textContent).toBe("Waiting for agent");
    finish("catamorphic-swap-out");
    expect(line().dataset.phase).toBe("arriving");
    expect(line().className).toContain("cat-swap-in");
    expect(line().textContent).toBe("Reading files");
    finish("catamorphic-swap-in");
    expect(line().dataset.phase).toBe("breathing");
    expect(line().className).toContain("animate-pulse");
  });

  it("fades the old text out from where its breath was", () => {
    const { render, line } = mount("Waiting for agent");
    // Mid-breath: the pulse has the line at 0.6.
    line().style.opacity = "0.6";
    render("Reading files");
    expect(line().style.getPropertyValue("--cat-swap-from")).toBe("0.6");
    expect(line().dataset.phase).toBe("leaving");
  });

  it("collapses activities that arrive mid-beat into the latest", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    render("Running tests");
    render("Writing");
    finish("catamorphic-swap-out");
    expect(line().textContent).toBe("Writing");
    finish("catamorphic-swap-in");
    expect(line().dataset.phase).toBe("breathing");
  });

  it("starts another beat when the text changed while arriving", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    finish("catamorphic-swap-out");
    render("Running tests");
    expect(line().textContent).toBe("Reading files");
    finish("catamorphic-swap-in");
    expect(line().dataset.phase).toBe("leaving");
    finish("catamorphic-swap-out");
    expect(line().textContent).toBe("Running tests");
  });

  it("ignores animations it did not start", () => {
    const { render, line, finish } = mount("Waiting for agent");
    render("Reading files");
    finish("pulse");
    expect(line().dataset.phase).toBe("leaving");
  });

  it("moves on without the keyframes rather than freezing", () => {
    vi.useFakeTimers();
    try {
      const { render, line } = mount("Waiting for agent");
      render("Reading files");
      expect(line().dataset.phase).toBe("leaving");
      // No animationend ever arrives: a host without the stylesheet.
      act(() => vi.advanceTimersByTime(460));
      expect(line().textContent).toBe("Reading files");
      expect(line().dataset.phase).toBe("arriving");
      act(() => vi.advanceTimersByTime(460));
      expect(line().dataset.phase).toBe("breathing");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SwapText", () => {
  beforeEach(() => {
    // jsdom lays nothing out: each text is 7px a character.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const text = this.classList.contains("cat-swap-next")
          ? (this.dataset.text ?? "")
          : this.classList.contains("cat-swap-slot")
            ? (this.querySelector(".cat-swap-text")?.textContent ?? "")
            : (this.textContent ?? "");
        return DOMRect.fromRect({ width: text.length * 7, height: 16 });
      },
    );
  });

  function mountSwap(value: string) {
    let root: Root | undefined;
    const container = mountInto((created) => {
      root = created;
      created.render(<SwapText value={value} data-testid="count" />);
    });
    const slot = () => {
      const element = container.querySelector<HTMLElement>(
        '[data-testid="count"]',
      );
      if (!element) throw new Error("slot missing");
      return element;
    };
    const text = () => {
      const element = slot().querySelector<HTMLElement>(".cat-swap-text");
      if (!element) throw new Error("text missing");
      return element;
    };
    return {
      slot,
      text,
      render: (next: string) =>
        act(() => root?.render(<SwapText value={next} data-testid="count" />)),
    };
  }

  it("reads only what it shows, at its own width while still", () => {
    const { slot, text } = mountSwap("9");
    expect(slot().textContent).toBe("9");
    expect(slot().style.width).toBe("");
    expect(text().className).not.toMatch(/cat-swap-(out|in)/);
  });

  it("widens its place as a longer number leaves, then lets go", () => {
    const { slot, text, render } = mountSwap("9");
    render("10");
    // The old number fades out while its place widens to the new one, so
    // what follows slides right instead of jumping.
    expect(text().className).toContain("cat-swap-out");
    expect(slot().textContent).toBe("9");
    expect(slot().style.width).toBe("14px");
    end(text(), "catamorphic-swap-out");
    expect(text().className).toContain("cat-swap-in");
    expect(slot().textContent).toBe("10");
    expect(slot().style.width).toBe("14px");
    end(text(), "catamorphic-swap-in");
    expect(text().className).not.toMatch(/cat-swap-(out|in)/);
    expect(slot().style.width).toBe("");
  });

  it("narrows its place only once the shorter text arrives", () => {
    const { slot, text, render } = mountSwap("steps");
    render("step");
    expect(slot().style.width).toBe("35px");
    end(text(), "catamorphic-swap-out");
    expect(slot().textContent).toBe("step");
    expect(slot().style.width).toBe("28px");
  });

  it("keeps a number of the same width in place", () => {
    const { slot, text, render } = mountSwap("3");
    render("4");
    expect(text().className).toContain("cat-swap-out");
    expect(slot().style.width).toBe("7px");
  });
});

describe("useLinger", () => {
  function Probe({ value }: { value?: string }) {
    const kept = useLinger(value, 200);
    return (
      <span data-leaving={kept.leaving || undefined}>{kept.value ?? ""}</span>
    );
  }

  it("keeps a value that went away for its exit, then lets it go", () => {
    vi.useFakeTimers();
    try {
      let root: Root | undefined;
      const container = mountInto((created) => {
        root = created;
        created.render(<Probe value="Working" />);
      });
      const probe = () => container.querySelector("span");
      act(() => root?.render(<Probe />));
      expect(probe()?.textContent).toBe("Working");
      expect(probe()?.hasAttribute("data-leaving")).toBe(true);
      // Back before it left: it simply stays.
      act(() => root?.render(<Probe value="Reading" />));
      expect(probe()?.hasAttribute("data-leaving")).toBe(false);
      act(() => root?.render(<Probe />));
      act(() => vi.advanceTimersByTime(200));
      expect(probe()?.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays on while its exit still plays, however late that started", () => {
    vi.useFakeTimers();
    try {
      let playing = true;
      function Held({ value }: { value?: string }) {
        const kept = useLinger(value, 200, () => playing);
        return <span>{kept.value ?? ""}</span>;
      }
      let root: Root | undefined;
      const container = mountInto((created) => {
        root = created;
        created.render(<Held value="Working" />);
      });
      const probe = () => container.querySelector("span");
      act(() => root?.render(<Held />));
      // Its own length has passed, but the renderer started the exit late.
      act(() => vi.advanceTimersByTime(600));
      expect(probe()?.textContent).toBe("Working");
      playing = false;
      act(() => vi.advanceTimersByTime(50));
      expect(probe()?.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
