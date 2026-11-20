// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { keepFocusFromFrames } from "./frame-focus.js";

const mounted: HTMLElement[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const element of mounted.splice(0)) element.remove();
});

function mount<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  parent: HTMLElement = document.body,
) {
  const element = document.createElement(tag);
  parent.append(element);
  mounted.push(element);
  return element;
}

/** A surface with a field of its own, and a page beneath it. */
function surfaceOverPage({
  holdsKeys = () => true,
}: {
  holdsKeys?: () => boolean;
} = {}) {
  const page = mount("iframe");
  const surface = mount("div");
  const field = mount("input", surface);
  field.focus();
  stops.push(
    keepFocusFromFrames({
      surface: () => surface,
      holdsKeys,
      take: () => field.focus(),
    }),
  );
  return { page, surface, field };
}

/**
 * The page finishes taking focus: Chromium blurs the window as focus
 * enters a frame; jsdom only moves activeElement, so the blur is sent.
 */
function pageTakesFocus(page: HTMLElement) {
  page.focus();
  window.dispatchEvent(new FocusEvent("blur"));
}

const focusMoved = () => new Promise((resolve) => setTimeout(resolve));

it("takes focus back from a page beneath that focuses after the surface did", async () => {
  const { page, field } = surfaceOverPage();
  pageTakesFocus(page);
  // Not during the move: focus taken back then is overridden by it.
  expect(document.activeElement).toBe(page);
  await focusMoved();
  expect(document.activeElement).toBe(field);
});

it("leaves focus in a frame of the surface's own, and with the person's own field", async () => {
  const { surface, field } = surfaceOverPage();
  const own = mount("iframe", surface);
  pageTakesFocus(own);
  await focusMoved();
  expect(document.activeElement).toBe(own);
  const elsewhere = mount("input");
  elsewhere.focus();
  await focusMoved();
  expect(document.activeElement).toBe(elsewhere);
  expect(document.activeElement).not.toBe(field);
});

it("yields while the keys are another surface's, and once it stops", async () => {
  let holds = false;
  const { page, field } = surfaceOverPage({ holdsKeys: () => holds });
  pageTakesFocus(page);
  await focusMoved();
  expect(document.activeElement).toBe(page);
  holds = true;
  for (const stop of stops.splice(0)) stop();
  field.focus();
  pageTakesFocus(page);
  await focusMoved();
  expect(document.activeElement).toBe(page);
});
