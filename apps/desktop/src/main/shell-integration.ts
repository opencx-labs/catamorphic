import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Shell integration for agent-driven terminals: a ZDOTDIR shim that
 * sources the user's own zsh config and then adds OSC 133 semantic-prompt
 * hooks (preexec → `133;C`, precmd → `133;D;<exit>`), the same technique
 * VS Code and iTerm2 use. The markers are invisible in the emulator but
 * give the PTY side exact command boundaries and exit codes — no more
 * guessing "busy" from the foreground process name, and run_terminal can
 * report whether a command actually succeeded.
 *
 * Only agent-created terminals get the shim. The user's own terminals
 * stay exactly as their dotfiles configure them — an agent borrowing one
 * falls back to the foreground-process heuristic rather than us silently
 * rewriting the user's shell environment.
 *
 * Shells other than zsh (and any write failure) return null and fall
 * back to the heuristic; the terminal still works, just without markers.
 */

/** Emit `133;C` when a command is accepted, `133;D;<exit>` at the prompt. */
const ZSHRC_HOOKS = `
# --- Catamorphic shell integration (OSC 133 semantic prompts) ---
autoload -Uz add-zsh-hook 2>/dev/null && {
  __catamorphic_preexec() { builtin printf '\\e]133;C\\a'; }
  __catamorphic_precmd() { builtin printf '\\e]133;D;%s\\a' "$?"; }
  add-zsh-hook preexec __catamorphic_preexec
  add-zsh-hook precmd __catamorphic_precmd
}
`;

/**
 * Each shim file sources the user's counterpart with ZDOTDIR pointing at
 * their real dotfile directory, then restores the shim dir so zsh keeps
 * reading the remaining shim files. `USER_ZDOTDIR` is set at spawn time
 * (the user's original ZDOTDIR, or $HOME).
 */
function sourcingScript(file: string): string {
  return `
if [[ -f "\${USER_ZDOTDIR:-$HOME}/${file}" ]]; then
  CATAMORPHIC_SHIM_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="\${USER_ZDOTDIR:-$HOME}"
  . "$ZDOTDIR/${file}"
  USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$CATAMORPHIC_SHIM_ZDOTDIR"
  unset CATAMORPHIC_SHIM_ZDOTDIR
fi
`;
}

/**
 * After the user's .zshrc, leave ZDOTDIR the way their config expects it
 * (subshells they start by hand must not re-enter the shim), then add
 * the marker hooks — last, so they run after any prompt framework.
 */
const ZSHRC = `${sourcingScript(".zshrc")}
ZDOTDIR="\${USER_ZDOTDIR:-$HOME}"
[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR
${ZSHRC_HOOKS}`;

let shimDir: Promise<string | null> | null = null;

async function ensureShim(): Promise<string | null> {
  const dir = path.join(os.tmpdir(), "catamorphic-shell-integration", "zsh");
  try {
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, ".zshenv"), sourcingScript(".zshenv")),
      fs.writeFile(path.join(dir, ".zprofile"), sourcingScript(".zprofile")),
      fs.writeFile(path.join(dir, ".zlogin"), sourcingScript(".zlogin")),
      fs.writeFile(path.join(dir, ".zshrc"), ZSHRC),
    ]);
    return dir;
  } catch {
    return null;
  }
}

/**
 * Extra environment for an agent terminal's PTY spawn, or null when the
 * shell can't be integrated (non-zsh, or the shim failed to write).
 */
export async function shellIntegrationEnv(
  shell: string,
): Promise<Record<string, string> | null> {
  if (path.basename(shell) !== "zsh") return null;
  shimDir ??= ensureShim();
  const dir = await shimDir;
  if (!dir) return null;
  return {
    ZDOTDIR: dir,
    USER_ZDOTDIR: process.env.ZDOTDIR ?? os.homedir(),
  };
}
