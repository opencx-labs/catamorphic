import { describe, expect, it } from "vitest";
import { sanitizeScrollback } from "./scrollback.js";

const ESC = "\x1b";

describe("sanitizeScrollback", () => {
  it("renders a real zsh session (prompt marker dance) as clean lines", () => {
    // Captured from a live session: zsh's partial-line marker writes an
    // inverse %, a screen-width of spaces, CR tricks, and erase-below
    // before every prompt.
    const dance =
      `${ESC}[1m${ESC}[7m%${ESC}[27m${ESC}[1m${ESC}[0m` +
      " ".repeat(112) +
      `\r \r\r${ESC}[0m${ESC}[27m${ESC}[24m${ESC}[J`;
    const buffer =
      `${dance}tabaza@mac scratch-demo % ${ESC}[K${ESC}[?2004h` +
      `e\becho DEBUG-1${ESC}[?2004l\r\r\nDEBUG-1\r\n` +
      `${dance}tabaza@mac scratch-demo % ${ESC}[K${ESC}[?2004h`;
    expect(sanitizeScrollback(buffer)).toEqual([
      "tabaza@mac scratch-demo % echo DEBUG-1",
      "DEBUG-1",
      "tabaza@mac scratch-demo %",
    ]);
  });

  it("resolves CR-overwrites to the final text (progress bars)", () => {
    expect(sanitizeScrollback("10%\r 20%\r100%\r\ndone\r\n")).toEqual([
      "100%",
      "done",
    ]);
  });

  it("applies backspace overwrites", () => {
    expect(sanitizeScrollback("ex\bcho hi\r\n")).toEqual(["echo hi"]);
  });

  it("drops OSC titles and trims trailing blank lines", () => {
    expect(
      sanitizeScrollback(`${ESC}]0;my title\x07hello\r\n\r\n\r\n`),
    ).toEqual(["hello"]);
  });
});
