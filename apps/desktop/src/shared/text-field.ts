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

/** Keys that move a caret (with any modifier: by word, to the line's ends). */
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

/**
 * Whether the focused text field keeps a key for its caret, whatever the
 * key is bound to: Cmd+Left and Cmd+Right move to the line's start and end
 * there (as everywhere on macOS), not back and forward.
 */
export function fieldKeepsKey(input: {
  key: string;
  focused: FocusedElement | null | undefined;
}): boolean {
  return CARET_KEYS.has(input.key) && isTextField(input.focused);
}
