import { describe, expect, it } from "vitest";
import { sanitizeTerminalOutput } from "./terminal-text.js";

/**
 * A real PTY capture (zsh 5.9 on macOS, agent shim active) of running a
 * bracketed-paste heredoc — prompt redraws, inverse-video EOL marker,
 * paste highlighting and all. The model-facing view must reduce to the
 * echoed command and its output.
 */
const REAL_ZSH_CAPTURE =
  "\x1b]133;D;0\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jtabaza@Tabazas-MacBook-Pro ~ % \x1b[K\x1b[?2004h" +
  "\x1b[7mcat <<'EOF'\x1b[27m\r\r\n\x1b[7malpha\x1b[27m\x1b[K\r\r\n\x1b[7mbeta\x1b[27m\x1b[K\r\r\n" +
  "\x1b[7mEOF\x1b[27m\x1b[K\x1b[3A\x1b[28C\x1b[27mc\x1b[27ma\x1b[27mt\x1b[27m \x1b[27m<\x1b[27m<" +
  "\x1b[27m'\x1b[27mE\x1b[27mO\x1b[27mF\x1b[27m'\x1b[1B\r\x1b[27ma\x1b[27ml\x1b[27mp\x1b[27mh\x1b[27ma\x1b[1B\r" +
  "\x1b[27mb\x1b[27me\x1b[27mt\x1b[27ma\x1b[1B\r\x1b[27mE\x1b[27mO\x1b[27mF\x1b[?2004l\r\r\n" +
  "\x1b]133;C\x07alpha\r\nbeta\r\n" +
  "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m" +
  "                                                                                                   \r \r" +
  "\x1b]133;D;0\x07\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jtabaza@Tabazas-MacBook-Pro ~ % \x1b[K\x1b[?2004h";

describe("sanitizeTerminalOutput on real zsh capture", () => {
  it("reduces a shim-shell heredoc run to readable text", () => {
    const clean = sanitizeTerminalOutput(REAL_ZSH_CAPTURE);
    // Command output survives.
    expect(clean).toContain("alpha");
    expect(clean).toContain("beta");
    // Prompts survive as plain text.
    expect(clean).toContain("tabaza@Tabazas-MacBook-Pro ~ %");
    // Every escape byte is gone.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting terminal bytes are stripped
    expect(clean).not.toMatch(/\x1b|\x07/);
    // The 133 markers don't leak as text.
    expect(clean).not.toContain("133;");
    // zsh's no-trailing-newline EOL marker (inverse "%") plus its padding
    // line collapses instead of surviving as a wall of blanks.
    expect(clean).not.toMatch(/ {20,}/);
  });
});
