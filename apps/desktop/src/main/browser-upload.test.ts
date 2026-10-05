import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ webContents: {} }));
const { uploadable } = await import("./browser-driver.js");

let home: string;
beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "upload-home-")),
  );
  vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});
const file = async (relative: string) => {
  const target = path.join(home, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "x");
  return target;
};

describe("files an agent may upload", () => {
  it("takes what a person sees, and anything in the agent's own folder", async () => {
    const resume = await file("Documents/resume.pdf");
    expect(await uploadable(resume, undefined)).toBe(resume);
    const own = await file("work/.claude/worktrees/app/report.csv");
    expect(
      await uploadable(own, path.join(home, "work/.claude/worktrees/app")),
    ).toBe(own);
  });

  it("refuses hidden files and folders, ~/Library, and relative paths", async () => {
    for (const secret of [
      await file(".ssh/id_ed25519"),
      await file("project/.env"),
      await file("Library/Keychains/login.keychain-db"),
    ])
      await expect(uploadable(secret, path.join(home, "work"))).rejects.toThrow(
        "refused",
      );
    // A link from a visible place to a hidden one is the hidden file.
    const key = await file(".aws/credentials");
    const link = path.join(home, "Desktop", "creds.txt");
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(key, link);
    await expect(uploadable(link, undefined)).rejects.toThrow("refused");
    await expect(uploadable("Documents/resume.pdf", undefined)).rejects.toThrow(
      "absolute",
    );
  });
});
