import fs from "node:fs";
import path from "node:path";
import { type UnzipFileInfo, unzipSync } from "fflate";

/**
 * Unpacking an extension archive (ADR 0203). The archive comes from a
 * signed package, but its paths are still checked the way an untrusted zip
 * is: nothing may land outside the extension's folder, and the declared
 * sizes bound the memory and disk an archive can claim.
 */

export class ArchiveError extends Error {
  override name = "ArchiveError";
}

export const ARCHIVE_LIMITS = {
  entries: 20_000,
  /** Largest uncompressed archive; the biggest popular extensions are ~60 MB. */
  totalBytes: 1024 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
};

/** A relative archive path that stays inside the folder, or null. */
export function safeEntryPath(name: string): string | null {
  if (!name || name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split("/");
  // A trailing slash names a directory entry.
  if (parts.at(-1) === "") parts.pop();
  if (parts.length === 0) return null;
  for (const part of parts)
    if (part === "" || part === "." || part === "..") return null;
  return parts.join("/");
}

/**
 * Extract `archive` into `destination`, which must not exist yet. On any
 * failure the partial folder is removed.
 */
export function extractArchive(
  archive: Uint8Array,
  destination: string,
  limits = ARCHIVE_LIMITS,
): void {
  if (fs.existsSync(destination))
    throw new ArchiveError("Destination already exists");
  let entries = 0;
  let total = 0;
  const declared = new Map<string, number>();
  const filter = (file: UnzipFileInfo) => {
    entries += 1;
    if (entries > limits.entries)
      throw new ArchiveError("Archive has too many files");
    const relative = safeEntryPath(file.name);
    if (!relative) throw new ArchiveError(`Unsafe archive path: ${file.name}`);
    if (file.name.endsWith("/")) return false;
    if (file.originalSize > limits.fileBytes)
      throw new ArchiveError(`Archive file too large: ${file.name}`);
    total += file.originalSize;
    if (total > limits.totalBytes)
      throw new ArchiveError("Archive is too large");
    declared.set(file.name, file.originalSize);
    return true;
  };
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archive, { filter });
  } catch (cause) {
    if (cause instanceof ArchiveError) throw cause;
    throw new ArchiveError(
      `Archive is damaged: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  try {
    for (const [name, bytes] of Object.entries(files)) {
      // The deflate stream must agree with the size the directory declared.
      if (bytes.length !== declared.get(name))
        throw new ArchiveError(`Archive file size mismatch: ${name}`);
      const relative = safeEntryPath(name);
      if (!relative) throw new ArchiveError(`Unsafe archive path: ${name}`);
      const target = path.resolve(root, relative);
      if (!target.startsWith(`${root}${path.sep}`))
        throw new ArchiveError(`Unsafe archive path: ${name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx" });
    }
  } catch (cause) {
    fs.rmSync(root, { recursive: true, force: true });
    throw cause;
  }
}
