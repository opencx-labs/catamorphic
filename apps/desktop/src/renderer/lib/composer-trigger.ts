import { PILL_ATTR } from "./composer-serialize";

/**
 * A composer's menus (ADR 0274) open from the word the caret ends: "/" for
 * skills and the chat's commands, "@" to mention a file, folder, tab, chat,
 * workflow or app. Either starts any word, mid-message too.
 */
export type ComposerTriggerChar = "/" | "@";

export interface ComposerTrigger {
  char: ComposerTriggerChar;
  /** What follows the trigger, up to the caret. */
  query: string;
  /** The text node holding the word, where the trigger sits and the caret. */
  node: Text;
  start: number;
  end: number;
}

/** Characters that end a word: whitespace and the editor's zero-width guards. */
const BOUNDARY = "\\s\\u00a0\\u200b-\\u200d\\ufeff";
const WORD = new RegExp(`(?:^|[${BOUNDARY}])([/@])([^${BOUNDARY}]*)$`);

/**
 * The trigger starting the last word of `before`, the text up to the
 * caret. A second "/" makes the word a path (`src/lib`), a second "@" an
 * address; neither opens a menu.
 */
export function triggerInText(
  before: string,
): { char: ComposerTriggerChar; query: string; start: number } | null {
  const match = WORD.exec(before);
  const char = match?.[1];
  const query = match?.[2] ?? "";
  if (char !== "/" && char !== "@") return null;
  if (query.includes(char) || query.length > 128) return null;
  return { char, query, start: before.length - query.length - 1 };
}

/** The trigger the collapsed caret in `root` ends, if any. */
export function triggerAtCaret(root: HTMLElement): ComposerTrigger | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed)
    return null;
  const { startContainer: node, startOffset: end } = selection.getRangeAt(0);
  if (!(node instanceof Text) || !root.contains(node)) return null;
  if (node.parentElement?.closest(`[${PILL_ATTR}]`)) return null;
  const found = triggerInText((node.nodeValue ?? "").slice(0, end));
  return found ? { ...found, node, end } : null;
}

/** The range a trigger and its word cover, while the text still holds it. */
export function triggerRange(trigger: ComposerTrigger): Range | null {
  const text = trigger.node.nodeValue ?? "";
  if (
    !trigger.node.isConnected ||
    text.slice(trigger.start, trigger.end) !== `${trigger.char}${trigger.query}`
  )
    return null;
  const range = trigger.node.ownerDocument.createRange();
  range.setStart(trigger.node, trigger.start);
  range.setEnd(trigger.node, trigger.end);
  return range;
}

/** The same word: a dismissed menu stays closed until another word starts. */
export function sameTrigger(
  a: Pick<ComposerTrigger, "node" | "start" | "char"> | null,
  b: Pick<ComposerTrigger, "node" | "start" | "char"> | null,
): boolean {
  return Boolean(
    a && b && a.node === b.node && a.start === b.start && a.char === b.char,
  );
}
