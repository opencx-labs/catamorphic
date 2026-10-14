// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarMotion } from "./sidebar-motion.js";

/** Content settles wait here until a test lets them apply. */
const settles: Array<() => void> = [];
/** Whether the content beside the panel can move with it. */
let light = false;
vi.mock("./sidebar-transition.js", () => ({
  settleSidebarContent: ({ update }: { update: () => void }) => {
    settles.push(update);
  },
  contentMovesWithSidebar: () => light,
}));

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
  const { phase, docked, push, settled } = useSidebarMotion({
    open,
    dock,
    panel,
  });
  return (
    <div
      data-phase={phase}
      data-docked={docked}
      data-push={push}
      data-settled={settled}
    >
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

  const render = (open: boolean, dock = true) =>
    act(() => root.render(<Sidebar open={open} dock={dock} />));
  const state = () => {
    const element = container.querySelector<HTMLElement>("[data-phase]");
    return {
      phase: element?.dataset.phase,
      docked: element?.dataset.docked === "true",
    };
  };
  const finishSlide = () =>
    act(async () => {
      slides.at(-1)?.slide.finish();
    });
  const settled = () =>
    container.querySelector<HTMLElement>("[data-phase]")?.dataset.settled ===
    "true";
  const applySettle = () => {
    const settle = settles.shift();
    if (!settle) throw new Error("no settle is waiting");
    act(settle);
  };

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    slides = [];
    settles.length = 0;
    runsSlides = true;
    light = false;
    vi.stubGlobal("CSSTransition", FakeTransition);
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
    expect(settles).toHaveLength(0);
  });

  it("slides in over the content, then the content makes room", async () => {
    render(false);
    render(true);
    // Moving at once; the content keeps its place while it moves.
    expect(state()).toEqual({ phase: "opening", docked: false });
    expect(settled()).toBe(false);
    expect(settles).toHaveLength(0);
    await finishSlide();
    expect(state()).toEqual({ phase: "open", docked: false });
    expect(settled()).toBe(false);
    expect(settles).toHaveLength(1);
    applySettle();
    expect(state()).toEqual({ phase: "open", docked: true });
    expect(settled()).toBe(true);
  });

  it("slides away from the content's side, then the content takes the space", async () => {
    render(true);
    render(false);
    expect(state()).toEqual({ phase: "closing", docked: true });
    expect(settles).toHaveLength(0);
    await finishSlide();
    expect(state()).toEqual({ phase: "closed", docked: true });
    applySettle();
    expect(state()).toEqual({ phase: "closed", docked: false });
  });

  it("keeps the content's place when closing also turns docking off", async () => {
    render(true, true);
    render(false, false);
    expect(state()).toEqual({ phase: "closing", docked: true });
    await finishSlide();
    applySettle();
    expect(state()).toEqual({ phase: "closed", docked: false });
  });

  it("never moves the content for an overlay", async () => {
    render(false, false);
    render(true, false);
    await finishSlide();
    expect(state()).toEqual({ phase: "open", docked: false });
    render(false, false);
    await finishSlide();
    expect(state()).toEqual({ phase: "closed", docked: false });
    expect(settles).toHaveLength(0);
  });

  it("makes room when an open overlay becomes a docked sidebar", () => {
    render(true, false);
    render(true, true);
    applySettle();
    expect(state()).toEqual({ phase: "open", docked: true });
  });

  it("reverses mid-slide without moving the content", async () => {
    render(false);
    render(true);
    render(false);
    expect(state()).toEqual({ phase: "closing", docked: false });
    render(true);
    expect(state().phase).toBe("opening");
    await finishSlide();
    applySettle();
    expect(state()).toEqual({ phase: "open", docked: true });
    // Reopened while sliding away: the content never left.
    render(false);
    render(true);
    await finishSlide();
    expect(state()).toEqual({ phase: "open", docked: true });
    expect(settles).toHaveLength(0);
  });

  it("leaves the content alone if the panel moves again before the settle", async () => {
    render(false);
    render(true);
    await finishSlide();
    expect(settles).toHaveLength(1);
    render(false);
    applySettle();
    expect(state()).toEqual({ phase: "closing", docked: false });
    await finishSlide();
    expect(state()).toEqual({ phase: "closed", docked: false });
    expect(settles).toHaveLength(0);
  });

  it("ends a slide cancelled with nothing replacing it", async () => {
    render(false);
    render(true);
    expect(state().phase).toBe("opening");
    // The panel stops rendering mid-slide: its transition is cancelled and
    // no other starts.
    runsSlides = false;
    await act(async () => slides.at(-1)?.slide.cancel());
    expect(state().phase).toBe("open");
  });

  const pushing = () =>
    container.querySelector<HTMLElement>("[data-phase]")?.dataset.push ===
    "true";

  it("moves light content with the panel, making room as it slides in", async () => {
    render(false);
    light = true;
    render(true);
    // The content takes its new place with the slide, not after it.
    expect(state()).toEqual({ phase: "opening", docked: true });
    expect(pushing()).toBe(true);
    expect(settled()).toBe(false);
    await finishSlide();
    expect(state()).toEqual({ phase: "open", docked: true });
    expect(pushing()).toBe(false);
    expect(settled()).toBe(true);
    expect(settles).toHaveLength(0);
  });

  it("gives light content the space as the panel slides away", async () => {
    light = true;
    render(true);
    render(false);
    expect(state()).toEqual({ phase: "closing", docked: false });
    expect(pushing()).toBe(true);
    await finishSlide();
    expect(state()).toEqual({ phase: "closed", docked: false });
    expect(pushing()).toBe(false);
    expect(settles).toHaveLength(0);
  });

  it("keeps the motion it has when the panel turns around mid-slide", async () => {
    render(false);
    light = true;
    render(true);
    // Heavy content arriving mid-slide changes nothing about this one.
    light = false;
    render(false);
    expect(state()).toEqual({ phase: "closing", docked: false });
    expect(pushing()).toBe(true);
    render(true);
    expect(state()).toEqual({ phase: "opening", docked: true });
    await finishSlide();
    expect(state()).toEqual({ phase: "open", docked: true });
    expect(settles).toHaveLength(0);
    // From rest, heavy content settles after the slide again.
    render(false);
    expect(pushing()).toBe(false);
    expect(state()).toEqual({ phase: "closing", docked: true });
    await finishSlide();
    applySettle();
    expect(state()).toEqual({ phase: "closed", docked: false });
  });

  it("never pushes for an overlay", async () => {
    light = true;
    render(false, false);
    render(true, false);
    expect(pushing()).toBe(false);
    await finishSlide();
    expect(state()).toEqual({ phase: "open", docked: false });
  });

  it("ends a slide that never runs, as in a panel that is not rendered", () => {
    runsSlides = false;
    render(false);
    render(true);
    expect(state().phase).toBe("open");
    applySettle();
    render(false);
    expect(state().phase).toBe("closed");
    applySettle();
    expect(state()).toEqual({ phase: "closed", docked: false });
    expect(settled()).toBe(true);
  });
});
