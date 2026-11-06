import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileToClipboard } from "./file-clipboard.js";

describe("copyFileToClipboard", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-clipboard-"));
    // A name AppleScript would choke on if it were spliced into the script.
    file = path.join(dir, `plan "v2" & it's.md`);
    fs.writeFileSync(file, "# Plan\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const deps = (platform: NodeJS.Platform) => ({
    platform,
    runAppleScript: vi.fn(async () => {}),
    writeUriList: vi.fn(async () => {}),
  });

  it("puts a file on the macOS clipboard as itself, its path an argument", async () => {
    const mac = deps("darwin");
    await copyFileToClipboard(file, mac);
    expect(mac.runAppleScript).toHaveBeenCalledWith(
      [
        "on run argv",
        "set the clipboard to (POSIX file (item 1 of argv))",
        "end run",
      ],
      [file],
    );
    expect(mac.writeUriList).not.toHaveBeenCalled();
  });

  it("writes the file's URL elsewhere", async () => {
    const linux = deps("linux");
    await copyFileToClipboard(file, linux);
    expect(linux.writeUriList).toHaveBeenCalledWith({
      uriList: pathToFileURL(file).href,
      text: file,
    });
    expect(linux.runAppleScript).not.toHaveBeenCalled();
  });

  it("copies only a file, by its absolute path", async () => {
    const mac = deps("darwin");
    await expect(copyFileToClipboard("notes/plan.md", mac)).rejects.toThrow(
      "absolute",
    );
    await expect(copyFileToClipboard(dir, mac)).rejects.toThrow("Only a file");
    await expect(
      copyFileToClipboard(path.join(dir, "gone.md"), mac),
    ).rejects.toThrow();
    expect(mac.runAppleScript).not.toHaveBeenCalled();
  });
});
