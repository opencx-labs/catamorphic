import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Clipboard-only files need a durable path even when the model takes no
 * media. They live in host storage (`<attachmentsDir>/<projectId>/`), never
 * in the project folder: a paste is not a project change, so it must not
 * appear in Git status, turn checkpoints, or remote sync. Agents receive the
 * absolute path, as they do for files attached from disk.
 */
export async function saveComposerFile({
  attachmentsDir,
  projectId,
  name,
  bytes,
}: {
  attachmentsDir: string;
  projectId: string;
  name: string;
  bytes: Uint8Array;
}): Promise<{ path: string; name: string }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 128 * 1024 * 1024) {
    throw new Error(
      "Clipboard files must be smaller than 128 MB. Save the file and attach it from disk instead.",
    );
  }
  const directory = projectAttachmentsDirectory({ attachmentsDir, projectId });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeName =
    (typeof name === "string" ? name : "")
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .slice(-160) || "clipboard-file";
  const destination = path.join(directory, `${randomUUID()}-${safeName}`);
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return { path: destination, name: safeName };
}

/** Drops a removed project's pasted files. */
export async function removeComposerFiles({
  attachmentsDir,
  projectId,
}: {
  attachmentsDir: string;
  projectId: string;
}): Promise<void> {
  await rm(projectAttachmentsDirectory({ attachmentsDir, projectId }), {
    recursive: true,
    force: true,
  });
}

/** Where a project's pasted files live. */
export function projectAttachmentsDirectory({
  attachmentsDir,
  projectId,
}: {
  attachmentsDir: string;
  projectId: string;
}): string {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]+$/.test(projectId))
    throw new Error("Invalid project");
  return path.join(attachmentsDir, projectId);
}

/**
 * What the built-in agent may read beside a project's checkout: its pasted
 * files, which agents receive by absolute path. A malformed project id
 * shares nothing.
 */
export function readableAttachments({
  attachmentsDir,
}: {
  attachmentsDir: string;
}): (context: { projectId: string }) => readonly string[] {
  return ({ projectId }) =>
    /^[A-Za-z0-9_-]+$/.test(projectId)
      ? [projectAttachmentsDirectory({ attachmentsDir, projectId })]
      : [];
}
