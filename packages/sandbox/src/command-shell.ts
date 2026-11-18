import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Commands run apart from the agent (ADR 0332): a harness on the agent side
 * of a sandbox uses a `bash` shim as its shell, and finds a `git` shim
 * first on its `PATH`. A shim forwards the command to the provider's
 * command socket, which runs it on the command side in its own process
 * group and streams it back. Newline-delimited JSON both ways:
 *
 * - shim to provider: one {@link CommandRequest}, then `{ i: <base64> }`
 *   for standard input, `{ eof: true }` when it ends, and `{ signal }` for
 *   a signal the shim received;
 * - provider to shim: `{ o: <base64> }` and `{ e: <base64> }` for the
 *   command's output and errors, `{ r: { <path>: <base64> } }` for the
 *   files it returns, then `{ x: <exit code> }`, or `{ error: <message> }`.
 *
 * A connection that drops before the command ends stops its whole group.
 */
export interface CommandRequest {
  /** `bash` or `git` and their arguments: the programs a shim stands for. */
  argv: string[];
  cwd: string;
  /** What of the agent side's environment the command keeps; see {@link commandEnvironment}. */
  env: Record<string, string>;
  /**
   * Claude Code's working-directory files the command writes in the shim's
   * return folder (`claude-<id>-cwd`): brought back when it ends, small and
   * regular only.
   */
  returns: string[];
}

/** The programs a shim runs on the command side. */
export const COMMAND_PROGRAMS = ["bash", "git"] as const;

/** Signals a shim forwards; the provider sends them to the whole group. */
export const COMMAND_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type CommandSignal = (typeof COMMAND_SIGNALS)[number];

/** The most files one command returns, and the most bytes each. */
export const COMMAND_RETURN_LIMIT = { files: 16, bytes: 64 * 1024 };

/** The only files a command returns: Claude Code's working-directory files. */
export const COMMAND_RETURN_NAME = /^claude-[A-Za-z0-9]{1,32}-cwd$/;

/**
 * What a command keeps of the agent side's environment (ADR 0332): how
 * output looks and nothing else. The command side keeps its own `PATH`,
 * `HOME` and user, and loads its own session files (the Environment's
 * secrets, its gateway variables), so no value from beside the agent
 * reaches it unless it is named here.
 */
export const COMMAND_VARIABLES = [
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TZ",
  "CI",
  "COLUMNS",
  "LINES",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "PAGER",
  "GIT_PAGER",
  "GIT_EDITOR",
  "EDITOR",
  "VISUAL",
  // Claude Code marks the commands it runs.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
] as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a command keeps a variable of the agent side's environment. */
function kept(name: string): boolean {
  return (
    NAME.test(name) &&
    (COMMAND_VARIABLES.some((allowed) => allowed === name) ||
      name.startsWith("LC_"))
  );
}

/** What of an agent-side environment a command takes along (ADR 0332). */
export function commandEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (typeof value === "string" && kept(name)) result[name] = value;
  return result;
}

/**
 * The shim's client, run with Node, or Bun without its configuration and
 * .env files: Node built-ins only, no Work code, so it starts quickly for
 * every command. Arguments:
 * the caller's working directory, the socket, the return folder (or
 * empty), the program it stands for, then that program's own arguments.
 */
export const COMMAND_SHELL_CLIENT_SOURCE = `import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const [callerCwd, socketPath, returnFolder, program, ...args] = process.argv.slice(2);
const KEPT = new Set(${JSON.stringify(COMMAND_VARIABLES)});
const env = {};
for (const [name, value] of Object.entries(process.env))
  if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && (KEPT.has(name) || name.startsWith("LC_")))
    env[name] = value;
const RETURNED = ${COMMAND_RETURN_NAME.toString()};
const prefix = returnFolder ? returnFolder.replace(/\\/+$/, "") + "/" : "";
const returns = new Set();
if (prefix)
  for (const arg of args) {
    let at = arg.indexOf(prefix);
    while (at >= 0) {
      const name = /^[A-Za-z0-9._-]+/.exec(arg.slice(at + prefix.length));
      if (name && RETURNED.test(name[0])) returns.add(prefix + name[0]);
      at = arg.indexOf(prefix, at + 1);
    }
  }
const cwd = callerCwd || "/";
const NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
let ended = false;
let pending = "";
const socket = net.createConnection(socketPath);
const send = (frame) => { if (!socket.destroyed) socket.write(JSON.stringify(frame) + "\\n"); };
const finish = (code) => {
  if (ended) return;
  ended = true;
  let waiting = 2;
  const done = () => { if (--waiting === 0) process.exit(code); };
  process.stdout.write("", done);
  process.stderr.write("", done);
};
const fail = (message) => {
  if (ended) return;
  process.stderr.write("Work: " + message + "\\n");
  finish(126);
};
socket.on("connect", () => {
  send({ argv: [program, ...args], cwd, env, returns: [...returns].slice(0, ${COMMAND_RETURN_LIMIT.files}) });
  process.stdin.on("data", (chunk) => send({ i: Buffer.from(chunk).toString("base64") }));
  process.stdin.on("end", () => send({ eof: true }));
  process.stdin.on("error", () => send({ eof: true }));
});
for (const signal of Object.keys(NUMBERS))
  process.on(signal, () => {
    send({ signal });
    setTimeout(() => finish(128 + NUMBERS[signal]), 10000).unref();
  });
socket.on("data", (data) => {
  pending += data.toString("utf8");
  let end = pending.indexOf("\\n");
  while (end >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    end = pending.indexOf("\\n");
    if (!line.trim()) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (typeof frame.o === "string") process.stdout.write(Buffer.from(frame.o, "base64"));
    else if (typeof frame.e === "string") process.stderr.write(Buffer.from(frame.e, "base64"));
    else if (frame.r && typeof frame.r === "object")
      for (const [file, content] of Object.entries(frame.r)) {
        if (!returns.has(file) || typeof content !== "string" || path.dirname(file) + "/" !== prefix) continue;
        try {
          const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
          try { fs.writeSync(fd, Buffer.from(content, "base64")); } finally { fs.closeSync(fd); }
        } catch {}
      }
    else if (typeof frame.x === "number") { finish(frame.x); socket.destroy(); }
    else if (typeof frame.error === "string") { fail(frame.error); socket.destroy(); }
  }
});
socket.on("error", (error) => fail("the command container is not reachable (" + error.message + ")"));
socket.on("close", () => fail("the connection to the command container closed before the command ended"));
`;

/**
 * The shim's files (ADR 0332): its client, the `bash` a harness uses as
 * its shell, and the `git` first on its `PATH`, each with its mode, keyed
 * by absolute path. `path` is the folder to put first on the harness's
 * `PATH`: it holds `git` alone, so nothing else the harness runs by name
 * is redirected.
 */
export function commandShellFiles(input: {
  directory: string;
  socket: string;
  runtime: string;
  returnFolder?: string;
}): {
  shell: string;
  path: string;
  files: Record<string, { content: string; mode: number }>;
} {
  const client = path.posix.join(input.directory, "shell.mjs");
  const shell = path.posix.join(input.directory, "bin", "bash");
  const pathFolder = path.posix.join(input.directory, "path");
  // An empty configuration of its own: Bun reads bunfig.toml (preloads)
  // and .env files from where it starts, which for a harness is the
  // checkout the pull request controls.
  const config = path.posix.join(input.directory, "bunfig.toml");
  const flags = /(^|\/)bun[^/]*$/.test(input.runtime)
    ? ` --no-env-file --config=${quote(config)}`
    : "";
  const wrapper = (program: string) =>
    [
      "#!/bin/sh",
      `# Work: this ${program} runs in the command container (ADR 0332).`,
      // It starts in its own folder and says where it was called from, so
      // nothing in the caller's folder loads into it.
      // Its folder's name may end in newlines, which $(...) strips: a
      // mark after pwd's own newline keeps them.
      `caller=$(pwd -P 2>/dev/null && printf x) && caller=\${caller%?x} || caller=/`,
      `cd ${quote(input.directory)} || exit 126`,
      "unset NODE_OPTIONS NODE_PATH BUN_OPTIONS",
      `exec ${quote(input.runtime)}${flags} ${quote(client)} "$caller" ${quote(input.socket)} ${quote(input.returnFolder ?? "")} ${program} "$@"`,
      "",
    ].join("\n");
  return {
    shell,
    path: pathFolder,
    files: {
      [client]: { content: COMMAND_SHELL_CLIENT_SOURCE, mode: 0o600 },
      [config]: { content: "", mode: 0o600 },
      [shell]: { content: wrapper("bash"), mode: 0o700 },
      [path.posix.join(pathFolder, "git")]: {
        content: wrapper("git"),
        mode: 0o700,
      },
    },
  };
}

/**
 * Write the shim into `directory` (beside the runner's state, ADR 0321):
 * the path of its `bash`, for a harness's shell setting, and the folder to
 * put first on the harness's `PATH`. `runtime` is the Bun or Node that
 * runs it (the runner's own).
 */
export async function writeCommandShell(input: {
  directory: string;
  socket: string;
  runtime: string;
  /** Where the harness reads files its commands write (see {@link CommandRequest.returns}). */
  returnFolder?: string;
}): Promise<{ shell: string; path: string }> {
  const { shell, path: pathFolder, files } = commandShellFiles(input);
  for (const [file, { content, mode }] of Object.entries(files)) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, content, { mode });
    await chmod(file, mode);
  }
  if (input.returnFolder)
    await mkdir(input.returnFolder, { recursive: true, mode: 0o700 });
  return { shell, path: pathFolder };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A stdio MCP server's command as a harness of its own user starts it
 * (ADR 0332): in that user's home, never the checkout, where a launcher
 * (`npx`, `bunx`, `uvx`) would resolve the pull request's
 * `node_modules/.bin`, `.npmrc`, `bunfig.toml` or `uv.toml`; and without
 * the variables that load code into Node or Bun.
 */
export function homeStartedCommand(input: {
  command: string;
  args?: readonly string[];
  home: string;
}): { command: string; args: string[] } {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      'cd "$1" || exit 126; shift; unset NODE_OPTIONS NODE_PATH BUN_OPTIONS; exec "$@"',
      "work-mcp",
      input.home,
      input.command,
      ...(input.args ?? []),
    ],
  };
}
