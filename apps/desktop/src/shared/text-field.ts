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

/** What of a DOM element this reads (shared code carries no DOM types). */
interface FocusedElement {
  tagName: string;
  getAttribute(name: string): string | null;
  isContentEditable?: boolean;
}

/**
 * Whether an element takes typing: a text input, a textarea, or editable
 * content (the composer, an editor). There, Cmd+Left and Cmd+Right move the
 * caret to the line's start or end, as everywhere on macOS.
 */
export function isTextField(
  element: FocusedElement | null | undefined,
): boolean {
  if (!element) return false;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT")
    return TEXT_INPUT_TYPES.has(
      (element.getAttribute("type") ?? "").toLowerCase(),
    );
  return element.isContentEditable === true;
}
