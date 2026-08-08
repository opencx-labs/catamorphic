/**
 * Turn a dead terminal's raw output buffer into plain, readable lines.
 *
 * A reopened terminal tab (Cmd+Shift+T) replays the closed session's
 * scrollback above its fresh shell. Replaying the RAW bytes is fragile:
 * shell prompts are full of cursor tricks (zsh's partial-line marker
 * writes an inverse "%", a screen-width of spaces, several CRs and an
 * erase-below before every prompt) whose effect depends on live grid
 * state — replayed into a fresh grid they eat neighboring lines. Dead
 * scrollback is history, not a live screen, so we render it as text:
 *
 * - OSC/CSI/charset escape sequences are dropped (styling included —
 *   the replay is printed dim as a whole, marking it as the past).
 * - `\r` returns the in-line cursor to column 0 and `\b` steps it back;
 *   later characters overwrite — progress bars and prompt redraws
 *   resolve to their final visible text.
 * - Trailing blank lines are trimmed.
 */
export function sanitizeScrollback(buffer: string): string[] {
  const withoutEscapes = buffer
    // OSC: ESC ] ... (BEL | ST)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // CSI: ESC [ params final-byte
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
    .replace(/\x1b\[[0-9;?:<=>]*[ -/]*[@-~]/g, "")
    // Two-char escapes (charset selection, keypad modes, ESC ( B, …)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
    .replace(/\x1b[()#][@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
    .replace(/\x1b[@-~]/g, "");

  const lines: string[] = [];
  for (const rawLine of withoutEscapes.split("\n")) {
    // In-line cursor emulation: \r → column 0, \b → back one, printable
    // characters overwrite. What remains is what the user last saw.
    const cells: string[] = [];
    let column = 0;
    for (const char of rawLine) {
      if (char === "\r") {
        column = 0;
      } else if (char === "\b") {
        column = Math.max(0, column - 1);
      } else if (char === "\t") {
        column = Math.min(cells.length, column);
        do {
          cells[column] = cells[column] ?? " ";
          column += 1;
        } while (column % 8 !== 0);
      } else if (char >= " " || char.charCodeAt(0) > 0x9f) {
        cells[column] = char;
        column += 1;
      }
    }
    lines.push(
      cells
        .map((cell) => cell ?? " ")
        .join("")
        .trimEnd(),
    );
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  while (lines.length > 0 && lines[0] === "") lines.shift();
  return lines;
}
