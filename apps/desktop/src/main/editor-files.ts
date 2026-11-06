import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/** Desktop-local files, including artifacts and native-agent worktrees. */
export async function readEditorFile({ filePath }: { filePath: string }) {
  if (!path.isAbsolute(filePath))
    throw new Error("Expected an absolute file path");
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("This path is not a file");
    if (stat.size > MAX_TEXT_BYTES)
      throw new Error("This file is too large for the text editor");
    const bytes = await handle.readFile();
    if (bytes.includes(0))
      throw new Error("This binary file cannot be opened in the text editor");
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } finally {
    await handle.close();
  }
}

export async function writeEditorFile({
  filePath,
  content,
  expectedContent,
}: {
  filePath: string;
  content: string;
  expectedContent: string;
}) {
  const current = await readEditorFile({ filePath });
  if (current.content !== expectedContent)
    throw new Error(
      "This file changed on disk. Reopen it before saving your edits.",
    );
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES)
    throw new Error("This file is too large for the text editor");
  await fs.writeFile(filePath, content, "utf8");
}

/**
 * Renames a file in place, keeping its extension when the new name has
 * none, and never replacing another file. Returns the new absolute path.
 */
export async function renameEditorFile({
  filePath,
  name,
}: {
  filePath: string;
  name: string;
}) {
  if (!path.isAbsolute(filePath))
    throw new Error("Expected an absolute file path");
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    /[/\\\0]/.test(trimmed)
  )
    throw new Error("Choose a name without slashes.");
  const extension = path.extname(filePath);
  const fileName =
    path.extname(trimmed) || !extension ? trimmed : `${trimmed}${extension}`;
  const target = path.join(path.dirname(filePath), fileName);
  if (target === filePath) return filePath;
  const source = await fs.lstat(filePath);
  if (!source.isFile()) throw new Error("This path is not a file");
  const existing = await fs.lstat(target).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  // The same file under another case on a case-insensitive disk is a rename.
  if (existing && existing.ino !== source.ino)
    throw new Error(`A file named ${fileName} is already here.`);
  await fs.rename(filePath, target);
  return target;
}
