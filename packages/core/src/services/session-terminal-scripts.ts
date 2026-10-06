import { posix } from "node:path";
import { shellQuote } from "@catamorphic/git";
import { GATEWAY_ENV_IN_SESSION_DIRECTORY } from "./sandbox-git.js";
import { SECRETS_IN_SESSION_DIRECTORY } from "./sandbox-secrets.js";

/*
 * The shell side of a terminal in a chat's workspace (ADR 0208). Every
 * command runs from the project folder, and paths are relative to it: a
 * local-process sandbox maps only its working directory onto the machine,
 * so an absolute sandbox path in a command would not resolve there.
 */

/** How a terminal gets its pseudo-terminal. */
export type TerminalPty = "util-linux" | "bsd" | "none";

/** The session directory as seen from the project folder (a command's cwd). */
export function sessionDirectoryFromProject(input: {
  projectDirectory: string;
  sessionDirectory: string;
}): string {
  return posix.relative(input.projectDirectory, input.sessionDirectory);
}

/**
 * Loads the gateway's variables (ADR 0211) and the Environment's secrets
 * (ADR 0205) into a shell, each when this workspace has it: the files
 * `sandboxSecretsPrelude` loads, named from a shell word for the session
 * directory instead of the project folder, since a terminal records where
 * it started.
 */
export function terminalSecretsSnippet(sessionDirectory: string): string {
  return [GATEWAY_ENV_IN_SESSION_DIRECTORY, SECRETS_IN_SESSION_DIRECTORY]
    .map((name) => {
      const file = `${sessionDirectory}/${name}`;
      return `if [ -f ${file} ]; then . ${file}; fi`;
    })
    .join("; ");
}

/**
 * Runs inside the terminal (POSIX sh): `$1` is its state directory, `$2`
 * says whether it has a pseudo-terminal. It records the terminal device
 * and the shell's process id (a resize needs both), sizes the device,
 * loads the gateway's variables and the secrets, and becomes the login
 * shell: bash when present.
 */
function startScript(): string {
  return [
    'd=$1; mode=$2; s=$(cd "$d/../.." && pwd)',
    'tty > "$d/tty" 2>/dev/null || :',
    'if [ "$mode" = pty ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansions
    '  stty cols "${COLUMNS:-80}" rows "${LINES:-24}" 2>/dev/null || :',
    // Programs prefer these to the device's size; a resize changes only
    // the device. The shell sets its own.
    "  unset COLUMNS LINES",
    "fi",
    `printf '%s\\n' "$$" > "$d/pid"`,
    `${terminalSecretsSnippet('"$s"')} || :`,
    "if command -v bash >/dev/null 2>&1; then SHELL=$(command -v bash); else SHELL=$(command -v sh); fi",
    "export SHELL",
    'if [ "$mode" = pty ]; then exec "$SHELL" -l; fi',
    'exec "$SHELL" -il',
  ].join("\n");
}

const START_END = "WORK_TERMINAL_START";

/**
 * Prepares a terminal's state directory and says which pseudo-terminal the
 * sandbox offers, as one line `pty=<kind>`: util-linux `script`, the BSD
 * `script` of macOS (a local-process sandbox there), or none.
 */
export function prepareTerminalCommand(input: {
  sessionFromProject: string;
  key: string;
}): string {
  const directory = shellQuote(
    `${input.sessionFromProject}/terminals/${input.key}`,
  );
  return [
    "set -e",
    `mkdir -p ${directory}`,
    `cat > ${directory}/start.sh <<'${START_END}'`,
    startScript(),
    START_END,
    "set +e",
    "if script --version 2>/dev/null | grep -q util-linux; then echo pty=util-linux",
    'elif [ "$(uname -s)" != Linux ] && command -v script >/dev/null 2>&1; then echo pty=bsd',
    "else echo pty=none; fi",
  ].join("\n");
}

/** The pseudo-terminal kind `prepareTerminalCommand` reported. */
export function parseTerminalPty(output: string): TerminalPty {
  const line = output
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text.startsWith("pty="))
    .at(-1);
  const kind = line?.slice("pty=".length);
  return kind === "util-linux" || kind === "bsd" ? kind : "none";
}

/**
 * The terminal's process (run with bash from the project folder): the
 * start script under `script`, which gives it a pseudo-terminal whose
 * output is the process's output and whose input is the process's input.
 */
export function terminalProcessCommand(input: {
  sessionFromProject: string;
  key: string;
  pty: TerminalPty;
}): string {
  const directory = shellQuote(
    `${input.sessionFromProject}/terminals/${input.key}`,
  );
  const resolve = `d=$(cd ${directory} && pwd -P) || exit 1`;
  switch (input.pty) {
    case "util-linux":
      // `script -c` runs its command with $SHELL; the start script sets
      // the shell the person gets.
      return [
        resolve,
        'exec env SHELL=/bin/sh script -qfec "/bin/sh $(printf %q "$d/start.sh") $(printf %q "$d") pty" /dev/null',
      ].join("\n");
    case "bsd":
      // BSD `script` refuses a socket as its input, which is what some
      // hosts hand a process; a pipe it takes.
      return [
        resolve,
        'cat | script -q /dev/null /bin/sh "$d/start.sh" "$d" pty',
      ].join("\n");
    case "none":
      return [resolve, 'exec /bin/sh "$d/start.sh" "$d" plain 2>&1'].join("\n");
  }
}

/**
 * Sizes the terminal's device; the kernel tells its foreground programs,
 * and the shell's group is told as well. A terminal without a device
 * keeps its size.
 */
export function resizeTerminalCommand(input: {
  sessionFromProject: string;
  key: string;
  cols: number;
  rows: number;
}): string {
  const directory = shellQuote(
    `${input.sessionFromProject}/terminals/${input.key}`,
  );
  const cols = Math.trunc(input.cols);
  const rows = Math.trunc(input.rows);
  return [
    `t=$(cat ${directory}/tty 2>/dev/null) || exit 0`,
    "case $t in /dev/*) ;; *) exit 0 ;; esac",
    `stty cols ${cols} rows ${rows} < "$t" 2>/dev/null || exit 0`,
    `p=$(cat ${directory}/pid 2>/dev/null) && kill -WINCH -- "-$p" 2>/dev/null`,
    "exit 0",
  ].join("\n");
}

/** Removes a closed terminal's state directory. */
export function removeTerminalCommand(input: {
  sessionFromProject: string;
  key: string;
}): string {
  return `rm -rf ${shellQuote(`${input.sessionFromProject}/terminals/${input.key}`)}`;
}
