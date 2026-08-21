import type {
  AgentAttachment,
  AgentMediaAttachment,
  AgentTextAttachment,
} from "./types.js";

/**
 * Attachments (pastes, editor selections, URLs, paths, tabs, media) are
 * context the user pinned beside — or inside — their words. Every harness
 * renders them the same way, from one place, so the built-in agent, Claude
 * Code and Codex describe the same pill identically:
 *
 * - The composer keeps pills INLINE and marks each spot in the message with
 *   {@link ATTACHMENT_MARKER} (U+FFFC OBJECT REPLACEMENT CHARACTER, the
 *   character text systems use for "an object sits here"). The n-th marker
 *   is the n-th attachment. Marker-less attachments (other clients, older
 *   messages) are simply appended.
 * - The prose gets each marker replaced by a short inline reference
 *   (`[attachment 2: sel.md · 3–10]`), then a labelled, fenced block per
 *   text attachment follows so the model can tell where the user's message
 *   ends and the pinned material begins.
 */

export const ATTACHMENT_MARKER = "￼";

export const isTextAttachment = (
  attachment: AgentAttachment,
): attachment is AgentTextAttachment => attachment.kind === "text";

export const isMediaAttachment = (
  attachment: AgentAttachment,
): attachment is AgentMediaAttachment => attachment.kind !== "text";

/** Human/model-facing one-liner describing where the text came from. */
export function describeTextSource(attachment: AgentTextAttachment): string {
  const { source } = attachment;
  switch (source.type) {
    case "paste":
      return "Pasted text";
    case "selection": {
      const range =
        source.startLine !== undefined
          ? source.endLine !== undefined && source.endLine !== source.startLine
            ? `, lines ${source.startLine}–${source.endLine}`
            : `, line ${source.startLine}`
          : "";
      return `Selected in ${source.filePath}${range}`;
    }
    case "url":
      return `URL: ${source.url}`;
    case "path":
      return `File path: ${source.path}`;
    case "tab": {
      const where = source.url ?? source.filePath;
      return `Open ${source.kind} tab "${source.title}"${where ? ` (${where})` : ""} — key ${source.key}; read it with workspace_read_tab`;
    }
  }
}

/** Sources whose text IS the reference: no fence needed. */
const isBareReference = (attachment: AgentTextAttachment): boolean =>
  attachment.source.type === "url" ||
  attachment.source.type === "path" ||
  attachment.source.type === "tab";

/** `[attachment 2: name]` — the inline stand-in for a marker. */
const inlineReference = (index: number, attachment: AgentAttachment): string =>
  `[attachment ${index + 1}: ${attachment.name}]`;

/**
 * Replace each inline marker with the matching attachment's short
 * reference. Markers past the attachment list are dropped; attachments
 * without a marker are untouched (the caller appends them). Used for the
 * model prompt and for anything that shows the message as plain text
 * (session titles).
 */
export function inlineAttachmentReferences(
  message: string,
  attachments: AgentAttachment[],
  render: (
    index: number,
    attachment: AgentAttachment,
  ) => string = inlineReference,
): string {
  if (!message.includes(ATTACHMENT_MARKER)) return message;
  let next = 0;
  return message.replace(new RegExp(ATTACHMENT_MARKER, "g"), () => {
    const attachment = attachments[next];
    const index = next;
    next += 1;
    return attachment ? render(index, attachment) : "";
  });
}

/** Message text with markers replaced by `[name]` — for titles and labels. */
export function messageWithAttachmentNames(
  message: string,
  attachments: AgentAttachment[] | undefined,
): string {
  return inlineAttachmentReferences(
    message,
    attachments ?? [],
    (_index, attachment) => `[${attachment.name}]`,
  );
}

/**
 * Render the text attachments as a context block to append after the user's
 * message. Empty string when there are none. Blocks are numbered by their
 * position in the FULL attachment list (media included) so the inline
 * references and the blocks agree. Fences use a distinctive delimiter so
 * pasted markdown fences can't close them early.
 */
export function renderTextAttachments(attachments: AgentAttachment[]): string {
  const blocks = attachments.flatMap((attachment, index) => {
    if (!isTextAttachment(attachment)) return [];
    const header = `[Attachment ${index + 1}: ${attachment.name} — ${describeTextSource(attachment)}]`;
    // URL/path/tab pills carry the reference itself as their text; no need
    // to fence a one-liner.
    if (isBareReference(attachment)) return [header];
    return [`${header}\n<<<\n${attachment.text}\n>>>`];
  });
  if (blocks.length === 0) return "";
  return `\n\n${blocks.join("\n\n")}`;
}

/**
 * The full model-facing text for a user turn: prose with inline references
 * in place of markers, then the text-attachment blocks. Media attachments
 * are referenced inline too (`[attachment 3: shot.png]`) — the harness
 * delivers their bytes its own way (image parts, temp files).
 */
export function renderUserMessage(
  message: string,
  attachments: AgentAttachment[] | undefined,
): string {
  const list = attachments ?? [];
  return `${inlineAttachmentReferences(message, list)}${renderTextAttachments(list)}`;
}
