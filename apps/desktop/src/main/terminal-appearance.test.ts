import { describe, expect, it } from "vitest";
import { parseGhosttyAppearance } from "./terminal-appearance.js";

describe("resolved Ghostty appearance", () => {
  it("reads fonts, local color overrides, and the ANSI palette from resolved config", () => {
    const appearance = parseGhosttyAppearance(`
theme = Catppuccin Mocha
font-family = JetBrains Mono
font-family = Symbols Nerd Font
font-size = 18
background = #1e1e2e
foreground = #cdd6f4
cursor-color = #f5e0dc
cursor-text = #1e1e2e
selection-background = #585b70
selection-foreground = #cdd6f4
palette = 0=#45475a
palette = 1=#f38ba8
palette = 15=#bac2de
palette = 255=#ffffff
background = #112233
command = ignored
keybind = ignored
background-opacity = 0.9
`);
    expect(appearance).toEqual({
      name: "Catppuccin Mocha",
      fontFamily: '"JetBrains Mono", "Symbols Nerd Font", monospace',
      fontSize: 18,
      theme: {
        background: "#112233",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        cursorAccent: "#1e1e2e",
        selectionBackground: "#585b70",
        selectionForeground: "#cdd6f4",
        black: "#45475a",
        red: "#f38ba8",
        brightWhite: "#bac2de",
      },
    });
  });

  it("rejects unresolved themes and ignores invalid optional values", () => {
    expect(() => parseGhosttyAppearance("theme = Missing")).toThrow(
      "resolved color theme",
    );
    expect(
      parseGhosttyAppearance(
        `background = #000000\nforeground = #ffffff\nfont-size = NaN\ncursor-color = invalid\npalette = -1=#123456`,
      ),
    ).toEqual({
      name: "Ghostty",
      fontFamily: "monospace",
      fontSize: 13,
      theme: { background: "#000000", foreground: "#ffffff" },
    });
  });
});
