import fs from "node:fs/promises";
import path from "node:path";
import {
  isProjectPathWithin,
  PROJECT_PERSONAL_DIR,
} from "@catamorphic/workflow/project-layout";

export function isPersonalFile(filePath: string): boolean {
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  return isProjectPathWithin(normalized, PROJECT_PERSONAL_DIR);
}

/** Also protects native git add/checkpoint operations, including linked worktrees. */
export async function ensurePersonalFilesExcluded({
  repoPath,
}: {
  repoPath: string;
}): Promise<void> {
  const dotGit = path.join(repoPath, ".git");
  const entry = await fs.stat(dotGit).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!entry) return;
  const gitDir = entry.isDirectory()
    ? dotGit
    : path.resolve(
        repoPath,
        (await fs.readFile(dotGit, "utf8")).trim().replace(/^gitdir:\s*/, ""),
      );
  const common = await fs
    .readFile(path.join(gitDir, "commondir"), "utf8")
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return "";
      throw error;
    });
  const commonDir = common.trim()
    ? path.resolve(gitDir, common.trim())
    : gitDir;
  const excludePath = path.join(commonDir, "info", "exclude");
  const current = await fs
    .readFile(excludePath, "utf8")
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return "";
      throw error;
    });
  const rule = `/${PROJECT_PERSONAL_DIR}/`;
  if (current.split(/\r?\n/).includes(rule)) return;
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.appendFile(
    excludePath,
    `${current && !current.endsWith("\n") ? "\n" : ""}${rule}\n`,
  );
}
