// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarMotion } from "./sidebar-motion.js";

/** The slide a real panel would run: one transform transition at a time. */
class FakeTransition {
  readonly transitionProperty: string;
  readonly finished: Promise<void>;
  finish = () => {};
  cancel = () => {};
  constructor(property: string) {
    this.transitionProperty = property;
    this.finished = new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.cancel = () => reject(new Error("cancelled"));
    });
    // A cancelled slide's rejection is handled by the hook, not here.
    this.finished.catch(() => {});
  }
}
let slides: Array<{ phase: string; slide: FakeTransition }> = [];
let runsSlides = true;

function Sidebar({ open, dock }: { open: boolean; dock: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const { phase, docked } = useSidebarMotion({ open, dock, panel });
  return (
    <div data-phase={phase} data-docked={docked}>
      <div
        data-panel
        ref={(element) => {
          panel.current = element;
          if (!element) return;
          // Each phase change that moves the panel starts a new transition,
          // replacing (cancelling) the one in flight, as CSS does.
          Reflect.set(element, "getAnimations", () => {
            const moving =
              element.closest<HTMLElement>("[data-phase]")?.dataset.phase;
            if (!runsSlides || (moving !== "opening" && moving !== "closing"))
              return [];
            const last = slides.at(-1);
            if (last?.phase !== moving) {
              last?.slide.cancel();
              slides.push({
                phase: moving,
                slide: new FakeTransition("transform"),
              });
            }
            return [new FakeTransition("opacity"), slides.at(-1)?.slide];
          });
        }}
      />
    </div>
  );
}

describe("useSidebarMotion", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Array<() => void>;

  const render = (open: boolean, dock = true) =>
    act(() => root.render(<Sidebar open={open} dock={dock} />));
  const state = () => {
    const element = container.querySelector<HTMLElement>("[data-phase]");
    return {
      phase: element?.dataset.phase,
      docked: element?.dataset.docked === "true",
    };
  };
  const frame = () =>
    act(() => {
      const pending = frames;
      frames = [];
      for (const callback of pending) callback();
    });
  const finishSlide = () =>
    act(async () => {
      slides.at(-1)?.slide.finish();
    });

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    frames = [];
    slides = [];
    runsSlides = true;
    vi.stubGlobal("CSSTransition", FakeTransition);
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("starts where it is, without motion", () => {
    render(true);
    expect(state()).toEqual({ phase: "open", docked: true });
    act(() => root.unmount());
    root = createRoot(container);
    render(false);
    expect(state()).toEqual({ phase: "closed", docked: false });
  });

  it("slides in over the content and takes its space once in place", async () => {
    render(false);
    render(true);
    expect(state()).toEqual({ phase: "opening", docked: false });
    await finishSlide();
    expect(state()).toEqual({ phase: "open", docked: true });
  });

  it("gives its space back, lets the content paint, then slides away", async () => {
    render(true);
    render(false);
    // No committed frame has the panel sliding while the content still
    // has its old width: the space goes back before any motion.
    expect(state()).toEqual({ phase: "undocking", docked: false });
    frame();
    expect(state().phase).toBe("undocking");
    frame();
    expect(state()).toEqual({ phase: "closing", docked: false });
    await finishSlide();
    expect(state()).toEqual({ phase: "closed", docked: false });
  });

  it("undocks before sliding when closing also turns docking off", () => {
    render(true, true);
    render(false, false);
    expect(state()).toEqual({ phase: "undocking", docked: false });
  });

  it("slides straight away from over the content", () => {
    render(true, false);
    expect(state()).toEqual({ phase: "open", docked: false });
    render(false, false);
    expect(state()).toEqual({ phase: "closing", docked: false });
  });

  it("reverses mid-slide and takes its space back while undocking", async () => {
    render(false);
    render(true);
    render(false);
    expect(state().phase).toBe("closing");
    render(true);
    expect(state().phase).toBe("opening");
    await finishSlide();
    expect(state().phase).toBe("open");
    render(false);
    expect(state().phase).toBe("undocking");
    render(true);
    expect(state()).toEqual({ phase: "open", docked: true });
    frame();
    frame();
    expect(state().phase).toBe("open");
  });

  it("docks when an open overlay becomes a docked sidebar", () => {
    render(true, false);
    render(true, true);
    expect(state()).toEqual({ phase: "open", docked: true });
  });

  it("ends a slide cancelled with nothing replacing it", async () => {
    render(false);
    render(true);
    expect(state().phase).toBe("opening");
    // The panel stops rendering mid-slide: its transition is cancelled and
    // no other starts.
    runsSlides = false;
    await act(async () => slides.at(-1)?.slide.cancel());
    expect(state()).toEqual({ phase: "open", docked: true });
  });

  it("ends a slide that never runs, as in a panel that is not rendered", () => {
    runsSlides = false;
    render(false);
    render(true);
    expect(state()).toEqual({ phase: "open", docked: true });
    render(false);
    frame();
    frame();
    expect(state()).toEqual({ phase: "closed", docked: false });
  });
});
