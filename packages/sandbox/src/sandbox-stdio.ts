import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import {
  PROCESS_READ_MAX_BYTES,
  PROCESS_READ_MAX_WAIT_MS,
  PROCESS_SIGNALS,
  PROCESS_WRITE_MAX_BYTES,
  type ProcessSignal,
  type SandboxProcessProvider,
} from "./processes.js";

/**
 * A command speaking a stdio protocol, run inside a sandbox (ADR 0180): a
 * harness CLI such as Claude Code or the Codex app server. Its standard
 * output reaches the caller as a stream, its standard input is written in
 * short operations, and its standard error goes to a file in the sandbox so
 * it never mixes into the protocol.
 */
export interface SandboxStdioSpawnArgs {
  processes: SandboxProcessProvider;
  sandboxId: string;
  command: string;
  args: readonly string[];
  /** Absolute sandbox path the process starts in. */
  cwd: string;
  /** Exactly the process's environment beyond the sandbox's own. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Variables naming absolute sandbox paths. A provider may map sandbox
   * paths onto its own (local-process does), so they are resolved inside
   * the sandbox, relative to `cwd`, into the path the process sees.
   */
  pathEnv?: Readonly<Record<string, string>>;
  name?: string;
  /** Absolute sandbox path standard error is appended to. */
  stderrPath: string;
  /** The last of standard error, read when the process fails. */
  readStderr?: () => Promise<string>;
  /** Stops the process (SIGTERM) when aborted. */
  signal?: AbortSignal;
}

/**
 * The part of a Node child process that stdio clients use; the Claude Agent
 * SDK's `SpawnedProcess` and the Codex app server client accept it.
 */
export interface SandboxStdioProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  off(event: "error", listener: (error: Error) => void): this;
}

/** Writes above this size are split: each write crosses a queue. */
const WRITE_CHUNK_BYTES = Math.floor(PROCESS_WRITE_MAX_BYTES / 2);

/** Quote one word for bash. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Start `command args…` in the sandbox and return it as a child process.
 * Returns at once; a failure to start arrives as an `error` event, like a
 * spawn that cannot find its executable.
 */
export function spawnInSandbox(
  args: SandboxStdioSpawnArgs,
): SandboxStdioProcess {
  return new SandboxStdioChild(args);
}

class SandboxStdioChild extends EventEmitter implements SandboxStdioProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly started: Promise<string | undefined>;
  private exited = false;

  constructor(private readonly spawn: SandboxStdioSpawnArgs) {
    super();
    const env = Object.fromEntries(
      Object.entries(spawn.env ?? {}).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    );
    this.started = spawn.processes
      .startProcess({
        sandboxId: spawn.sandboxId,
        command: sandboxCommandLine(spawn),
        cwd: spawn.cwd,
        env,
        ...(spawn.name ? { name: spawn.name } : {}),
        stdin: true,
      })
      .then(
        (process) => {
          void this.pump(process.processId);
          return process.processId;
        },
        (error: unknown) => {
          this.fail(error);
          this.finish(127, null);
          return undefined;
        },
      );
    const write = async (data: string, end: boolean) => {
      const processId = await this.started;
      if (!processId || this.exited) return;
      await spawn.processes.writeProcessInput({
        sandboxId: spawn.sandboxId,
        processId,
        data,
        ...(end ? { end: true } : {}),
      });
    };
    this.stdin = new Writable({
      decodeStrings: false,
      writev: (chunks, callback) => {
        const text = chunks
          .map(({ chunk }) =>
            typeof chunk === "string"
              ? chunk
              : Buffer.from(chunk).toString("utf8"),
          )
          .join("");
        void (async () => {
          for (const part of splitUtf8(text, WRITE_CHUNK_BYTES))
            await write(part, false);
        })().then(
          () => callback(),
          (error: unknown) => callback(asError(error)),
        );
      },
      final: (callback) => {
        write("", true).then(
          () => callback(),
          (error: unknown) => callback(asError(error)),
        );
      },
    });
    // A failed write is the process's error, not an unhandled stream error.
    this.stdin.on("error", (error) => this.fail(error));
    spawn.signal?.addEventListener("abort", () => this.kill("SIGTERM"), {
      once: true,
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exited) return false;
    this.killed = true;
    const known: ProcessSignal =
      PROCESS_SIGNALS.find((candidate) => candidate === signal) ?? "SIGKILL";
    void this.started.then((processId) =>
      processId
        ? this.spawn.processes
            .signalProcess({
              sandboxId: this.spawn.sandboxId,
              processId,
              signal: known,
            })
            .catch((error: unknown) => this.fail(error))
        : undefined,
    );
    return true;
  }

  private async pump(processId: string): Promise<void> {
    let cursor = 0;
    try {
      for (;;) {
        const read = await this.spawn.processes.readProcessOutput({
          sandboxId: this.spawn.sandboxId,
          processId,
          cursor,
          maxBytes: PROCESS_READ_MAX_BYTES,
          waitMs: PROCESS_READ_MAX_WAIT_MS,
        });
        cursor = read.nextCursor;
        if (read.chunk && !this.stdout.write(read.chunk))
          await new Promise((resolve) => this.stdout.once("drain", resolve));
        if (read.status === "exited" && !read.more) {
          if (read.exitCode !== 0 && read.exitCode !== null)
            await this.forwardStderr();
          this.finish(read.exitCode, read.signal);
          return;
        }
      }
    } catch (error) {
      // Its output can no longer be followed: the process must not go on
      // working in the sandbox unseen once this child reads as exited.
      await this.spawn.processes
        .signalProcess({
          sandboxId: this.spawn.sandboxId,
          processId,
          signal: "SIGKILL",
        })
        .catch(() => {});
      this.fail(error);
      this.finish(1, null);
    }
  }

  private async forwardStderr(): Promise<void> {
    const text = await this.spawn.readStderr?.().catch(() => "");
    if (text) this.stderr.write(text);
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode =
      PROCESS_SIGNALS.find((candidate) => candidate === signal) ?? null;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", this.exitCode, this.signalCode);
  }

  private fail(error: unknown): void {
    // Node's rule: an `error` without listeners throws. Harness clients
    // listen; nothing else should bring the host down.
    if (this.listenerCount("error") > 0) this.emit("error", asError(error));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The shell line that starts a stdio command in the sandbox: path
 * variables resolved from `cwd`, standard error to its file, and `exec`, so
 * signals reach the command itself.
 */
export function sandboxCommandLine(
  spawn: Pick<
    SandboxStdioSpawnArgs,
    "command" | "args" | "cwd" | "pathEnv" | "stderrPath"
  >,
): string {
  const relative = (target: string) =>
    path.posix.relative(spawn.cwd, target) || ".";
  const stderr = relative(spawn.stderrPath);
  const exports = Object.entries(spawn.pathEnv ?? {}).map(([name, target]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`Invalid environment variable name '${name}'`);
    const at = relative(target);
    return `export ${name}="$(cd ${shellWord(path.posix.dirname(at))} && pwd -P)"/${shellWord(path.posix.basename(at))}`;
  });
  return [
    `mkdir -p ${shellWord(path.posix.dirname(stderr))}`,
    ...exports,
    `exec ${[spawn.command, ...spawn.args].map(shellWord).join(" ")} 2>>${shellWord(stderr)}`,
  ].join("\n");
}

/** Split text into parts of at most `bytes` UTF-8 bytes, on characters. */
export function splitUtf8(text: string, bytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text ? [text] : [];
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character, "utf8");
    if (size + length > bytes) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += length;
  }
  if (current) parts.push(current);
  return parts;
}
