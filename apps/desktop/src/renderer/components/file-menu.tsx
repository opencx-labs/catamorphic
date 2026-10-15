import { desktopApi } from "../lib/desktop-api.js";
import { localEditorPath } from "../lib/local-project-files.js";
import type { ContextMenuEntry } from "./menu.js";

/** A file a menu acts on: a project-relative path, or an absolute one. */
export interface FileTarget {
  projectId: string;
  filePath: string;
}

/**
 * What a file adds to its right-click menu, after the ways to open it: the
 * same on its tab, its sidebar row and its links in chat.
 */
export const FILE_MENU: readonly ContextMenuEntry[] = [
  { label: "Copy path", action: "copy-path" },
  { label: "Show in Finder", action: "reveal" },
  { label: "Copy file", action: "copy-file" },
];

/**
 * What a row of the file menu does, on the file's path on this machine:
 * copy that path, show the file in Finder, or put the file itself on the
 * clipboard for Finder, Mail or Slack to paste.
 */
export async function actOnFile(
  action: string,
  target: FileTarget,
): Promise<void> {
  const absolute = await localEditorPath(target.projectId, target.filePath);
  if (action === "copy-path") await navigator.clipboard.writeText(absolute);
  else if (action === "reveal") await desktopApi.revealFolder(absolute);
  else if (action === "copy-file")
    await desktopApi.copyFileToClipboard(absolute);
}
