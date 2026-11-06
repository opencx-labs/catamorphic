/** Input types that hold a line of text the caret moves through. */
const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "email",
  "password",
  "tel",
  "number",
]);

/** Keys that move a caret (by word, to the line's ends, with modifiers). */
const CARET_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

/** What of a DOM element this reads (shared code carries no DOM types). */
interface FocusedElement {
  tagName: string;
  getAttribute(name: string): string | null;
  isContentEditable?: boolean;
  shadowRoot?: { activeElement: FocusedElement | null } | null;
}

/**
 * Whether an element takes typing: a text input, a textarea, or editable
 * content (the composer, an editor). Focus inside a shadow root (a site's
 * custom search box) counts as the field it lands in.
 */
export function isTextField(
  element: FocusedElement | null | undefined,
): boolean {
  if (!element) return false;
  const inner = element.shadowRoot?.activeElement;
  if (inner) return isTextField(inner);
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT")
    return TEXT_INPUT_TYPES.has(
      (element.getAttribute("type") ?? "").toLowerCase(),
    );
  return element.isContentEditable === true;
}

/**
 * isTextField as a script for a frame main can only ask (an embedded
 * frame, which has no preload): true when its focus is in a text field.
 */
export const TEXT_FIELD_PROBE = `(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element) return false;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT")
    return ${JSON.stringify([...TEXT_INPUT_TYPES])}.includes((element.getAttribute("type") ?? "").toLowerCase());
  return element.isContentEditable === true;
})()`;

/** The key and modifiers of a press (a KeyboardEvent or main's input). */
interface CaretEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Whether a press moves a text field's caret: a caret key with the
 * modifiers the platform's text system moves by (none, Option or Cmd on
 * macOS; none or Ctrl elsewhere; each also with Shift, which selects).
 * Cmd+Option+Left moves no caret, so a binding on it is no caret key.
 */
export function isCaretKey(input: {
  event: CaretEvent;
  mac: boolean;
}): boolean {
  const { event } = input;
  if (!CARET_KEYS.has(event.key)) return false;
  return input.mac
    ? !event.ctrlKey && !(event.metaKey && event.altKey)
    : !event.metaKey && !event.altKey;
}

/**
 * Whether the focused text field keeps a press for its caret, whatever the
 * key is bound to: Cmd+Left and Cmd+Right move to the line's start and end
 * there (as everywhere on macOS), not back and forward.
 */
export function fieldKeepsKey(input: {
  event: CaretEvent;
  focused: FocusedElement | null | undefined;
  mac: boolean;
}): boolean {
  return isCaretKey(input) && isTextField(input.focused);
}
