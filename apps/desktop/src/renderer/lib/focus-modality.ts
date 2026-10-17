/**
 * Focus rings follow keyboard navigation (DESIGN.md "Focus rings").
 *
 * Chromium turns :focus-visible on for whatever holds focus after any key
 * press, so pressing Escape to cancel a right-click menu lit the row focus
 * returned to, and so did Enter on a clicked button. The root carries
 * `data-focus-modality`: "pointer" after a press with a mouse, pen or touch,
 * "keyboard" after a key that moves focus. styles.css resolves the ring style
 * to none while the pointer leads. Other keys (Escape, Enter, typing,
 * shortcuts) keep whichever input led last, unless a shortcut moves focus
 * somewhere new itself (`keyMovedFocus`).
 */
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F6",
  "ContextMenu",
]);

export type FocusModality = "keyboard" | "pointer";

/** Which kind of input came last in each document, any key included. */
const lastInputs = new WeakMap<Document, "key" | "pointer">();

/** Whether the latest input in the document was a key, any key. */
export function keyLedLast(doc: Document = document): boolean {
  return lastInputs.get(doc) === "key";
}

/**
 * A shortcut that moves focus somewhere new (opening a sidebar onto the
 * row of what is in front) leads with the keyboard, as a navigation key
 * does, so the ring shows where focus went; the same move made by a press
 * leaves the pointer leading.
 */
export function keyMovedFocus(doc: Document = document): void {
  if (keyLedLast(doc)) doc.documentElement.dataset.focusModality = "keyboard";
}

export function installFocusModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const set = (modality: FocusModality) => {
    if (root.dataset.focusModality !== modality)
      root.dataset.focusModality = modality;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    lastInputs.set(doc, "key");
    if (NAVIGATION_KEYS.has(event.key)) set("keyboard");
  };
  const onPointerDown = () => {
    lastInputs.set(doc, "pointer");
    set("pointer");
  };
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    lastInputs.delete(doc);
    delete root.dataset.focusModality;
  };
}
