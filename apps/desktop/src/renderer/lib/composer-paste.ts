import type { AgentTextAttachment } from "@catamorphic/react";
import { selectionFromClipboard } from "./editor-selection";
import { TAB_DRAG_TYPE, type TabDragPayload } from "./tab-drag";
import { classifyPastedText, selectionName, textPill } from "./text-pills";

/**
 * What a paste into a composer-style input brings: files to attach, a text
 * pill (an editor selection, a long paste, a link or a path), or plain text
 * to type. The chat composer and a question's Other answer read pastes the
 * same way.
 */
export type ComposerPaste =
  | { kind: "files"; files: File[] }
  | { kind: "pill"; pill: AgentTextAttachment }
  | { kind: "text"; text: string }
  | { kind: "nothing" };

/**
 * Files from a DataTransfer, robust across sources: `files` covers
 * screenshots and copied images; the `items` fallback covers sources
 * that only populate the item list.
 */
export function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length > 0) return files;
  return [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function readComposerPaste(data: DataTransfer | null): ComposerPaste {
  const files = filesFrom(data);
  if (files.length > 0) return { kind: "files", files };
  const fromEditor = selectionFromClipboard(data);
  if (fromEditor) {
    return {
      kind: "pill",
      pill: textPill(
        fromEditor.text.replace(/\r\n?/g, "\n"),
        {
          type: "selection",
          filePath: fromEditor.filePath,
          ...(fromEditor.startLine !== undefined
            ? { startLine: fromEditor.startLine }
            : {}),
          ...(fromEditor.endLine !== undefined
            ? { endLine: fromEditor.endLine }
            : {}),
        },
        selectionName(fromEditor),
      ),
    };
  }
  let text = data?.getData("text/plain") ?? "";
  if (!text) {
    // Copy buttons that write only a text/html flavor (ClipboardItem)
    // must still paste something: take the markup's text.
    const html = data?.getData("text/html") ?? "";
    if (html) {
      text =
        new DOMParser().parseFromString(html, "text/html").body.textContent ??
        "";
    }
  }
  const classified = classifyPastedText(text);
  if (classified.kind === "pill") {
    return {
      kind: "pill",
      pill: textPill(
        text.replace(/\r\n?/g, "\n"),
        classified.source,
        classified.name,
      ),
    };
  }
  // Rich clipboards (HTML from a page) land as plain text: the input is
  // prose, not a document.
  return text
    ? { kind: "text", text: text.replace(/\r\n?/g, "\n") }
    : { kind: "nothing" };
}

/** A workspace tab dropped on the chat becomes a tab pill. */
export function tabPillFromDrag(
  data: DataTransfer | null,
): AgentTextAttachment | null {
  const raw = data?.getData(TAB_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<
      Record<keyof TabDragPayload, unknown>
    >;
    if (typeof parsed.key !== "string" || typeof parsed.kind !== "string") {
      return null;
    }
    const title =
      typeof parsed.title === "string" && parsed.title
        ? parsed.title
        : parsed.kind;
    const detail =
      typeof parsed.detail === "string" ? parsed.detail : undefined;
    const source: AgentTextAttachment["source"] = {
      type: "tab",
      key: parsed.key,
      kind: parsed.kind,
      title,
      ...(parsed.kind === "browser" && detail ? { url: detail } : {}),
      ...(parsed.kind === "editor" && detail ? { filePath: detail } : {}),
    };
    // What the model reads without a tool call: title + address/path.
    const text = detail ? `${title} — ${detail}` : title;
    return textPill(text, source, title);
  } catch {
    return null;
  }
}

/** Whether a drag carries something the composer can attach. */
export function isComposerTransfer(data: DataTransfer | null): boolean {
  const types = [...(data?.types ?? [])];
  return types.includes("Files") || types.includes(TAB_DRAG_TYPE);
}
