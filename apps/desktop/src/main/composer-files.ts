import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Clipboard-only files need a durable path even when the model takes no media. */
export async function saveComposerFile({
  rootPath,
  name,
  bytes,
}: {
  rootPath: string;
  name: string;
  bytes: Uint8Array;
}): Promise<{ path: string; name: string }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 128 * 1024 * 1024) {
    throw new Error(
      "Clipboard files must be smaller than 128 MB. Save the file and attach it from disk instead.",
    );
  }
  const root = await realpath(rootPath);
  const directory = path.join(root, ".catamorphic", "attachments");
  await mkdir(directory, { recursive: true });
  const relative = path.relative(root, await realpath(directory));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The attachment directory must be inside the project.");
  }
  const safeName =
    (typeof name === "string" ? name : "")
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .slice(-160) || "clipboard-file";
  const destination = path.join(directory, `${randomUUID()}-${safeName}`);
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return { path: destination, name: safeName };
}
