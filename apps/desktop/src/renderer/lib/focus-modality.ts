/**
 * Focus rings follow keyboard navigation (DESIGN.md "Focus rings").
 *
 * Chromium turns :focus-visible on for whatever holds focus after any key
 * press, so pressing Escape to cancel a right-click menu lit the row focus
 * returned to, and so did Enter on a clicked button. The root carries
 * `data-focus-modality`: "pointer" after a press with a mouse, pen or touch,
 * "keyboard" after a key that moves focus. styles.css resolves the ring style
 * to none while the pointer leads. Other keys (Escape, Enter, typing,
 * shortcuts) keep whichever input led last.
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

export function installFocusModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const set = (modality: FocusModality) => {
    if (root.dataset.focusModality !== modality)
      root.dataset.focusModality = modality;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (NAVIGATION_KEYS.has(event.key)) set("keyboard");
  };
  const onPointerDown = () => set("pointer");
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    delete root.dataset.focusModality;
  };
}
