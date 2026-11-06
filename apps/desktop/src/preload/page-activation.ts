/** Keys that touch nothing: Escape and modifiers on their way to shortcuts. */
const INERT_KEYS = new Set([
  "Escape",
  "Meta",
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "CapsLock",
  "Fn",
  "OS",
]);

/** Report a document's first real interaction, including a cached history restore. */
export function installPageActivation(report: () => void): () => void {
  let reported = false;
  const activated = () => {
    if (reported) return;
    reported = true;
    report();
  };
  const pressed = (event: Event) => {
    if (!event.isTrusted) return;
    if (event instanceof KeyboardEvent && INERT_KEYS.has(event.key)) return;
    activated();
  };
  const shown = (event: PageTransitionEvent) => {
    if (!event.isTrusted) return;
    reported = false;
    // A cached document keeps its sticky activation. Main discarded its
    // old record when another document committed, so publish it again now,
    // without a script query or waiting when its tab is later closed.
    if (navigator.userActivation.hasBeenActive) activated();
  };
  const inputs = ["pointerdown", "keydown", "beforeinput"] as const;
  for (const type of inputs)
    window.addEventListener(type, pressed, { capture: true, passive: true });
  window.addEventListener("pageshow", shown, { capture: true, passive: true });
  return () => {
    for (const type of inputs) window.removeEventListener(type, pressed, true);
    window.removeEventListener("pageshow", shown, true);
  };
}
