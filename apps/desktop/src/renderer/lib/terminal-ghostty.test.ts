import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Ghostty, GhosttyTerminal } from "ghostty-web";
import { beforeAll, describe, expect, it } from "vitest";
import { terminalGhostty } from "./terminal-ghostty.js";

// The library's own loader looks for a browser; its WASM as a data URL
// loads anywhere.
let wasm = "";
beforeAll(() => {
  const dist = path.dirname(
    createRequire(import.meta.url).resolve("ghostty-web"),
  );
  wasm = `data:application/wasm;base64,${readFileSync(path.join(dist, "ghostty-vt.wasm")).toString("base64")}`;
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
const closeBusyTerminal = (ghostty: Ghostty) => {
  const old = ghostty.createTerminal(160, 60);
  for (let line = 0; line < 400; line++) {
    old.write(`[desktop] Closing a service that wrote a long line ${line}\r\n`);
  }
  screen(old);
  old.free();
};

/** What a terminal shows beyond its prompt line, through the tab's resizes. */
const leftovers = (term: GhosttyTerminal): string[] => {
  // As the terminal tab does: created at the default size, then fitted.
  term.resize(190, 66);
  term.write("% echo hello\r\n");
  const seen = [screen(term).slice(1).join("")];
  // Taller only, then wider, then narrower: each brings rows or cells of
  // its own.
  for (const [cols, rows] of [
    [190, 80],
    [230, 80],
    [120, 50],
  ] as const) {
    term.resize(cols, rows);
    seen.push(screen(term).slice(1).join(""));
  }
  return seen;
};

describe("a terminal's WASM instance", () => {
  it("shows a closed terminal's text when the two share one", async () => {
    const shared = await terminalGhostty(wasm);
    closeBusyTerminal(shared);
    // The library's own behaviour, which an instance per terminal avoids:
    // if this stops holding, the library zeroes new terminals itself.
    expect(leftovers(shared.createTerminal(80, 24)).join("")).toContain(
      "Closing",
    );
  });

  it("is blank where its terminal has not written, through every resize, when the terminal has its own", async () => {
    closeBusyTerminal(await terminalGhostty(wasm));
    const own = (await terminalGhostty(wasm)).createTerminal(80, 24);
    expect(leftovers(own)).toEqual(["", "", "", ""]);
    expect(screen(own)[0]).toBe("% echo hello");
  });
});
