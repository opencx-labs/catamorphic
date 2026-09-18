/**
 * Script-driven motion honours the same preference CSS does. Every Web
 * Animations call in the renderer takes its duration from here so reduced
 * motion collapses it to an instant change instead of a shorter tween.
 */
export const EASE_STANDARD = "cubic-bezier(0.2, 0, 0, 1)";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** A tween duration, or 0 when the user asked for reduced motion. */
export function motionMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}
