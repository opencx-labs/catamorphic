import fs from "node:fs/promises";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";

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
  const target = path.resolve(canonical, relative);
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
        files.push(path.relative(root, target).split(path.sep).join("/"));
    }
  };
  await localDocumentPath(root, "store/.probe");
  await walk(path.join(root, "store"));
  return files.sort();
}

/** First document creation opts into private store files without modifying tracked ignore rules. */
export async function protectLocalDocuments(root: string): Promise<void> {
  const gitPath = (
    await nativeGit(root, ["rev-parse", "--git-path", "info/exclude"])
  ).trim();
  const target = path.resolve(root, gitPath);
  const current = await fs.readFile(target, "utf8").catch(() => "");
  const rules = ["/store/", "/.catamorphic/remote-sync.json"];
  const missing = rules.filter(
    (rule) => !current.split(/\r?\n/).includes(rule),
  );
  if (missing.length === 0) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(
    target,
    `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
}
