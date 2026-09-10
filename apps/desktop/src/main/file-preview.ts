import { constants } from "node:fs";
import { stat as fileStat, open } from "node:fs/promises";
import path from "node:path";
import type { ResourcePreview } from "@catamorphic/react";

const TEXT_LIMIT = 16 * 1024;
const MEDIA_LIMIT = 16 * 1024 * 1024;
const MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const DOCUMENTS = new Set([
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "odt",
  "ods",
  "odp",
  "pages",
  "numbers",
  "key",
  "heic",
  "heif",
  "tif",
  "tiff",
]);

/** Reads only a bounded prefix/media payload, never executes or renders documents. */
export async function readFilePreview({
  filePath,
  thumbnail,
}: {
  filePath: string;
  thumbnail?: (filePath: string) => Promise<string | undefined>;
}): Promise<ResourcePreview> {
  if (!path.isAbsolute(filePath))
    throw new Error("Expected an absolute file path");
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const base = {
    name: path.basename(filePath),
    location: filePath,
    typeLabel: extension.toUpperCase() || "File",
  };
  const initialStat = await fileStat(filePath);
  if (!initialStat.isFile())
    return {
      ...base,
      content: {
        kind: "unavailable",
        message: initialStat.isDirectory()
          ? "Folder"
          : "This path is not a regular file.",
      },
    };
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      return {
        ...base,
        content: {
          kind: "unavailable",
          message: stat.isDirectory()
            ? "Folder"
            : "This path is not a regular file.",
        },
      };
    const details = { ...base, sizeBytes: stat.size };
    const mediaType = MEDIA[extension];
    if (
      DOCUMENTS.has(extension) &&
      thumbnail &&
      stat.size <= 128 * 1024 * 1024
    ) {
      const src = await thumbnail(filePath).catch(() => undefined);
      if (src) return { ...details, content: { kind: "image", src } };
    }
    if (mediaType) {
      if (stat.size > MEDIA_LIMIT)
        return {
          ...details,
          content: {
            kind: "unavailable",
            message:
              "This file is too large for an inline preview. Open it to view its contents.",
          },
        };
      const buffer = Buffer.alloc(Math.min(stat.size, MEDIA_LIMIT) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MEDIA_LIMIT)
        return {
          ...details,
          content: {
            kind: "unavailable",
            message: "This file grew beyond the inline preview limit.",
          },
        };
      const src = `data:${mediaType};base64,${buffer.subarray(0, bytesRead).toString("base64")}`;
      const kind = mediaType.startsWith("image/")
        ? "image"
        : mediaType.startsWith("audio/")
          ? "audio"
          : "video";
      return {
        ...details,
        content: kind === "image" ? { kind, src } : { kind, src, mediaType },
      };
    }
    const buffer = Buffer.alloc(TEXT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, TEXT_LIMIT));
    if (!DOCUMENTS.has(extension) && !bytes.includes(0)) {
      try {
        const truncated = stat.size > TEXT_LIMIT;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
          stream: truncated,
        });
        return {
          ...details,
          typeLabel: extension.toUpperCase() || "Text",
          content: { kind: "text", text, truncated },
        };
      } catch {
        /* Binary or non-UTF-8 data gets the explicit fallback below. */
      }
    }
    return {
      ...details,
      content: {
        kind: "unavailable",
        message:
          "No inline preview is available for this file. Open it in its app to view it.",
      },
    };
  } finally {
    await handle.close();
  }
}
