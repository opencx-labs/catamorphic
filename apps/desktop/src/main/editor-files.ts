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
