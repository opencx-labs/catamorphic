import { desktopApi } from "../lib/desktop-api.js";
import { localEditorPath } from "../lib/local-project-files.js";
import { ipcErrorText } from "../lib/remote-workspace.js";
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

/** The file menu for a link, which may name a folder (`notes/`): a folder has no Copy file. */
export function fileMenuFor(target: FileTarget): readonly ContextMenuEntry[] {
  return target.filePath.endsWith("/")
    ? FILE_MENU.filter((entry) => entry.action !== "copy-file")
    : FILE_MENU;
}

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

/**
 * What a file action picked from a link's or a tab's menu says when it
 * could not be done: the menu has closed, so it says so in a sheet on the
 * window, as Finder does.
 */
export function sayWhyFileActionFailed(
  action: string,
  target: FileTarget,
  cause: unknown,
): Promise<void> {
  const name = `“${target.filePath.replace(/\/+$/, "").split("/").at(-1)}”`;
  const text = ipcErrorText(cause);
  return desktopApi.sayFileActionFailed({
    message:
      action === "reveal"
        ? `${name} could not be shown in Finder`
        : action === "copy-path"
          ? `The path to ${name} could not be copied`
          : `${name} could not be copied`,
    detail: text.includes("ENOENT")
      ? "It is no longer at this location."
      : text,
  });
}
