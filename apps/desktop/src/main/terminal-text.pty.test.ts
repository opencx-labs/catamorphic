import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type IPty, spawn as spawnPty } from "@lydell/node-pty";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeCommand,
  type Osc133Marker,
  sanitizeTerminalOutput,
  scanOsc133,
  waitForShellReady,
} from "./terminal-text.js";

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

/**
 * Live-PTY pins for the run_terminal write path: a REAL zsh with the
 * OSC 133 hooks (a deterministic stand-in for shell-integration.ts's
 * shim — fixed prompt, no user dotfiles). Guards the duplicated-command
 * regression: writing before the shell's first prompt gets the command
 * echoed once by the tty (canonical-mode startup echo) and again by ZLE
 * at the prompt. waitForShellReady + encodeCommand must produce a
 * transcript that reads like a normal session — one prompt line carrying
 * the command, output on the next line — with completion counting and
 * exit codes intact.
 */
const ZSH = "/bin/zsh";

class PtyHarness {
  readonly pty: IPty;
  buffer = "";
  markers: Osc133Marker[] = [];
  private carry = "";

  constructor(zdotdir: string) {
    this.pty = spawnPty(ZSH, ["-l"], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        ZDOTDIR: zdotdir,
        TERM: "xterm-256color",
      } as Record<string, string>,
    });
    this.pty.onData((data) => {
      this.buffer += data;
      this.carry = scanOsc133(this.carry + data, (marker) =>
        this.markers.push(marker),
      );
    });
  }

  get prompts(): number {
    return this.markers.filter((marker) => marker.kind === "D").length;
  }

  get starts(): number {
    return this.markers.filter((marker) => marker.kind === "C").length;
  }

  async waitFor(
    predicate: () => boolean,
    timeoutMs = 10_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
  }
}

async function shimZdotdir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-pty-test-"));
  await fs.writeFile(
    path.join(dir, ".zshrc"),
    `
PS1='PROMPT> '
autoload -Uz add-zsh-hook 2>/dev/null && {
  __cat_test_preexec() { builtin printf '\\e]133;C\\a'; }
  __cat_test_precmd() { builtin printf '\\e]133;D;%s\\a' "$?"; }
  add-zsh-hook preexec __cat_test_preexec
  add-zsh-hook precmd __cat_test_precmd
}
`,
  );
  return dir;
}

describe.skipIf(!existsSync(ZSH))(
  "run_terminal write path (real zsh PTY)",
  () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    });

    async function readyHarness(): Promise<PtyHarness> {
      const zdotdir = await shimZdotdir();
      const harness = new PtyHarness(zdotdir);
      cleanups.push(async () => {
        const exited = new Promise<void>((resolve) => {
          const listener = harness.pty.onExit(() => {
            listener.dispose();
            resolve();
          });
        });
        harness.pty.kill();
        await exited;
        await fs.rm(zdotdir, { recursive: true, force: true });
      });
      await waitForShellReady({
        running: () => true,
        prompts: () => harness.prompts,
        bufferLength: () => harness.buffer.length,
      });
      // The bug: before the ready-wait, zero prompts had been seen and the
      // tty was still in canonical mode — this is the pin that the wait
      // really anchors on the first prompt.
      expect(harness.prompts).toBeGreaterThanOrEqual(1);
      return harness;
    }

    it("echoes a command exactly once: prompt+command line, then output", async () => {
      const harness = await readyHarness();
      const promptsBefore = harness.prompts;

      harness.pty.write(encodeCommand("echo catamorphic-pty-single"));
      expect(await harness.waitFor(() => harness.prompts > promptsBefore)).toBe(
        true,
      );

      // The WHOLE transcript, startup included — the duplicate used to be
      // a bare command line echoed BEFORE the first prompt ever showed.
      const clean = sanitizeTerminalOutput(harness.buffer);
      // The command text appears ONCE (the prompt echo) — not a bare
      // duplicate line ahead of the prompt redraw.
      expect(clean.match(/echo catamorphic-pty-single/g) ?? []).toHaveLength(1);
      // And it reads like a shell session: the prompt line carries the
      // command; the output is the next line.
      expect(clean).toMatch(
        /PROMPT> echo catamorphic-pty-single\ncatamorphic-pty-single\n/,
      );
      // Exactly one command ran (one C), and its exit code came through.
      expect(harness.starts).toBe(1);
      expect(harness.markers.at(-1)).toEqual({ kind: "D", exitCode: 0 });
    });

    it("runs a multi-line command as ONE bracketed paste with one exit code", async () => {
      const harness = await readyHarness();
      const promptsBefore = harness.prompts;
      const baseline = harness.buffer.length;

      harness.pty.write(encodeCommand("cat <<'EOF'\npty-alpha\npty-beta\nEOF"));
      expect(await harness.waitFor(() => harness.prompts > promptsBefore)).toBe(
        true,
      );

      // One preexec, one completion: the heredoc executed as a single
      // command, not line-diced fragments.
      expect(harness.starts).toBe(1);
      expect(harness.prompts).toBe(promptsBefore + 1);
      expect(harness.markers.at(-1)).toEqual({ kind: "D", exitCode: 0 });
      const clean = sanitizeTerminalOutput(harness.buffer.slice(baseline));
      expect(clean).toContain("pty-alpha");
      expect(clean).toContain("pty-beta");
    });

    it("reports non-zero exit codes through the 133;D marker", async () => {
      const harness = await readyHarness();
      const promptsBefore = harness.prompts;

      harness.pty.write(
        encodeCommand("exit_code_probe() { return 42 }; exit_code_probe"),
      );
      expect(await harness.waitFor(() => harness.prompts > promptsBefore)).toBe(
        true,
      );
      expect(harness.markers.at(-1)).toEqual({ kind: "D", exitCode: 42 });
    });
  },
);
