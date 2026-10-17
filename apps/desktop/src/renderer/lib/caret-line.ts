/** The textarea's styles that decide where its lines wrap. */
const LAYOUT = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
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
 * Whether a textarea's selection starts on its first visual line and ends
 * on its last, wrapped lines included. ↑ and ↓ move the caret through the
 * lines between; past the first or the last they belong to what is above
 * or below. A hidden copy with the textarea's width and type lays the
 * text out with markers at the start, the selection's edges and the end.
 */
export function caretLine(textarea: HTMLTextAreaElement): {
  first: boolean;
  last: boolean;
} {
  const { value, selectionStart, selectionEnd } = textarea;
  const style = getComputedStyle(textarea);
  const copy = document.createElement("div");
  for (const property of LAYOUT) {
    copy.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(copy.style, {
    position: "fixed",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    border: "0",
    boxSizing: "border-box",
    // The width text wraps in: the textarea's, less a scrollbar's.
    width: `${textarea.clientWidth}px`,
  });
  const marker = () => copy.appendChild(document.createElement("span"));
  const start = marker();
  copy.append(value.slice(0, selectionStart));
  const from = marker();
  copy.append(value.slice(selectionStart, selectionEnd));
  const to = marker();
  copy.append(value.slice(selectionEnd));
  const end = marker();
  document.body.append(copy);
  const result = {
    first: from.offsetTop === start.offsetTop,
    last: to.offsetTop === end.offsetTop,
  };
  copy.remove();
  return result;
}
