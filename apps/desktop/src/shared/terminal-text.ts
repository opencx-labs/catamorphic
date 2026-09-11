/**
 * Model-facing terminal text processing. Two consumers of a PTY buffer
 * exist: the renderer's emulator wants the raw byte stream (it IS a
 * terminal), and the agent wants what a human would say the terminal
 * shows — no escape sequences, no spinner redraw history, no prompt
 * theme control noise. These helpers produce the latter, plus the OSC
 * 133 marker scanning that shell integration (see shell-integration.ts)
 * feeds the busy/exit-code tracking with.
 */

/** OSC 133 semantic-prompt marker: kind C = command start, D = done. */
export interface Osc133Marker {
  kind: string;
  /** For D markers: the command's exit code, when the shell sent one. */
  exitCode?: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
const OSC_133 = /\x1b\]133;([A-Za-z])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;

/**
 * Scan a PTY data chunk (prefixed with the previous chunk's carry) for
 * OSC 133 markers. Returns the carry: a trailing fragment that might be
 * the start of a marker split across chunks, to prepend to the next scan.
 */
export function scanOsc133(
  text: string,
  onMarker: (marker: Osc133Marker) => void,
): string {
  let lastEnd = 0;
  for (const match of text.matchAll(OSC_133)) {
    const kind = match[1] ?? "";
    const arg = match[2];
    const exitCode = arg !== undefined ? Number.parseInt(arg, 10) : Number.NaN;
    onMarker({
      kind: kind.toUpperCase(),
      ...(Number.isNaN(exitCode) ? {} : { exitCode }),
    });
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(lastEnd);
  const escIndex = rest.lastIndexOf("\x1b");
  if (escIndex === -1) return "";
  const tail = rest.slice(escIndex);
  const prefix = "\x1b]133;";
  // Carry only what could still become a marker, and never let an
  // unterminated sequence grow the carry without bound.
  if (tail.length < prefix.length) {
    return prefix.startsWith(tail) ? tail : "";
  }
  return tail.startsWith(prefix) && tail.length <= 256 ? tail : "";
}

/** OSC with BEL or ST terminator — or unterminated at the end of input. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
/** CSI sequences (colors, cursor movement, modes …). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
const CSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g;
/** Remaining two-byte escapes (charset selection, keypad modes …). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
const OTHER_ESC = /\x1b[@-Z\\-_]|\x1b[()#%][0-9A-Za-z]|\x1b./g;
/** C0 controls other than \n, \r, \t, \b (handled by the overlay pass). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
const CONTROL = /[\x00-\x07\x0b\x0c\x0e-\x1f\x7f]/g;

/** Erase sequences survive as sentinels for the overlay pass. */
const ERASE_RIGHT = "\uE000"; // CSI K / CSI 0K — clear cursor → end of line
const ERASE_LINE = "\uE001"; // CSI 2K — clear the whole line

/**
 * Reduce raw PTY output to the text a reader would consider its content:
 * strips escape sequences, then replays \r and \b overwrites so a
 * progress bar that redrew itself 400 times collapses to its final
 * frame. Cursor-addressed TUIs (vim, htop) are beyond repair here — they
 * degrade to their printed text in emission order.
 */
export function sanitizeTerminalOutput(raw: string): string {
  const flat = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
    .replace(/\x1b\[0?K/g, ERASE_RIGHT)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output
    .replace(/\x1b\[2K/g, ERASE_LINE)
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(OTHER_ESC, "")
    .replace(CONTROL, "");

  // Overlay pass: \r returns the cursor to column 0 (later text
  // overwrites, "abcdef\rxy" renders "xycdef"), \b steps back one.
  const lines: string[] = [];
  let line: string[] = [];
  let column = 0;
  const commit = () => {
    lines.push(line.join("").replace(/\s+$/, ""));
    line = [];
    column = 0;
  };
  for (const char of flat) {
    if (char === "\n") {
      commit();
    } else if (char === "\r") {
      column = 0;
    } else if (char === "\b") {
      column = Math.max(0, column - 1);
    } else if (char === ERASE_RIGHT) {
      line.length = Math.min(line.length, column);
    } else if (char === ERASE_LINE) {
      line.length = 0;
    } else {
      // Overwriting mid-line keeps the tail ("100%\r99" → "990%"), like
      // a real terminal would show.
      while (line.length < column) line.push(" ");
      line[column] = char;
      column += 1;
    }
  }
  commit();

  return lines
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/^\n+/, "");
}

/**
 * Cap model-facing output at `maxChars`, keeping the tail (the newest
 * output — what the model is usually waiting on) and saying so, instead
 * of silently losing the head.
 */
export function capOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept = text.slice(-maxChars);
  const omitted = text.length - kept.length;
  return `[…${omitted} earlier characters omitted…]\n${kept}`;
}

/**
 * Encode a run_terminal command for the PTY. Multi-line commands ride
 * bracketed paste so the shell takes the whole block as one unit — fed
 * plainly, every embedded newline would submit a partial command
 * (heredocs and quoted blocks arrive line-diced).
 */
export function encodeCommand(command: string): string {
  const trimmed = command.replace(/[\r\n]+$/, "");
  return trimmed.includes("\n")
    ? `\x1b[200~${trimmed}\x1b[201~\r`
    : `${trimmed}\r`;
}

/** How run_terminal observes a freshly spawned shell (see below). */
export interface ShellReadyProbe {
  /** The PTY process is still alive. */
  running(): boolean;
  /** OSC 133 `D` markers seen so far (each one is a prompt shown). */
  prompts(): number;
  /** Total output buffered so far. */
  bufferLength(): number;
}

/**
 * Wait until a freshly spawned shell is ready to READ input before
 * writing a command into it. Bytes written earlier sit in the tty's
 * input queue where the kernel echoes them once in canonical mode
 * (startup), and the line editor echoes them AGAIN when it takes over —
 * the transcript showed every command twice: a bare command line, then
 * the prompt+command redraw (reproduced against a real zsh PTY).
 *
 * Ready means: the first OSC 133 prompt marker arrived (shim shells,
 * exact), or — for shells without markers — output has flowed and then
 * stayed quiet for `idleMs` (the prompt is out, nothing more is coming).
 * The timeout keeps a pathological shell from stalling run_terminal;
 * writing late is merely cosmetic, so give up gracefully.
 */
export async function waitForShellReady(
  probe: ShellReadyProbe,
  opts?: { timeoutMs?: number; idleMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const idleMs = opts?.idleMs ?? 250;
  const pollMs = opts?.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastLength = probe.bufferLength();
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    if (!probe.running()) return;
    if (probe.prompts() >= 1) return;
    const length = probe.bufferLength();
    if (length !== lastLength) {
      lastLength = length;
      lastChange = Date.now();
    } else if (length > 0 && Date.now() - lastChange >= idleMs) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}
