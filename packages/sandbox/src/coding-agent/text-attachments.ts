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
      return describeLink(source.url);
    case "path":
      return source.path.endsWith("/")
        ? `Folder: ${source.path}`
        : `File path: ${source.path}`;
    case "tab": {
      const where = source.url ?? source.filePath;
      return `Open ${source.kind} tab "${source.title}"${where ? ` (${where})` : ""} — key ${source.key}; read it with read_tab`;
    }
    case "skill":
      return source.path
        ? `Skill "${source.name}" at ${JSON.stringify(source.path)}: follow it for this message`
        : `Skill "${source.name}": use it for this message`;
  }
}

/**
 * A link the person mentioned: a project's workflow, app or chat reads as
 * what it is, any other address as a URL.
 */
function describeLink(url: string): string {
  const [, scheme, name] = /^(workflow|app|session):(.+)$/.exec(url) ?? [];
  if (scheme === "workflow") return `Workflow ${name} (link ${url})`;
  if (scheme === "app") return `App ${name} (link ${url})`;
  if (scheme === "session")
    return `Chat session ${name} in this project; read it with read_project_session`;
  return `URL: ${url}`;
}

/** Sources whose text IS the reference: no fence needed. */
const isBareReference = (attachment: AgentTextAttachment): boolean =>
  attachment.source.type === "url" ||
  attachment.source.type === "path" ||
  attachment.source.type === "tab" ||
  attachment.source.type === "skill";

/** The minimal attachment shape the marker helpers need: a display name. */
interface NamedAttachment {
  name: string;
}

/** `[attachment 2: name]` — the inline stand-in for a marker. */
const inlineReference = (index: number, attachment: NamedAttachment): string =>
  `[attachment ${index + 1}: ${attachment.name}]`;

/**
 * Replace each inline marker with the matching attachment's short
 * reference. Markers past the attachment list are dropped; attachments
 * without a marker are untouched (the caller appends them). Used for the
 * model prompt and for anything that shows the message as plain text
 * (session titles).
 */
export function inlineAttachmentReferences<T extends NamedAttachment>(
  message: string,
  attachments: readonly T[],
  render: (index: number, attachment: T) => string = inlineReference,
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

/**
 * A sent message as prose runs and attachment slots, in order: the
 * timeline draws each slot as its attachment's pill.
 */
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

/** Message text with markers replaced by `[name]` — for titles and labels. */
export function messageWithAttachmentNames(
  message: string,
  attachments: ReadonlyArray<NamedAttachment> | undefined,
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
 * delivers their bytes its own way (image parts, temp files). A harness
 * that cannot deliver media at all passes `omitMedia`: each media marker
 * becomes an explicit non-delivery note instead of a bare reference the
 * model would go looking for. Numbering still counts media attachments
 * either way, so text attachment numbers never shift.
 */
export function renderUserMessage(
  message: string,
  attachments: AgentAttachment[] | undefined,
  opts?: { omitMedia?: boolean },
): string {
  const list = attachments ?? [];
  const render = opts?.omitMedia
    ? (index: number, attachment: AgentAttachment) =>
        isTextAttachment(attachment)
          ? inlineReference(index, attachment)
          : `[attachment ${index + 1}: ${attachment.name} (${attachment.kind} not delivered; this agent reads text only)]`
    : undefined;
  return `${inlineAttachmentReferences(message, list, render)}${renderTextAttachments(list)}`;
}

/**
 * Text that keeps one inline marker per attachment: markers past the
 * attachments go, and attachments without one get theirs at the end, so
 * the n-th marker always names the n-th attachment.
 */
export function withMarkerCount(text: string, attachments: number): string {
  let kept = 0;
  const placed = text.replace(new RegExp(ATTACHMENT_MARKER, "g"), () => {
    kept += 1;
    return kept <= attachments ? ATTACHMENT_MARKER : "";
  });
  return placed + ATTACHMENT_MARKER.repeat(Math.max(0, attachments - kept));
}

/**
 * A question's answer as the agent reads it (ADR 0244): the person's words
 * with inline references and each text pill's block after them, as a
 * message renders. An answer is text to every harness (Claude Code and
 * Codex take nothing else), so its images and documents follow the answers
 * as a message in the same turn; the answer names each one where it sat by
 * its number in that message, `firstFollowing` being this answer's first.
 */
export function renderQuestionAnswer(
  answer: string,
  attachments: AgentAttachment[] | undefined,
  firstFollowing = 1,
): string {
  const list = attachments ?? [];
  const following = (index: number) =>
    firstFollowing + list.slice(0, index).filter(isMediaAttachment).length;
  const prose = inlineAttachmentReferences(answer, list, (index, attachment) =>
    isTextAttachment(attachment)
      ? inlineReference(index, attachment)
      : `[attachment ${index + 1}: ${attachment.name}, attachment ${following(index)} of the message after these answers]`,
  );
  return `${prose}${renderTextAttachments(list)}`;
}
