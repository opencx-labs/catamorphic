import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "@catamorphic/agent-protocol";

/**
 * Shell integration for agent-driven terminals: a shim that sources the
 * user's own shell config and then adds OSC 133 semantic-prompt hooks
 * (`133;C` when a command starts, `133;D;<exit>` at the prompt), the same
 * technique VS Code and iTerm2 use. zsh gets a ZDOTDIR shim (preexec and
 * precmd); bash an init file (PS0 and PROMPT_COMMAND). The markers are
 * invisible in the emulator but give the PTY side exact command
 * boundaries and exit codes — no more guessing "busy" from the foreground
 * process name, which a loop between two `sleep`s fools, and run_terminal
 * can report whether a command actually succeeded.
 *
 * Only agent-created terminals get the shim. The user's own terminals
 * stay exactly as their dotfiles configure them — an agent borrowing one
 * falls back to the foreground-process heuristic rather than us silently
 * rewriting the user's shell environment.
 *
 * Other shells, bash before 4.4 (no PS0), and any write failure fall back
 * to the heuristic; the terminal still works, just without markers.
 */

/**
 * How agents' commands read in zsh: a pattern that matches nothing stays as
 * written, as bash leaves it, instead of failing the whole command with
 * "no matches found". Agents write bash (`grep -r --include=*.ts`), and an
 * aborted search reads to them as a search that found nothing. The null
 * glob options would drop the pattern instead, so they are off too. Agent
 * terminals run it after the user's .zshrc, Claude Code before each command
 * (`agentShellEnvFile`), Codex through its private startup files
 * (`codexShellEnvironment`), Work's own agent and watches with each
 * command (`withAgentShellOptions`). The user's own shells never see it.
 */
const ZSH_AGENT_OPTIONS = "setopt no_nomatch no_null_glob no_csh_null_glob";
const AGENT_SHELL_OPTIONS = `if [ -n "\${ZSH_VERSION:-}" ]; then ${ZSH_AGENT_OPTIONS}; fi
`;

/**
 * A command as an agent's `shell` runs it: with the agent shell options in
 * zsh, unchanged anywhere else (fish could not even parse them).
 */
export function withAgentShellOptions(command: string, shell: string): string {
  return path.basename(shell) === "zsh"
    ? `${ZSH_AGENT_OPTIONS}\n${command}`
    : command;
}

/**
 * Emit `133;C` when a command is accepted, `133;D;<exit>` at the prompt —
 * and, when the spawn provided a shim bin, put it FIRST on PATH here,
 * after the user's profiles ran (macOS path_helper and profile exports
 * would demote a PATH set at spawn time). The shim keeps URL opens inside
 * the app.
 */
const ZSHRC_HOOKS = `
# --- Work shell integration (OSC 133 semantic prompts) ---
autoload -Uz add-zsh-hook 2>/dev/null && {
  __catamorphic_preexec() { builtin printf '\\e]133;C\\a'; }
  __catamorphic_precmd() { builtin printf '\\e]133;D;%s\\a' "$?"; }
  add-zsh-hook preexec __catamorphic_preexec
  add-zsh-hook precmd __catamorphic_precmd
}
if [[ -n "\${CATAMORPHIC_BIN:-}" && -d "\${CATAMORPHIC_BIN:-}" ]]; then
  export PATH="$CATAMORPHIC_BIN:$PATH"
fi
if [[ -n "\${CATAMORPHIC_TOOLCHAIN_BIN:-}" && -d "\${CATAMORPHIC_TOOLCHAIN_BIN:-}" ]]; then
  export PATH="$CATAMORPHIC_TOOLCHAIN_BIN:$PATH"
fi
`;

/**
 * Each shim file sources the user's counterpart with ZDOTDIR pointing at
 * their real dotfile directory, then restores the shim dir so zsh keeps
 * reading the remaining shim files. `USER_ZDOTDIR` is set at spawn time
 * (the user's original ZDOTDIR, or $HOME).
 */
function sourcingScript(file: string): string {
  return `
if [[ -f "\${USER_ZDOTDIR-$HOME}/${file}" ]]; then
  CATAMORPHIC_SHIM_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="\${USER_ZDOTDIR-$HOME}"
  . "$ZDOTDIR/${file}"
  USER_ZDOTDIR="\${ZDOTDIR-$HOME}"
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
ZDOTDIR="\${USER_ZDOTDIR-$HOME}"
[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR
${AGENT_SHELL_OPTIONS}${ZSHRC_HOOKS}`;

/**
 * Agent command shims: URLs an agent (or the user) opens from a Work
 * terminal land as in-app browser tabs — the chat steps aside exactly as
 * for open_surface — instead of popping the system browser. Anything
 * that isn't purely http(s) URLs falls through to the real /usr/bin/open
 * untouched (files, apps, flags).
 */
const OPEN_SHIM = `#!/bin/sh
if [ -n "$CATAMORPHIC_OPEN_HOOK" ] && [ "$#" -gt 0 ]; then
  urls_only=1
  for arg in "$@"; do
    case "$arg" in
      http://*|https://*) ;;
      *) urls_only=0 ;;
    esac
  done
  if [ "$urls_only" = "1" ]; then
    status=0
    for arg in "$@"; do
      curl -fsS -m 5 --data-urlencode "url=$arg" "$CATAMORPHIC_OPEN_HOOK" >/dev/null 2>&1 || status=1
    done
    [ "$status" = "0" ] && exit 0
  fi
fi
exec /usr/bin/open "$@"
`;

/**
 * This process's own directory for the shims: created private (0700) and
 * checked to still be ours before each use, so another local user can
 * never plant a file an agent terminal would run (a shared /tmp on Linux).
 * A cleaner that removes it is answered with a new one.
 */
let root: Promise<string> | null = null;

async function ownedPrivately(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return (
      stat.isDirectory() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

/** Each call waits for the one before, so terminals opening together share one. */
function shimRoot(): Promise<string> {
  root = (async (previous) => {
    const dir = await previous?.catch(() => null);
    if (dir && (await ownedPrivately(dir))) return dir;
    return fs.mkdtemp(path.join(os.tmpdir(), "catamorphic-shell-"));
  })(root);
  return root;
}

/**
 * Write a shim file whole: a shell starting meanwhile reads the old file
 * or the new one, never half of it. Written at every use, so a removed
 * file is back for the next terminal.
 */
async function writeShim(input: {
  dir: string;
  name: string;
  content: string;
  mode?: number;
}): Promise<string> {
  await fs.mkdir(input.dir, { recursive: true, mode: 0o700 });
  const file = path.join(input.dir, input.name);
  const staging = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(staging, input.content, { mode: input.mode ?? 0o600 });
  await fs.rename(staging, file);
  return file;
}

/** The shim bin directory, or null off-macOS / on write failure. */
export async function shellBinShimDir(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const dir = path.join(await shimRoot(), "bin");
    await writeShim({ dir, name: "open", content: OPEN_SHIM, mode: 0o755 });
    return dir;
  } catch {
    return null;
  }
}

/**
 * The file Claude Code runs ahead of each of an agent's commands
 * (`CLAUDE_ENV_FILE`), holding the agent shell options. One the person set
 * for themselves still runs first. Every chat's Claude Code shares it and
 * its commands see its path, so it is read-only: an `export` appended to
 * it fails instead of reaching other chats. Null on Windows or a write
 * failure.
 */
export async function agentShellEnvFile(): Promise<string | null> {
  if (process.platform === "win32") return null;
  try {
    const own = process.env.CLAUDE_ENV_FILE;
    return await writeShim({
      dir: path.join(await shimRoot(), "harness"),
      name: "env.sh",
      content: `${own ? `if [ -f ${shellQuote(own)} ]; then . ${shellQuote(own)}; fi\n` : ""}${AGENT_SHELL_OPTIONS}`,
      mode: 0o400,
    });
  } catch {
    return null;
  }
}

/**
 * Codex has no per-command init file. Its supported shell environment
 * overrides point zsh at private startup files instead. The process gets
 * them too because Codex's shell snapshot reads its ambient environment.
 * Each file reads the person's counterpart, then applies our options,
 * including after the .zshrc that Codex sources when taking a snapshot.
 * Leave the shim in place for native commands and their nested shells;
 * only this Codex process inherits it. No prompt markers are installed.
 */
export async function codexShellEnvironment(input: {
  env: NodeJS.ProcessEnv;
  config: JsonObject;
}): Promise<Record<string, string> | null> {
  if (process.platform === "win32") return null;
  try {
    const rawPolicy = input.config.shell_environment_policy;
    const policy =
      rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy)
        ? rawPolicy
        : {};
    // Codex owns the filter engine. An allowlist can even remove explicit
    // set values; do not replace these policies or guess their result.
    if (
      policy.experimental_use_profile === true ||
      [policy.exclude, policy.include_only, policy.filters].some(
        (value) =>
          value && typeof value === "object" && Object.keys(value).length > 0,
      )
    )
      return null;
    const configured = policy.set;
    const environment =
      configured && typeof configured === "object" && !Array.isArray(configured)
        ? configured
        : {};
    const inheritedDotfiles =
      policy.inherit !== "none" && policy.inherit !== "core"
        ? input.env.ZDOTDIR
        : undefined;
    const home =
      typeof environment.HOME === "string"
        ? environment.HOME
        : policy.inherit === "none"
          ? os.userInfo().homedir
          : (input.env.HOME ?? os.homedir());
    const dotfiles =
      typeof environment.ZDOTDIR === "string"
        ? environment.ZDOTDIR
        : (inheritedDotfiles ?? home);
    // An explicitly empty root retains Codex's native startup behavior.
    if (!dotfiles) return null;
    const dir = path.join(await shimRoot(), "codex-zsh");
    await Promise.all(
      [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"].map((name) =>
        writeShim({
          dir,
          name,
          content: `${name === ".zshenv" ? 'if (( $+CATAMORPHIC_CODEX_SHELL_HOME )); then export HOME="$CATAMORPHIC_CODEX_SHELL_HOME"; fi\n' : ""}${sourcingScript(name)}${name === ".zlogout" ? "" : AGENT_SHELL_OPTIONS}`,
          mode: 0o400,
        }),
      ),
    );
    return {
      ZDOTDIR: dir,
      USER_ZDOTDIR: dotfiles,
      // Snapshot startup must see the command's configured HOME without
      // moving the app-server's own config and sign-in directory.
      ...(typeof environment.HOME === "string"
        ? { CATAMORPHIC_CODEX_SHELL_HOME: home }
        : {}),
    };
  } catch {
    return null;
  }
}

/** `value` as one single-quoted shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The bash init file: a login shell's startup files, as `bash -l` reads
 * them (bash reads no init file in a login shell, so this one starts
 * non-login and does it itself; Debian's bash also reads /etc/bash.bashrc
 * first, as VS Code's integration finds), then the same PATH shims as zsh
 * and the markers: `PS0` prints `133;C` as a command starts, the first
 * `PROMPT_COMMAND` entry keeps the command's status and the last prints
 * `133;D;<exit>` after the person's own hooks. A read-only
 * `PROMPT_COMMAND` (audit setups) gets no markers: a start without an end
 * would keep every command busy.
 */
const BASH_INIT = `
[ -f /etc/profile ] && . /etc/profile
for __catamorphic_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$__catamorphic_profile" ]; then
    . "$__catamorphic_profile"
    break
  fi
done
unset __catamorphic_profile
if [[ -n "\${CATAMORPHIC_BIN:-}" && -d "\${CATAMORPHIC_BIN:-}" ]]; then
  export PATH="$CATAMORPHIC_BIN:$PATH"
fi
if [[ -n "\${CATAMORPHIC_TOOLCHAIN_BIN:-}" && -d "\${CATAMORPHIC_TOOLCHAIN_BIN:-}" ]]; then
  export PATH="$CATAMORPHIC_TOOLCHAIN_BIN:$PATH"
fi
# --- Work shell integration (OSC 133 semantic prompts) ---
__catamorphic_flags=$(declare -p PROMPT_COMMAND 2>/dev/null)
__catamorphic_flags=\${__catamorphic_flags#declare -}
__catamorphic_flags=\${__catamorphic_flags%% *}
if [[ "$__catamorphic_flags" != *r* ]]; then
  __catamorphic_status() {
    __catamorphic_last=$?
    return "$__catamorphic_last"
  }
  __catamorphic_precmd() {
    builtin printf '\\e]133;D;%s\\a' "\${__catamorphic_last:-0}"
  }
  if [[ "$__catamorphic_flags" == *a* ]] && (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=(__catamorphic_status "\${PROMPT_COMMAND[@]}" __catamorphic_precmd)
  else
    # Newlines, not semicolons: a person's "history -a; " or trailing
    # comment would turn a joining ";" into a syntax error, or swallow it.
    __catamorphic_nl=$'\\n'
    PROMPT_COMMAND="__catamorphic_status$__catamorphic_nl\${PROMPT_COMMAND:+$PROMPT_COMMAND$__catamorphic_nl}__catamorphic_precmd"
    unset __catamorphic_nl
  fi
  # Nested shells (a poetry shell, tmux) would inherit hook names they lack.
  export -n PROMPT_COMMAND
  PS0="\${PS0:-}"$'\\e]133;C\\a'
fi
unset __catamorphic_flags
`;

/** Whether a bash prints `PS0`, which marks a command's start (4.4+). */
const bashVersions = new Map<string, Promise<boolean>>();

function bashMarksCommands(shell: string): Promise<boolean> {
  const known = bashVersions.get(shell);
  if (known) return known;
  const marks = new Promise<boolean>((resolve) => {
    execFile(
      shell,
      ["-c", 'echo "$BASH_VERSION"'],
      { timeout: 2_000 },
      (error, stdout) => {
        // A probe that failed (a slow start) is asked again next time.
        if (error) bashVersions.delete(shell);
        resolve(!error && hasPs0(String(stdout)));
      },
    );
  });
  bashVersions.set(shell, marks);
  return marks;
}

/** A `BASH_VERSION` (`5.2.37(1)-release`) of 4.4 or later. */
function hasPs0(version: string): boolean {
  const [, major = 0, minor = 0] =
    /^(\d+)\.(\d+)/.exec(version.trim())?.map(Number) ?? [];
  return major > 4 || (major === 4 && minor >= 4);
}

/**
 * How an agent terminal's shell starts with integration: its arguments
 * and extra environment, or null when the shell can't be integrated
 * (another shell, bash before 4.4, or a shim that failed to write).
 */
export async function shellIntegration(
  shell: string,
): Promise<{ args: string[]; env: Record<string, string> } | null> {
  try {
    const name = path.basename(shell);
    if (name === "zsh") {
      const dir = path.join(await shimRoot(), "zsh");
      await Promise.all([
        writeShim({ dir, name: ".zshenv", content: sourcingScript(".zshenv") }),
        writeShim({
          dir,
          name: ".zprofile",
          content: sourcingScript(".zprofile"),
        }),
        writeShim({ dir, name: ".zlogin", content: sourcingScript(".zlogin") }),
        writeShim({ dir, name: ".zshrc", content: ZSHRC }),
      ]);
      return {
        // A login shell, like Terminal.app; the shim reads the user's files.
        args: ["-l"],
        env: {
          ZDOTDIR: dir,
          USER_ZDOTDIR: process.env.ZDOTDIR ?? os.homedir(),
        },
      };
    }
    if (name === "bash" && (await bashMarksCommands(shell))) {
      const file = await writeShim({
        dir: path.join(await shimRoot(), "bash"),
        name: "init.bash",
        content: BASH_INIT,
      });
      return { args: ["--init-file", file], env: {} };
    }
  } catch {
    // The terminal still works, on the foreground-process heuristic.
  }
  return null;
}
