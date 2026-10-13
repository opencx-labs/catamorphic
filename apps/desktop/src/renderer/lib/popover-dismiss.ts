import { type RefObject, useEffect, useRef } from "react";
import { onPagePress } from "./app-focus.js";

/**
 * What a popover opened above itself, whose presses belong to it: a row's
 * hover card, and a menu with its shield (a press on the shield only
 * closes the menu, ADR 0221).
 */
const ABOVE =
  "[data-resource-inspector], [data-sidebar-menu], [data-menu-shield]";

/**
 * How a popover that is not a menu (a switcher, a bubble) closes: on a
 * press anywhere outside it, a press inside a web page (pages run in their
 * own process and report their presses, preload/webview.ts), the window
 * losing focus (another app, or an app's frame taking it), and Escape.
 * Unlike a menu, a popover lets the press through to what it lands on.
 * Menus close through MenuPortal, whose shield also keeps the press from
 * acting; design lint keeps either from rolling its own listeners.
 *
 * Escape goes to the innermost surface first: a menu or hover card above
 * the popover claims it (`preventDefault`), and the popover claims it from
 * window listeners such as the expanded chat's.
 */
export function usePopoverDismiss({
  open,
  within,
  onDismiss,
  returnFocus,
  closeOnBlur = true,
}: {
  open: boolean;
  /** The popover and the control that opens it. */
  within: readonly RefObject<Element | null>[];
  onDismiss: () => void;
  /** Where focus goes when Escape closes the popover with focus inside. */
  returnFocus?: RefObject<HTMLElement | null>;
  /**
   * False for a popover whose rows open native menus, which may take the
   * window's focus while it should stay.
   */
  closeOnBlur?: boolean;
}): void {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const withinRef = useRef(within);
  withinRef.current = within;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  useEffect(() => {
    if (!open) return;
    const contains = (node: unknown) =>
      node instanceof Node &&
      withinRef.current.some((ref) => ref.current?.contains(node));
    const dismiss = () => dismissRef.current();
    const press = (event: PointerEvent) => {
      if (contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(ABOVE))
        return;
      dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      const focusInside = contains(document.activeElement);
      dismiss();
      if (focusInside) returnFocusRef.current?.current?.focus();
    };
    window.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key);
    if (closeOnBlur) window.addEventListener("blur", dismiss);
    const stopPagePress = onPagePress(dismiss);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", dismiss);
      stopPagePress();
    };
  }, [open, closeOnBlur]);
}
