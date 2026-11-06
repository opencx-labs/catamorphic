import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  InstalledClaudeCodeFinder,
  isNativeExecutable,
  parseClaudeVersion,
} from "./installed-claude-code.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tree() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "installed-claude-")),
  );
  roots.push(root);
  const home = path.join(root, "home");
  const versions = path.join(home, ".local", "share", "claude", "versions");
  await fs.mkdir(versions, { recursive: true });
  await fs.mkdir(path.join(home, ".local", "bin"), { recursive: true });
  const brew = path.join(root, "brew", "bin");
  await fs.mkdir(brew, { recursive: true });
  return { root, home, versions, brew };
}

describe("installed Claude Code", () => {
  it("compares and parses versions", () => {
    expect(compareVersions("2.1.287", "2.1.263")).toBeGreaterThan(0);
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0);
    expect(compareVersions("2.1.0", "2.1")).toBe(0);
    expect(parseClaudeVersion("2.1.220 (Claude Code)\n")).toBe("2.1.220");
    expect(parseClaudeVersion("command not found")).toBeUndefined();
  });

  it("recognises native executables and refuses scripts", async () => {
    const { root } = await tree();
    const elf = path.join(root, "elf");
    const script = path.join(root, "script");
    await fs.writeFile(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
    await fs.writeFile(script, "#!/usr/bin/env node\nconsole.log(1)\n");
    expect(await isNativeExecutable(elf)).toBe(true);
    expect(await isNativeExecutable(script)).toBe(false);
    expect(await isNativeExecutable(path.join(root, "missing"))).toBe(false);
  });

  it("finds the newest install, follows symlinks once, and asks each file its version once", async () => {
    const { home, versions, brew } = await tree();
    const native = path.join(versions, "2.1.220");
    await fs.writeFile(native, "native");
    await fs.symlink(native, path.join(home, ".local", "bin", "claude"));
    await fs.writeFile(path.join(brew, "claude"), "native");
    const reported: Record<string, string> = {
      [native]: "2.1.220 (Claude Code)",
      [path.join(brew, "claude")]: "2.1.290 (Claude Code)",
    };
    const asked: string[] = [];
    const finder = new InstalledClaudeCodeFinder({
      home,
      platform: "darwin",
      // The symlinked install is on PATH twice; Homebrew's is not on PATH.
      searchPath: async () => [
        path.join(home, ".local", "bin"),
        path.join(home, ".local", "bin"),
        "relative/ignored",
        brew,
      ],
      isNative: async () => true,
      versionOf: async (file) => {
        asked.push(file);
        return reported[file] ?? "";
      },
    });
    expect(await finder.find()).toEqual({
      executablePath: path.join(brew, "claude"),
      commandPath: path.join(brew, "claude"),
      version: "2.1.290",
    });
    await finder.find();
    expect(asked.sort()).toEqual([native, path.join(brew, "claude")].sort());
  });

  it("asks again after the file changes, and skips what is not native", async () => {
    const { home, versions } = await tree();
    const binary = path.join(versions, "current");
    await fs.writeFile(binary, "v1");
    await fs.symlink(binary, path.join(home, ".local", "bin", "claude"));
    let version = "2.1.220";
    let native = true;
    const finder = new InstalledClaudeCodeFinder({
      home,
      platform: "linux",
      searchPath: async () => [],
      isNative: async () => native,
      versionOf: async () => `${version} (Claude Code)`,
    });
    expect((await finder.find())?.version).toBe("2.1.220");
    version = "2.1.300";
    await fs.writeFile(binary, "v2 is longer");
    expect((await finder.find())?.version).toBe("2.1.300");
    native = false;
    await fs.writeFile(binary, "#!/usr/bin/env node");
    expect(await finder.find()).toBeNull();
  });
});
