// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerInput, type ComposerInputHandle } from "./composer-input";

describe("ComposerInput focus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  function renderComposer() {
    const ref = createRef<ComposerInputHandle>();
    act(() => {
      root.render(
        <>
          <button type="button">Outside</button>
          <ComposerInput
            ref={ref}
            placeholder="Message"
            ariaLabel="Message"
            onChange={vi.fn()}
          />
        </>,
      );
    });
    const composer = container.querySelector<HTMLDivElement>(
      '[aria-label="Message"]',
    );
    if (!composer) throw new Error("Composer missing");
    composer.replaceChildren(document.createTextNode("draft"));
    return { composer, ref };
  }

  it("places a missing selection at the end", () => {
    const { composer, ref } = renderComposer();
    container.querySelector<HTMLButtonElement>("button")?.focus();
    window.getSelection()?.removeAllRanges();

    act(() => ref.current?.focus());

    const selection = window.getSelection();
    expect(document.activeElement).toBe(composer);
    expect(selection?.anchorNode).toBe(composer);
    expect(selection?.anchorOffset).toBe(composer.childNodes.length);
  });

  it("preserves an existing caret inside the composer", () => {
    const { composer, ref } = renderComposer();
    const text = composer.firstChild;
    if (!text) throw new Error("Composer text missing");
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => ref.current?.focus());

    expect(document.activeElement).toBe(composer);
    expect(selection?.anchorNode).toBe(text);
    expect(selection?.anchorOffset).toBe(2);
  });
});
