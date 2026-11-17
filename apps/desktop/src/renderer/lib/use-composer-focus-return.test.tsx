// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWN_FOCUS_ATTR,
  useComposerFocusReturn,
} from "./use-composer-focus-return.js";

let returns = true;

function Chat() {
  const section = useRef<HTMLElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  useComposerFocusReturn({
    section,
    composer: () => composer.current,
    focusComposer: () => composer.current?.focus(),
    canReturn: () => returns,
  });
  return (
    <section ref={section}>
      <button type="button" data-testid="retry">
        Retry
      </button>
      <button type="button" data-testid="menu" aria-haspopup="menu">
        More
      </button>
      <div {...{ [OWN_FOCUS_ATTR]: "" }} className="contents">
        <button type="button" data-testid="chip">
          Chip
        </button>
        <button type="button" data-testid="next-chip">
          Next chip
        </button>
      </div>
      <article tabIndex={-1} data-testid="message">
        A message
      </article>
      <input data-testid="field" />
      {/* biome-ignore lint/a11y/useSemanticElements: the composer is a contenteditable textbox */}
      <div ref={composer} role="textbox" tabIndex={0} data-testid="composer" />
    </section>
  );
}

describe("useComposerFocusReturn", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let lastFrame = 0;

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    returns = true;
    frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      lastFrame += 1;
      frames.set(lastFrame, callback);
      return lastFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Chat />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const get = (id: string) => {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (!element) throw new Error(`No ${id}`);
    return element;
  };
  const nextFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  };
  /** The two frames the hook waits out before it settles. */
  const settle = () => {
    nextFrame();
    nextFrame();
  };
  /** A press of the pointer: focus lands on the control, then it clicks. */
  const press = (element: HTMLElement) => {
    window.dispatchEvent(new Event("pointerdown"));
    element.focus();
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
  };
  /** A control that had focus going away under it. */
  const drop = (element: HTMLElement) => {
    element.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
    element.remove();
  };

  it("hands focus to the composer after a pointer press on a control", () => {
    press(get("retry"));
    nextFrame();
    // Not before the action has had its frames to move focus itself.
    expect(document.activeElement).toBe(get("retry"));
    nextFrame();
    expect(document.activeElement).toBe(get("composer"));
  });

  it("leaves a control pressed with a key focused while it stays", () => {
    const retry = get("retry");
    retry.focus();
    retry.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    settle();
    expect(document.activeElement).toBe(retry);
  });

  it("hands the composer what a removed control dropped, however it was pressed", () => {
    const retry = get("retry");
    retry.focus();
    drop(retry);
    settle();
    expect(document.activeElement).toBe(get("composer"));
  });

  it("leaves focus that the action moved somewhere else", () => {
    press(get("retry"));
    nextFrame();
    get("field").focus();
    nextFrame();
    expect(document.activeElement).toBe(get("field"));
  });

  it("leaves focus a lost press on nothing dropped", () => {
    const retry = get("retry");
    retry.focus();
    retry.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
    retry.blur();
    settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves controls that open something, and regions that move focus", () => {
    press(get("menu"));
    settle();
    expect(document.activeElement).toBe(get("menu"));
    press(get("chip"));
    settle();
    expect(document.activeElement).toBe(get("chip"));
  });

  it("yields to a region that puts the focus it dropped back itself", () => {
    const chip = get("chip");
    const next = get("next-chip");
    chip.focus();
    drop(chip);
    requestAnimationFrame(() => next.focus());
    settle();
    expect(document.activeElement).toBe(next);
  });

  it("returns what a closing region dropped", () => {
    const chip = get("chip");
    chip.focus();
    chip.parentElement?.setAttribute("inert", "");
    chip.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
    chip.blur();
    settle();
    expect(document.activeElement).toBe(get("composer"));
  });

  it("treats a message the chat parked focus on as nowhere after a press", () => {
    press(get("retry"));
    nextFrame();
    get("message").focus();
    nextFrame();
    expect(document.activeElement).toBe(get("composer"));
  });

  it("leaves focus lost to a press outside the chat", () => {
    const outside = document.createElement("div");
    document.body.append(outside);
    const retry = get("retry");
    retry.focus();
    // Pressing the workspace lets a working chat lurk, hiding the control.
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    drop(retry);
    settle();
    expect(document.activeElement).toBe(document.body);
    outside.remove();
  });

  it("yields to the person acting again, and to a chat out of front", () => {
    press(get("retry"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    settle();
    expect(document.activeElement).toBe(get("retry"));
    returns = false;
    press(get("retry"));
    settle();
    expect(document.activeElement).toBe(get("retry"));
  });
});
