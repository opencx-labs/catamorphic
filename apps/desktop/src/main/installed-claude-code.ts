import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { InstalledClaudeCode } from "../shared/claude-code-install.js";
import { loginShellPath } from "./login-shell-path.js";

export type { InstalledClaudeCode };

/** Numeric comparison of dotted versions: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** "2.1.287 (Claude Code)" → "2.1.287". */
export function parseClaudeVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1];
}

/**
 * Only a native executable runs without a Node on PATH: an app started
 * from the Dock does not inherit the shell's PATH, so a JavaScript `claude`
 * from a global npm install would fail to start under the SDK.
 */
export async function isNativeExecutable(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    if (bytesRead < 2) return false;
    const magic = bytes.readUInt32BE(0);
    return (
      // ELF
      magic === 0x7f454c46 ||
      // Mach-O 32/64 in either byte order, and universal binaries
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xbebafeca ||
      // PE ("MZ")
      bytes.readUInt16BE(0) === 0x4d5a
    );
  } finally {
    await handle.close();
  }
}

function run(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve(`${stdout}${stderr}`);
      },
    );
  });
}

export interface InstalledClaudeCodeFinderOptions {
  home?: string;
  platform?: NodeJS.Platform;
  /** PATH entries to search, in order; defaults to this process's PATH and the login shell's. */
  searchPath?: () => Promise<string[]>;
  /** `claude --version` output for one executable. */
  versionOf?: (file: string) => Promise<string>;
  isNative?: (file: string) => Promise<boolean>;
}

/**
 * Finds the person's own Claude Code, newest first. The search runs on
 * demand and is cheap after the first time: the login shell's PATH is read
 * once, and each executable's version is asked again only when the file
 * changes (an update replaces it, or moves the symlink to a new version).
 */
export class InstalledClaudeCodeFinder {
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly searchPath: () => Promise<string[]>;
  private readonly versionOf: (file: string) => Promise<string>;
  private readonly isNative: (file: string) => Promise<boolean>;
  private shellPath?: Promise<string[]>;
  private readonly versions = new Map<
    string,
    { stamp: string; version: string | undefined }
  >();

  constructor(options: InstalledClaudeCodeFinderOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.searchPath =
      options.searchPath ??
      (async () => {
        this.shellPath ??= loginShellPath().then(
          (value) => value?.split(path.delimiter) ?? [],
        );
        return [
          ...(process.env.PATH ?? "").split(path.delimiter),
          ...(await this.shellPath),
        ];
      });
    this.versionOf =
      options.versionOf ?? ((file) => run(file, ["--version"], 10_000));
    this.isNative = options.isNative ?? isNativeExecutable;
  }

  /** Where installers put `claude`, beyond whatever PATH says. */
  private knownDirectories(): string[] {
    if (this.platform === "win32")
      return [path.join(this.home, ".local", "bin")];
    return [
      path.join(this.home, ".local", "bin"),
      path.join(this.home, ".claude", "local"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
  }

  /** The newest native Claude Code installed, whatever its version. */
  async find(): Promise<InstalledClaudeCode | null> {
    const name = this.platform === "win32" ? "claude.exe" : "claude";
    const directories = [
      ...(await this.searchPath()),
      ...this.knownDirectories(),
    ].filter((entry) => path.isAbsolute(entry));
    const seen = new Set<string>();
    let best: InstalledClaudeCode | null = null;
    for (const directory of directories) {
      const commandPath = path.join(directory, name);
      const resolved = await fs.realpath(commandPath).catch(() => undefined);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      const version = await this.versionAt(resolved);
      if (version && (!best || compareVersions(version, best.version) > 0))
        best = { executablePath: resolved, commandPath, version };
    }
    return best;
  }

  private async versionAt(file: string): Promise<string | undefined> {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) return undefined;
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    const cached = this.versions.get(file);
    if (cached?.stamp === stamp) return cached.version;
    const version = (await this.isNative(file))
      ? await this.versionOf(file)
          .then(parseClaudeVersion)
          .catch(() => undefined)
      : undefined;
    this.versions.set(file, { stamp, version });
    return version;
  }

  /**
   * Run the install's own updater (`claude update`) at the person's
   * request. Returns its output; the next find() sees the new version.
   */
  async update(installed: InstalledClaudeCode): Promise<string> {
    try {
      return await run(installed.commandPath, ["update"], 5 * 60_000);
    } finally {
      this.versions.delete(installed.executablePath);
    }
  }
}
