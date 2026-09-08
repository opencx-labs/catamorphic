import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ITheme } from "ghostty-web";
import type {
  TerminalAppearance,
  TerminalAppearanceResult,
} from "../shared/terminal-appearance.js";

const execFileAsync = promisify(execFile);
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
const COLOR_KEYS: Record<string, keyof ITheme> = {
  background: "background",
  foreground: "foreground",
  "cursor-color": "cursor",
  "cursor-text": "cursorAccent",
  "selection-background": "selectionBackground",
  "selection-foreground": "selectionForeground",
};

/** Parse resolved output, never interpret config includes or execute its commands. */
export function parseGhosttyAppearance(output: string): TerminalAppearance {
  const theme: ITheme = {};
  const fonts: string[] = [];
  let name = "Ghostty";
  let fontSize = 13;
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (key === "theme" && value) name = value;
    if (key === "font-family" && value) fonts.push(JSON.stringify(value));
    if (
      key === "font-size" &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 6 &&
      Number(value) <= 96
    )
      fontSize = Number(value);
    const colorKey = COLOR_KEYS[key];
    if (colorKey && /^#[0-9a-f]{6}$/i.test(value)) theme[colorKey] = value;
    if (key === "palette") {
      const match = /^(\d+)=(#[0-9a-f]{6})$/i.exec(value);
      const ansiKey = match ? ANSI_KEYS[Number(match[1])] : undefined;
      if (ansiKey && match?.[2]) theme[ansiKey] = match[2];
    }
  }
  if (!theme.background || !theme.foreground)
    throw new Error("Ghostty did not return a resolved color theme.");
  return {
    name,
    fontFamily: [...fonts, "monospace"].join(", "),
    fontSize,
    theme,
  };
}

/** Ghostty resolves its own config, includes, theme files, and local overrides. */
export async function readGhosttyAppearance(): Promise<TerminalAppearanceResult> {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Ghostty.app/Contents/MacOS/ghostty",
          path.join(
            os.homedir(),
            "Applications/Ghostty.app/Contents/MacOS/ghostty",
          ),
        ]
      : [];
  const binary =
    candidates.find((candidate) => fs.existsSync(candidate)) ?? "ghostty";
  try {
    const { stdout } = await execFileAsync(
      binary,
      ["+show-config", "--changes-only=false"],
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    return { ok: true, appearance: parseGhosttyAppearance(stdout) };
  } catch {
    return {
      ok: false,
      error:
        "Could not read Ghostty's appearance. Check that Ghostty is installed and its configuration is valid.",
    };
  }
}
