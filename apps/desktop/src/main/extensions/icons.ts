import fs from "node:fs";
import path from "node:path";
import { nativeImage } from "electron";
import { safeEntryPath } from "./archive.js";

/**
 * Extension images for the app's own windows (ADR 0203). Those windows are
 * outside the profile session, so they cannot load `chrome-extension://`
 * URLs: main reads the file, or the pixels an extension drew, into a data
 * URL.
 */

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};
const MAX_ICON_BYTES = 2 * 1024 * 1024;

/**
 * A file inside the extension, from a path relative to its root or a URL
 * of its own origin. Null when the path leaves the folder.
 */
export function extensionFile(
  root: string,
  extensionId: string,
  raw: string,
): string | null {
  let relative = raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "chrome-extension:" || url.host !== extensionId)
      return null;
    relative = decodeURIComponent(url.pathname);
  }
  const safe = safeEntryPath(relative.replace(/^\/+/, ""));
  if (!safe) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, safe);
  if (!file.startsWith(`${base}${path.sep}`)) return null;
  try {
    // A symlink inside an unpacked folder still may not leave it.
    const real = fs.realpathSync(file);
    const realBase = fs.realpathSync(base);
    if (!real.startsWith(`${realBase}${path.sep}`)) return null;
    return real;
  } catch {
    return null;
  }
}

export function fileDataUrl(file: string | null): string | null {
  if (!file) return null;
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return null;
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

/** RGBA pixels (ImageData) as a PNG data URL. */
export function pixelsDataUrl(image: {
  width: number;
  height: number;
  data: Uint8Array;
}): string | null {
  const { width, height, data } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 512 ||
    height > 512 ||
    data.length !== width * height * 4
  )
    return null;
  // nativeImage takes premultiplied BGRA; ImageData is straight RGBA.
  const bgra = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    const scale = (value: number | undefined) =>
      Math.round(((value ?? 0) * alpha) / 255);
    bgra[index] = scale(data[index + 2]);
    bgra[index + 1] = scale(data[index + 1]);
    bgra[index + 2] = scale(data[index]);
    bgra[index + 3] = alpha;
  }
  const bitmap = nativeImage.createFromBitmap(bgra, { width, height });
  return bitmap.isEmpty() ? null : bitmap.toDataURL();
}
