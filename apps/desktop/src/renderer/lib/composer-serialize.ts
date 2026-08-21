import { ATTACHMENT_MARKER } from "@catamorphic/react";

/**
 * Reading the composer's contenteditable back into a message. The DOM is
 * the source of truth (Chromium owns typing, IME, undo); this walk turns
 * it into the wire shape: prose with one {@link ATTACHMENT_MARKER} per
 * inline pill, plus the pills' attachments in marker order.
 *
 * Structural node types keep this testable without a DOM: anything with
 * `nodeType`, `nodeName`, `childNodes`, `nodeValue` and `getAttribute`
 * walks (real Nodes do).
 */

export const PILL_ATTR = "data-pill-id";

export interface WalkableNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string | null;
  childNodes: ArrayLike<WalkableNode>;
  getAttribute?: (name: string) => string | null;
}

export interface SerializedComposer<T> {
  /** Prose with a marker where each live pill sits; trimmed. */
  message: string;
  /** Pills in marker order (exiting pills are skipped). */
  attachments: T[];
  /** Prose without markers — what "the draft says" (slash menu, emptiness). */
  text: string;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCKS = new Set(["DIV", "P", "LI", "PRE", "BLOCKQUOTE"]);

/**
 * @param root the editable element
 * @param resolve pill id → its attachment, or null when the pill is mid
 *   removal (or unknown) and must not ship
 */
export function serializeComposer<T>(
  root: WalkableNode,
  resolve: (pillId: string) => T | null,
): SerializedComposer<T> {
  let out = "";
  const attachments: T[] = [];
  const walk = (node: WalkableNode) => {
    if (node.nodeType === TEXT_NODE) {
      // NBSPs are Chromium's way of keeping edge spaces alive; the message
      // wants ordinary spaces. Zero-width joiners/spaces from caret tricks
      // never belong to the prose. A literal U+FFFC in TEXT is a pasted
      // object-replacement char (Word/PDF text flavors carry them) \u2014 it
      // must never survive as prose, because it IS the attachment marker
      // and a phantom one shifts every pill's positional mapping.
      out += (node.nodeValue ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\u200B|\u200C|\u200D|\uFEFF|\uFFFC/g, "");
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const name = node.nodeName;
    if (name === "BR") {
      out += "\n";
      return;
    }
    const pillId = node.getAttribute?.(PILL_ATTR);
    if (pillId) {
      const attachment = resolve(pillId);
      if (attachment !== null) {
        attachments.push(attachment);
        out += ATTACHMENT_MARKER;
      }
      return;
    }
    const block = BLOCKS.has(name);
    if (block && out.length > 0 && !out.endsWith("\n")) out += "\n";
    const children = node.childNodes;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child) walk(child);
    }
    if (block && !out.endsWith("\n")) out += "\n";
  };
  const children = root.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child) walk(child);
  }
  const message = out.trim();
  return {
    message,
    attachments,
    text: message.split(ATTACHMENT_MARKER).join(""),
  };
}

/** Split a sent message into prose runs and pill slots (timeline render). */
export function splitAttachmentMarkers(
  message: string,
): Array<{ type: "text"; text: string } | { type: "pill"; index: number }> {
  const parts: Array<
    { type: "text"; text: string } | { type: "pill"; index: number }
  > = [];
  let index = 0;
  let cursor = 0;
  for (let at = message.indexOf(ATTACHMENT_MARKER); at !== -1; ) {
    if (at > cursor)
      parts.push({ type: "text", text: message.slice(cursor, at) });
    parts.push({ type: "pill", index });
    index += 1;
    cursor = at + ATTACHMENT_MARKER.length;
    at = message.indexOf(ATTACHMENT_MARKER, cursor);
  }
  if (cursor < message.length) {
    parts.push({ type: "text", text: message.slice(cursor) });
  }
  return parts;
}
