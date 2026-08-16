import type {
  AgentAttachment,
  AgentMediaAttachment,
  AgentTextAttachment,
} from "./types.js";

/**
 * Text attachments (pastes, editor selections, URLs, paths) are context the
 * user pinned beside their words. Every harness renders them the same way:
 * a labelled block after the prose, fenced so the model can tell where the
 * user's message ends and the pinned material begins. Kept in one place so
 * the built-in agent and Claude Code describe the same pill identically.
 */

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
  }
}

/**
 * Render the text attachments as a context block to append after the user's
 * message. Empty string when there are none. Fences use a distinctive
 * delimiter so pasted markdown fences can't close them early.
 */
export function renderTextAttachments(attachments: AgentAttachment[]): string {
  const texts = attachments.filter(isTextAttachment);
  if (texts.length === 0) return "";
  const blocks = texts.map((attachment, index) => {
    const header = `[Attached context ${index + 1}/${texts.length} — ${describeTextSource(attachment)}]`;
    // URL/path pills carry the reference itself as their text; no need to
    // fence a one-liner.
    if (attachment.source.type === "url" || attachment.source.type === "path") {
      return header;
    }
    return `${header}\n<<<\n${attachment.text}\n>>>`;
  });
  return `\n\n${blocks.join("\n\n")}`;
}
