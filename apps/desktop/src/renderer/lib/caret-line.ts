/** The textarea's styles that decide where its lines wrap. */
const LAYOUT = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-feature-settings",
  "font-variation-settings",
  "font-kerning",
  "letter-spacing",
  "word-spacing",
  "line-height",
  "text-transform",
  "text-indent",
  "text-rendering",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
] as const;

/**
 * Whether ↑ (or ↓) has a line to move a textarea's caret to, wrapped lines
 * included: ↑ from below its first line, ↓ from above its last. Past them,
 * the keys belong to what is above or below. A hidden copy with the
 * textarea's type, laid out in the width its text wraps in, finds the
 * caret's line.
 */
export function caretCanMove(
  textarea: HTMLTextAreaElement,
  direction: "up" | "down",
): boolean {
  const { value, selectionStart, selectionEnd } = textarea;
  const style = getComputedStyle(textarea);
  const copy = document.createElement("div");
  for (const property of LAYOUT) {
    copy.style.setProperty(property, style.getPropertyValue(property));
  }
  const px = (property: string) =>
    Number.parseFloat(style.getPropertyValue(property)) || 0;
  const borders = px("border-left-width") + px("border-right-width");
  // Unrounded, unlike clientWidth: a width rounded to the pixel wrapped
  // some lines differently from the textarea's own.
  const contentWidth =
    px("width") -
    (style.boxSizing === "border-box"
      ? borders + px("padding-left") + px("padding-right")
      : 0) -
    // A classic scrollbar narrows the lines too.
    Math.max(0, textarea.offsetWidth - textarea.clientWidth - borders);
  Object.assign(copy.style, {
    position: "fixed",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "content-box",
    padding: "0",
    border: "0",
    width: `${contentWidth}px`,
  });
  const marker = (text = "") => {
    const span = document.createElement("span");
    span.textContent = text;
    return copy.appendChild(span);
  };
  const up = direction === "up";
  const at = up ? selectionStart : selectionEnd;
  // Going up, the caret is the character after it, not an empty marker:
  // where a line wraps, an empty marker sits at the end of the line above,
  // and a caret starting the wrapped line could never go up. Going down,
  // that same placement only ever leaves the key to the text.
  const next = value[at];
  const own = up && next !== undefined && next !== "\n";
  const start = marker();
  copy.append(value.slice(0, at));
  const caret = marker(own ? next : "");
  copy.append(value.slice(at + (own ? 1 : 0)));
  const end = marker();
  document.body.append(copy);
  const moves = caret.offsetTop !== (up ? start : end).offsetTop;
  copy.remove();
  return moves;
}
