import type { AgentTextAttachment } from "@catamorphic/react";
import { selectionFromClipboard } from "./editor-selection";
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
