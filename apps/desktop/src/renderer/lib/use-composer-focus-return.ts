import { type RefObject, useEffect, useRef } from "react";
import { moveFocusAsApp, onPagePress, personInputCount } from "./app-focus.js";

/**
 * A region of a chat whose controls move focus themselves: the chips
 * (arrows walk them, a group opens beside them), a question being answered
 * (picking an option moves on to the next question) and the header's
 * popovers. A press inside it leaves focus where the region puts it.
 */
export const OWN_FOCUS_ATTR = "data-own-focus";

const CONTROL = 'button, [role="button"]';
/** Controls that open something which takes, or needs, focus. */
const OPENS = '[aria-haspopup]:not([aria-haspopup="false"])';
const SURFACES = '[role="dialog"], [role="menu"], [role="listbox"]';

/** Focus is on nothing a key can reach. */
function nowhere(element: Element | null): boolean {
  return (
    element === null ||
    element === document.body ||
    element === document.documentElement ||
    !element.isConnected ||
    element.closest("[inert]") !== null
  );
}

/**
 * Where a chat parks focus that would otherwise fall to the page, such as
 * a message once its Steer now goes: held, not taken. A field or control
 * the action opened is not.
 */
function resting(element: Element | null): boolean {
  return (
    nowhere(element) ||
    (element instanceof HTMLElement &&
      element.getAttribute("tabindex") === "-1" &&
      !element.isContentEditable &&
      !element.matches(`${CONTROL}, a[href], input, textarea, select`))
  );
}

/** The element can no longer hold focus: removed, inert, disabled or hidden. */
function gone(element: Element): boolean {
  return (
    nowhere(element) ||
    element.matches(":disabled") ||
    element.checkVisibility?.() === false
  );
}

/**
 * The composer is where a chat's keys live, and an action taken in the
 * chat gives them back to it: Retry, an approval, Send or Stop, a queued
 * message sent now, a question's answers submitted, a disclosure opened.
 * Pressed with the pointer, a control in the chat no longer keeps focus
 * for itself; and a focused control that goes away (removed, disabled,
 * turned inert as its panel closes), however it was pressed, hands focus
 * to the composer rather than to nowhere. Keys pressing a control that
 * stays keep their place on it.
 *
 * Settled two frames later, once the action, and anything that puts focus
 * back for itself (the chips, the next question), has moved focus where it
 * means to: into a field it opened, a menu, another surface or window.
 * Those keep it. So does the person acting again in between, focus they
 * took away by pressing outside the chat (a press on the workspace lets a
 * working chat lurk, hiding the control that had focus), text they
 * selected in the chat, and a chat that is not in front. Losing focus is
 * read from Chromium's focusout, which it sends for a control removed,
 * disabled, hidden or turned inert; where it sends none, focus stays
 * where Chromium leaves it.
 */
export function useComposerFocusReturn({
  section,
  composer,
  focusComposer,
  canReturn,
}: {
  section: RefObject<HTMLElement | null>;
  /** The composer's editable. */
  composer: () => HTMLElement | null;
  /** Focus it, the caret where it was. */
  focusComposer: () => void;
  /** The chat is open and in front. */
  canReturn: () => boolean;
}): void {
  const latest = useRef({ composer, focusComposer, canReturn });
  latest.current = { composer, focusComposer, canReturn };
  useEffect(() => {
    const root = section.current;
    if (!root) return;
    let frame = 0;
    // What may hand focus back once things settle, each with the person's
    // input count when it was noted: acting since, they keep what they did.
    let pending: { input: number; returns: () => boolean }[] = [];
    const check = () => {
      const due = pending;
      pending = [];
      frame = 0;
      const { composer, focusComposer, canReturn } = latest.current;
      if (!document.hasFocus() || !canReturn()) return;
      const selection = document.getSelection();
      const editor = composer();
      const selecting =
        selection !== null &&
        !selection.isCollapsed &&
        !(
          editor &&
          selection.anchorNode &&
          editor.contains(selection.anchorNode)
        );
      if (selecting) return;
      const input = personInputCount();
      if (due.some((entry) => entry.input === input && entry.returns()))
        moveFocusAsApp(focusComposer);
    };
    // The person's latest press outside the chat (a page counts), by the
    // input count it made: focus lost to it is theirs.
    let pressedOutside = -1;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.contains(event.target))
        pressedOutside = personInputCount();
    };
    const offPagePress = onPagePress(() => {
      pressedOutside = personInputCount();
    });
    const settle = (returns: () => boolean) => {
      pending.push({ input: personInputCount(), returns });
      // Two whole frames from the latest, what came before waiting along.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(check);
      });
    };
    const onClick = (event: MouseEvent) => {
      // A key's click (Enter, Space) reports no detail: keys stay put.
      if (event.detail === 0 || event.button !== 0) return;
      const control =
        event.target instanceof Element ? event.target.closest(CONTROL) : null;
      // Inside the chat itself, not a menu or popover portalled from it.
      if (!control || !root.contains(control)) return;
      if (
        control.matches(OPENS) ||
        control.closest(SURFACES) ||
        control.closest(`[${OWN_FOCUS_ATTR}]`)
      )
        return;
      settle(() => {
        const focused = document.activeElement;
        return focused === control || resting(focused);
      });
    };
    const onFocusOut = (event: FocusEvent) => {
      // Focus going somewhere is the person's or the action's.
      if (event.relatedTarget !== null) return;
      const lost = event.target instanceof Element ? event.target : null;
      if (!lost || lost === latest.current.composer()) return;
      if (pressedOutside === personInputCount()) return;
      // Still there, it lost focus to a press on nothing: the person's.
      settle(() => nowhere(document.activeElement) && gone(lost));
    };
    // Capturing, after app-focus has counted the press.
    window.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("click", onClick);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      cancelAnimationFrame(frame);
      offPagePress();
      window.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("click", onClick);
      root.removeEventListener("focusout", onFocusOut);
    };
  }, [section]);
}
