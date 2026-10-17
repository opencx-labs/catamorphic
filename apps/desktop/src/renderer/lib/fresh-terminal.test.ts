import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Ghostty, type GhosttyTerminal } from "ghostty-web";
import { beforeAll, describe, expect, it } from "vitest";
import { FRESH_SCREEN } from "./fresh-terminal.js";

let ghostty: Ghostty;
beforeAll(async () => {
  // The library's own loader looks for a browser; its WASM as a data URL
  // loads anywhere.
  const dist = path.dirname(
    createRequire(import.meta.url).resolve("ghostty-web"),
  );
  const wasm = readFileSync(path.join(dist, "ghostty-vt.wasm")).toString(
    "base64",
  );
  ghostty = await Ghostty.load(`data:application/wasm;base64,${wasm}`);
});

/** Rows of the terminal's screen as text, blank cells as spaces. */
const screen = (term: GhosttyTerminal): string[] => {
  term.update();
  const cells = term.getViewport();
  return Array.from({ length: term.rows }, (_, row) =>
    cells
      .slice(row * term.cols, (row + 1) * term.cols)
      .map((cell) =>
        cell.codepoint ? String.fromCodePoint(cell.codepoint) : " ",
      )
      .join("")
      .trimEnd(),
  );
};

/** A wide terminal full of output, then closed: its memory goes back. */
const closeBusyTerminal = () => {
  const old = ghostty.createTerminal(160, 60);
  for (let line = 0; line < 400; line++) {
    old.write(`[desktop] Closing a service that wrote a long line ${line}\r\n`);
  }
  screen(old);
  old.free();
};

describe("a new terminal view", () => {
  it("shows a closed terminal's text until it erases its screen", () => {
    closeBusyTerminal();
    // As the terminal tab does: created at the default size, then fitted.
    const term = ghostty.createTerminal(80, 24);
    term.resize(190, 66);
    term.write("% echo hello\r\n");
    // The library's own behaviour, which FRESH_SCREEN is there for: if
    // this stops holding, ghostty-web zeroes new terminals itself.
    expect(screen(term).slice(1).join("")).toContain("Closing");
    term.free();
  });

  it("is blank where it has not written once FRESH_SCREEN erases it, through resizes", () => {
    closeBusyTerminal();
    const term = ghostty.createTerminal(80, 24);
    term.resize(190, 66);
    term.write(FRESH_SCREEN);
    term.write("% echo hello\r\n");
    expect(screen(term)).toEqual(["% echo hello", ...Array(65).fill("")]);
    term.resize(120, 50);
    expect(screen(term).slice(1).join("")).toBe("");
    term.resize(230, 70);
    expect(screen(term).slice(1).join("")).toBe("");
    term.free();
  });
});
