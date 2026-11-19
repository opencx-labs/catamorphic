import { realpath } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DocumentNotFoundError,
  LocalDocumentSpellingError,
} from "./document-errors.js";
import {
  ensureProjectWorkspace,
  localDocumentRelativePath,
} from "./project-workspace.js";

/** The OS's own realpath: on macOS and Windows, the spelling on disk. */
const nativeRealpath = promisify(realpath.native);

const isNotFound = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * Local working documents. Symlinks cannot redirect document tools outside
 * the selected folder, and a path reaches a file only as it is spelled on
 * disk (ADR 0335): one native realpath of the deepest existing entry, so
 * the check costs the same in a folder of thousands.
 */
export async function localDocumentPath(
  root: string,
  relative: string,
): Promise<string> {
  if (
    !relative.startsWith("store/") ||
    relative.split("/").some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        // Windows drops a trailing dot or space: "notes." is "notes".
        (process.platform === "win32" && /[. ]$/.test(part)),
    )
  )
    throw new Error("Choose a file under store/");
  const canonical = await nativeRealpath(root);
  const target = path.resolve(canonical, localDocumentRelativePath(relative));
  let deepest: string | undefined;
  for (
    let current = target;
    current !== canonical;
    current = path.dirname(current)
  ) {
    const stat = await fs.lstat(current).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error("Document paths cannot follow symbolic links");
    deepest ??= stat ? current : undefined;
  }
  // A filesystem that ignores case or Unicode form (APFS) finds an entry by
  // another spelling, so two paths, each checked against its own grant,
  // would name one file. Its realpath is the spelling on disk.
  if (deepest) {
    const actual = await nativeRealpath(deepest).catch((error: unknown) => {
      // Removed while we looked: there is nothing there now.
      if (isNotFound(error)) throw new DocumentNotFoundError(relative);
      throw error;
    });
    if (actual !== deepest) throw new LocalDocumentSpellingError(relative);
  }
  return target;
}

export async function listLocalDocuments(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs
      .readdir(directory, { withFileTypes: true })
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile())
        files.push(
          "store/" +
            path
              .relative(
                path.join(root, localDocumentRelativePath("store/")),
                target,
              )
              .split(path.sep)
              .join("/"),
        );
    }
  };
  await localDocumentPath(root, "store/.probe");
  await walk(path.join(root, localDocumentRelativePath("store/")));
  return files.sort();
}

/** First document creation opts into ignored project-local data, including plain folders. */
export async function protectLocalDocuments(root: string): Promise<void> {
  ensureProjectWorkspace({ root });
}
