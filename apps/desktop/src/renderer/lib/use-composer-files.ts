import { type RefObject, useRef, useState } from "react";
import type {
  ComposerAttachment,
  ComposerInputHandle,
} from "../components/composer-input";
import { desktopApi } from "./desktop-api";
import { textPill } from "./text-pills";

/** Document types the composer accepts as pasted/attached files. */
const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Total decoded media budget per message: keeps the request body far below
 * the server's limit. Files past it still attach — as path pills.
 */
const MAX_TOTAL_MEDIA_BYTES = 48 * 1024 * 1024;

/** Server-side attachment cap, mirrored so the composer can refuse early. */
export const MAX_ATTACHMENTS = 32;
/** The media kind a file would ship as, or null for unsupported types. */
function mediaKindOf(file: File): "image" | "document" | null {
  return file.type.startsWith("image/")
    ? "image"
    : DOCUMENT_TYPES.has(file.type)
      ? "document"
      : null;
}

async function encodeFile(
  file: File,
  kind: "image" | "document",
): Promise<ComposerAttachment> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    id: crypto.randomUUID(),
    kind,
    name: file.name || (kind === "image" ? "pasted-image.png" : "pasted-file"),
    mediaType: file.type,
    dataBase64: btoa(binary),
  };
}

/** A file that can't ship as media still reaches the agent as a path. */
function pathPillFor(file: File): ComposerAttachment | null {
  // e2e seam: synthetic Files have no OS path, so tests inject one.
  const lookup =
    (window as { __e2ePathForFile?: (file: File) => string })
      .__e2ePathForFile ?? desktopApi.pathForFile;
  const path = lookup(file);
  if (!path) return null;
  const name = file.name || path.split(/[\\/]/).at(-1) || path;
  return {
    id: crypto.randomUUID(),
    ...textPill(path, { type: "path", path }, name),
  };
}

/** Shared file preparation for every composer surface, with one serialized budget. */
export function useComposerFiles({
  projectId,
  accepts,
  owner,
}: {
  projectId: string;
  accepts: readonly string[];
  owner: RefObject<ComposerInputHandle | null>;
}) {
  const [transferError, setTransferError] = useState<string>();
  const [pendingTransfers, setPendingTransfers] = useState(0);
  const pendingTransfersRef = useRef(0);
  /** Serialize transfers so budgets, caret position and send stay coherent. */
  const addFilesQueueRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * Files into a composer-style input, the chat's composer or a question's
   * Other answer, which a message or an answer carries alike.
   */
  const addFilesTo = (
    composer: ComposerInputHandle | null,
    files: File[],
    at?: { x: number; y: number },
  ) => {
    const initiatingOwner = owner.current;
    const root = composer?.element();
    if (files.length === 0 || !composer || !root) return;
    const selection = window.getSelection();
    const currentRange = at
      ? document.caretRangeFromPoint(at.x, at.y)
      : selection?.rangeCount
        ? selection.getRangeAt(0)
        : null;
    const range =
      currentRange && root.contains(currentRange.commonAncestorContainer)
        ? currentRange.cloneRange()
        : document.createRange();
    if (!currentRange || !root.contains(currentRange.commonAncestorContainer)) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    pendingTransfersRef.current += 1;
    setPendingTransfers(pendingTransfersRef.current);
    setTransferError(undefined);
    addFilesQueueRef.current = addFilesQueueRef.current
      .then(async () => {
        // A closed/replaced input must never receive another chat's files.
        const gone = () =>
          !root.isConnected || owner.current !== initiatingOwner;
        if (gone()) return;
        const current = composer.read().attachments;
        let budget =
          MAX_TOTAL_MEDIA_BYTES -
          current.reduce(
            (total, attachment) =>
              attachment.kind === "text"
                ? total
                : total + Math.round((attachment.dataBase64.length * 3) / 4),
            0,
          );
        const pills: ComposerAttachment[] = [];
        const failures: string[] = [];
        for (const file of files) {
          if (current.length + pills.length >= MAX_ATTACHMENTS) {
            failures.push(
              `${file.name || "File"}: a message can hold ${MAX_ATTACHMENTS} attachments. Send these first, then paste the remaining files.`,
            );
            continue;
          }
          try {
            const kind = mediaKindOf(file);
            if (
              kind &&
              accepts.includes(kind) &&
              file.size > 0 &&
              file.size <= MAX_ATTACHMENT_BYTES &&
              file.size <= budget
            ) {
              pills.push(await encodeFile(file, kind));
              budget -= file.size;
            } else {
              const existing = pathPillFor(file);
              if (existing) pills.push(existing);
              else {
                if (file.size > 128 * 1024 * 1024)
                  throw new Error(
                    "Save this file to disk, then attach it from there (clipboard limit: 128 MB).",
                  );
                const saved = await desktopApi.composerFileSave({
                  projectId,
                  name: file.name || "clipboard-file",
                  bytes: new Uint8Array(await file.arrayBuffer()),
                });
                pills.push({
                  id: crypto.randomUUID(),
                  ...textPill(
                    saved.path,
                    { type: "path", path: saved.path },
                    saved.name,
                  ),
                });
              }
            }
          } catch (error) {
            failures.push(
              `${file.name || "File"}: ${error instanceof Error ? error.message : "Could not attach this file. Paste it again or attach it from disk."}`,
            );
          }
        }
        if (gone()) return;
        // Text pills can arrive while a file is being read; report overflow.
        const room = Math.max(
          0,
          MAX_ATTACHMENTS - composer.read().attachments.length,
        );
        if (pills.length > room)
          failures.push(
            "Some files could not fit. Send these attachments first, then paste the remaining files.",
          );
        composer.insertPills(pills.slice(0, room), { range });
        if (failures.length > 0) setTransferError(failures.join("\n"));
      })
      .catch((error: unknown) => {
        setTransferError(
          error instanceof Error
            ? error.message
            : "Could not attach files. Try pasting again.",
        );
      })
      .finally(() => {
        pendingTransfersRef.current -= 1;
        setPendingTransfers(pendingTransfersRef.current);
      });
  };

  return {
    addFilesTo,
    transferError,
    setTransferError,
    pendingTransfers,
    pendingTransfersRef,
  };
}
