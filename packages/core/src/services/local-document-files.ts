import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureProjectWorkspace,
  localDocumentRelativePath,
} from "./project-workspace.js";

/** Local working documents. Symlinks cannot redirect document tools outside the selected folder. */
export async function localDocumentPath(
  root: string,
  relative: string,
): Promise<string> {
  if (
    !relative.startsWith("store/") ||
    relative
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.includes("\\"),
      )
  )
    throw new Error("Choose a file under store/");
  const canonical = await fs.realpath(root);
  const target = path.resolve(canonical, localDocumentRelativePath(relative));
  for (
    let current = target;
    current !== canonical;
    current = path.dirname(current)
  ) {
    const stat = await fs.lstat(current).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error("Document paths cannot follow symbolic links");
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
