import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

/**
 * How a file reaches the clipboard as itself, so Finder, Mail or Slack
 * paste the file rather than its name. On macOS, AppleScript's file
 * reference is what Finder's own Copy puts there; the path goes in as an
 * argument, never into the script's text. Elsewhere, its file URL.
 */
export interface FileClipboardDeps {
  platform: NodeJS.Platform;
  runAppleScript: (
    lines: readonly string[],
    args: readonly string[],
  ) => Promise<void>;
  writeUriList: (input: { uriList: string; text: string }) => Promise<void>;
}

const run = promisify(execFile);

export function runAppleScript(
  lines: readonly string[],
  args: readonly string[],
): Promise<void> {
  return run("osascript", [...lines.flatMap((line) => ["-e", line]), ...args], {
    timeout: 10_000,
  }).then(() => undefined);
}

/** Puts the file at `filePath` on the clipboard as a file. */
export async function copyFileToClipboard(
  filePath: string,
  deps: FileClipboardDeps,
): Promise<void> {
  if (!path.isAbsolute(filePath))
    throw new Error("Choose an absolute file path");
  if (!fs.statSync(filePath).isFile())
    throw new Error("Only a file can be copied this way");
  if (deps.platform === "darwin") {
    await deps.runAppleScript(
      [
        "on run argv",
        "set the clipboard to (POSIX file (item 1 of argv))",
        "end run",
      ],
      [filePath],
    );
    return;
  }
  await deps.writeUriList({
    uriList: pathToFileURL(filePath).href,
    text: filePath,
  });
}
