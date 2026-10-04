/**
 * Focus the app moves on its own, as a surface arrives (a New Tab's address
 * bar, a chat's composer), as opposed to focus the person moves. The
 * person's latest action wins: a surface waiting to hand focus over (a
 * chat's deferred autofocus) yields to keyboard, pointer and assistive
 * technology, but not to another surface arriving, and a surface arriving
 * late does not take focus the person has since put somewhere else.
 */
let moving = 0;
let inputs = 0;

/** A key or press from the person; keys inside a page arrive from main. */
export function notePersonInput(): void {
  inputs += 1;
}
// Counted as the app loads, ahead of every other window listener, so no
// shortcut handler that stops a key keeps it from being counted.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", notePersonInput, true);
  window.addEventListener("pointerdown", notePersonInput, true);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("keydown", notePersonInput, true);
    window.removeEventListener("pointerdown", notePersonInput, true);
  });
}

/** Run `move` as the app's own focus move. */
export function moveFocusAsApp(move: () => void): void {
  moving += 1;
  try {
    move();
  } finally {
    moving -= 1;
  }
}

/** A focus event happening now comes from the app, not the person. */
export function appIsMovingFocus(): boolean {
  return moving > 0;
}

/** How many keys and presses the person has made; only compared. */
export function personInputCount(): number {
  return inputs;
}

/**
 * Since `count` the person has acted and put focus somewhere: a surface
 * asked for then no longer takes it. Keys typed with nothing focused yet
 * (straight after opening a New Tab) still leave the greeting to it.
 */
export function personMovedOn(count: number | null): boolean {
  const active = document.activeElement;
  return (
    inputs !== count &&
    active !== null &&
    active !== document.body &&
    active !== document.documentElement
  );
}
