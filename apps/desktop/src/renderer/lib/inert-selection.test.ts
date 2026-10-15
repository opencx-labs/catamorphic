// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installInertSelectionGuard } from "./inert-selection.js";

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

/** A surface holding a focusable composer with a caret in its text. */
function surfaceWithCaret() {
  const surface = document.createElement("section");
  surface.tabIndex = -1;
  const composer = document.createElement("div");
  composer.setAttribute("contenteditable", "true");
  composer.tabIndex = 0;
  composer.textContent = "a draft";
  const button = document.createElement("button");
  button.textContent = "minimise";
  surface.append(button, composer);
  document.body.append(surface);
  const text = composer.firstChild;
  if (text) document.getSelection()?.collapse(text, 3);
  return { surface, composer, button, text };
}

/** A paragraph of plain text, outside any editor. */
function paragraph(content: string, parent: Element = document.body) {
  const element = document.createElement("p");
  element.textContent = content;
  parent.append(element);
  return element;
}

/**
 * Focus an element and read the selection as its focus event arrives. The
 * guard restores during the document's capture-phase focus listener; then
 * Chromium keeps a selection already inside the focused editor, while jsdom
 * moves it to the editor's start.
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

  it("puts the caret back when its editor takes focus", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, composer, text } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    surface.removeAttribute("inert");
    await settle();
    expect(focusAndRead(composer)).toEqual({
      rangeCount: 1,
      node: text,
      offset: 3,
    });
  });

  it("never returns a caret with its surface, which would take focus", async () => {
    uninstall = installInertSelectionGuard();
    const { surface } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    // jsdom selects a focused button; Chromium leaves the selection empty.
    selection()?.removeAllRanges();
    surface.removeAttribute("inert");
    await settle();
    // Chromium focuses an editor a range is put into (jsdom does not), so
    // no range may come back until the editor itself has focus.
    expect(surface.contains(selection()?.anchorNode ?? null)).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("waits for the editor, not the surface or a button in it", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, composer, button, text } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    surface.removeAttribute("inert");
    await settle();
    expect(focusAndRead(surface)?.node).not.toBe(text);
    expect(focusAndRead(button)?.node).not.toBe(text);
    expect(focusAndRead(composer)).toEqual({
      rangeCount: 1,
      node: text,
      offset: 3,
    });
  });

  it("drops the caret when a press inside places its own", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, composer, text } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    surface.removeAttribute("inert");
    await settle();
    composer.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(focusAndRead(composer)?.node).not.toBe(text);
  });

  it("returns a highlight outside any editor with its surface", async () => {
    uninstall = installInertSelectionGuard();
    const panel = document.createElement("section");
    document.body.append(panel);
    const text = paragraph("several words", panel).firstChild;
    if (text) selection()?.setBaseAndExtent(text, 0, text, 7);
    panel.setAttribute("inert", "");
    await settle();
    expect(selection()?.rangeCount).toBe(0);
    panel.removeAttribute("inert");
    await settle();
    expect(selection()?.toString()).toBe("several");
  });

  it("keeps a selection made elsewhere over a returning highlight", async () => {
    uninstall = installInertSelectionGuard();
    const panel = document.createElement("section");
    document.body.append(panel);
    const text = paragraph("several words", panel).firstChild;
    if (text) selection()?.setBaseAndExtent(text, 0, text, 7);
    panel.setAttribute("inert", "");
    await settle();
    const other = paragraph("elsewhere").firstChild;
    if (other) selection()?.setBaseAndExtent(other, 0, other, 4);
    panel.removeAttribute("inert");
    await settle();
    expect(selection()?.toString()).toBe("else");
  });

  it("returns an editor's highlight only when the editor takes focus", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, composer, text } = surfaceWithCaret();
    if (text) selection()?.setBaseAndExtent(text, 7, text, 2);
    surface.setAttribute("inert", "");
    await settle();
    expect(selection()?.rangeCount).toBe(0);
    surface.removeAttribute("inert");
    await settle();
    // Even with nothing focused: a range set in an editor focuses it, and
    // the next key would replace the highlight.
    expect(surface.contains(selection()?.anchorNode ?? null)).toBe(false);
    expect(focusAndRead(composer)).toEqual({
      rangeCount: 1,
      node: text,
      offset: 7,
    });
  });

  it("leaves a selection only reaching into what turned inert", async () => {
    uninstall = installInertSelectionGuard();
    const before = paragraph("a reply").firstChild;
    const steps = document.createElement("section");
    document.body.append(steps);
    const inside = paragraph("a step", steps).firstChild;
    if (before && inside) selection()?.setBaseAndExtent(before, 2, inside, 3);
    steps.setAttribute("inert", "");
    await settle();
    expect(selection()?.toString()).toBe("reply" + "a s");
  });

  it("leaves a selection reaching into a region already inert", async () => {
    uninstall = installInertSelectionGuard();
    const before = paragraph("a reply").firstChild;
    const steps = document.createElement("section");
    document.body.append(steps);
    const inside = paragraph("a step", steps).firstChild;
    steps.setAttribute("inert", "");
    await settle();
    if (before && inside) selection()?.setBaseAndExtent(inside, 3, before, 2);
    document.dispatchEvent(new Event("selectionchange"));
    expect(selection()?.anchorNode).toBe(inside);
    expect(selection()?.focusNode).toBe(before);
  });

  it("returns a highlight, keeping its direction, as another is released", async () => {
    uninstall = installInertSelectionGuard();
    const alpha = document.createElement("section");
    const beta = document.createElement("section");
    document.body.append(alpha, beta);
    const first = paragraph("first project", alpha).firstChild;
    const second = paragraph("second project", beta).firstChild;
    beta.setAttribute("inert", "");
    if (first) selection()?.setBaseAndExtent(first, 5, first, 0);
    alpha.setAttribute("inert", "");
    beta.removeAttribute("inert");
    await settle();
    if (second) selection()?.setBaseAndExtent(second, 0, second, 6);
    // Switching back: one batch, in page order, returns alpha's and
    // releases beta's; the release goes first.
    alpha.removeAttribute("inert");
    beta.setAttribute("inert", "");
    await settle();
    expect(selection()?.toString()).toBe("first");
    expect(selection()?.anchorOffset).toBe(5);
    expect(selection()?.focusOffset).toBe(0);
  });

  it("returns a highlight held by an inert ancestor once both are back", async () => {
    uninstall = installInertSelectionGuard();
    const workspace = document.createElement("div");
    const chat = document.createElement("section");
    workspace.append(chat);
    document.body.append(workspace);
    const text = paragraph("a reply", chat).firstChild;
    if (text) selection()?.setBaseAndExtent(text, 2, text, 7);
    chat.setAttribute("inert", "");
    workspace.setAttribute("inert", "");
    await settle();
    chat.removeAttribute("inert");
    await settle();
    expect(selection()?.rangeCount).toBe(0);
    workspace.removeAttribute("inert");
    await settle();
    expect(selection()?.toString()).toBe("reply");
  });

  it("releases a caret placed into a surface already inert", async () => {
    uninstall = installInertSelectionGuard();
    const { surface, composer, text } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    if (text) selection()?.collapse(text, 5);
    // jsdom does not fire selectionchange; Chromium does, as a task.
    document.dispatchEvent(new Event("selectionchange"));
    expect(selection()?.rangeCount).toBe(0);
    surface.removeAttribute("inert");
    await settle();
    expect(focusAndRead(composer)).toEqual({
      rangeCount: 1,
      node: text,
      offset: 5,
    });
  });

  it("stops watching once uninstalled", async () => {
    installInertSelectionGuard()();
    const { surface } = surfaceWithCaret();
    surface.setAttribute("inert", "");
    await settle();
    expect(selection()?.rangeCount).toBe(1);
  });
});
