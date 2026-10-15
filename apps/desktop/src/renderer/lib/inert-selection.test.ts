// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installInertSelectionGuard } from "./inert-selection.js";

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

/** A surface holding a focusable composer with a caret in its text. */
function surfaceWithCaret() {
  const surface = document.createElement("section");
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.tabIndex = 0;
  composer.textContent = "a draft";
  surface.append(composer);
  document.body.append(surface);
  const text = composer.firstChild;
  if (text) document.getSelection()?.collapse(text, 3);
  return { surface, composer, text };
}

function otherButton() {
  const button = document.createElement("button");
  button.textContent = "elsewhere";
  document.body.append(button);
  return button;
}

/**
 * Focus an element and read the selection as its focus event arrives.
 * Chromium places a caret on focus only after the event, and only when the
 * selection is not already inside; jsdom moves it regardless.
 */
function focusAndRead(element: HTMLElement) {
  const seen: {
    reading?: { rangeCount: number; node: Node | null; offset: number };
  } = {};
  element.addEventListener(
    "focus",
    () => {
      const current = document.getSelection();
      seen.reading = {
        rangeCount: current?.rangeCount ?? 0,
        node: current?.anchorNode ?? null,
        offset: current?.anchorOffset ?? 0,
      };
    },
    { once: true },
  );
  element.focus();
  return seen.reading;
}

/** MutationObserver callbacks run as a microtask after the change. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const selection = () => document.getSelection();

describe("inert selection guard", () => {
  it("releases a caret whose surface turns inert", async () => {
    uninstall = installInertSelectionGuard();
    const { surface } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    expect(selection()?.rangeCount).toBe(0);
  });

  it("releases it when an ancestor of the surface turns inert", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, text } = surfaceWithCaret();
    const workspace = document.createElement("div");
    document.body.append(workspace);
    workspace.append(surface);
    if (text) selection()?.collapse(text, 1);
    workspace.setAttribute("inert", "");
    await settle();
    expect(selection()?.rangeCount).toBe(0);
  });

  it("keeps a caret outside the surface that turned inert", async () => {
    uninstall = installInertSelectionGuard();
    surfaceWithCaret();
    const other = document.createElement("div");
    document.body.append(other);
    other.setAttribute("inert", "");
    await settle();
    expect(selection()?.rangeCount).toBe(1);
  });

  it("puts the caret back when focus returns to the surface", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, composer, text } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    surface.removeAttribute("inert");
    await settle();
    expect(selection()?.rangeCount).toBe(0);
    expect(focusAndRead(composer)).toEqual({
      rangeCount: 1,
      node: text,
      offset: 3,
    });
  });

  it("never moves focus when the surface returns", async () => {
    uninstall = installInertSelectionGuard();
    const { surface } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    const button = otherButton();
    button.focus();
    surface.removeAttribute("inert");
    await settle();
    expect(document.activeElement).toBe(button);
  });

  it("lets a press inside place its own caret", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, composer } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    surface.removeAttribute("inert");
    await settle();
    composer.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(focusAndRead(composer)?.rangeCount).toBe(0);
  });

  it("stops watching once uninstalled", async () => {
    installInertSelectionGuard()();
    const { surface } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    expect(selection()?.rangeCount).toBe(1);
  });
});
