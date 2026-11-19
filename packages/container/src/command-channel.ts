import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  COMMAND_PROGRAMS,
  COMMAND_RETURN_LIMIT,
  COMMAND_RETURN_NAME,
  COMMAND_SIGNALS,
  type CommandRequest,
  type CommandSignal,
  commandEnvironment,
} from "@catamorphic/sandbox";

/**
 * One command a shim on the agent side sent (ADR 0332), as the provider
 * runs it: its request, its input and signals as they arrive, and where
 * its output goes. `aborted` fires when the shim went away.
 */
export interface CommandSession {
  readonly request: CommandRequest;
  readonly aborted: AbortSignal;
  /** Input as it arrives; `null` once it ended. */
  onInput(listener: (data: Buffer | null) => void): void;
  onSignal(listener: (signal: CommandSignal) => void): void;
  /**
   * Send output on; resolves once the shim has taken it in (the socket
   * drained), so a command whose shim reads slowly is held back rather
   * than buffered here.
   */
  stdout(data: Buffer): Promise<void>;
  stderr(data: Buffer): Promise<void>;
  returned(files: Record<string, Buffer>): void;
  exit(code: number): void;
  error(message: string): void;
}

export interface CommandChannel {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** The largest request line: arguments and environment together. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** The largest later line: one chunk of input, as base64. */
const MAX_LINE_BYTES = 1024 * 1024;
/** Commands one agent side runs at once. */
const MAX_CONNECTIONS = 64;
/** Output frames carry at most this much each. */
const OUTPUT_CHUNK_BYTES = 48 * 1024;

/**
 * Serve a sandbox's command socket on the machine (ADR 0332), mounted into
 * its agent side alone. Each connection is one command: the request line,
 * then input and signals; `run` runs it on the command side. A connection
 * that drops aborts its session, and `run` stops the command's group.
 */
export async function startCommandChannel(args: {
  socketPath: string;
  run: (session: CommandSession) => Promise<void>;
  log?: (line: string) => void;
}): Promise<CommandChannel> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.end(
        `${JSON.stringify({ error: `at most ${MAX_CONNECTIONS} commands run at once` })}\n`,
      );
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    serve({ socket, run: args.run, log: args.log });
  });
  fs.mkdirSync(path.dirname(args.socketPath), {
    recursive: true,
    mode: 0o755,
  });
  fs.rmSync(args.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The agent side's user may be anyone; only the agent side mounts it.
  fs.chmodSync(args.socketPath, 0o666);
  return {
    socketPath: args.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        fs.rmSync(args.socketPath, { force: true });
      }),
  };
}

function serve(args: {
  socket: net.Socket;
  run: (session: CommandSession) => Promise<void>;
  log?: (line: string) => void;
}): void {
  const { socket } = args;
  const abort = new AbortController();
  const inputs: Array<(data: Buffer | null) => void> = [];
  const signals: Array<(signal: CommandSignal) => void> = [];
  let session: CommandSession | undefined;
  let pending = Buffer.alloc(0);
  let done = false;
  const send = (frame: Record<string, unknown>) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  };
  /** Send a frame and wait until the socket drains, or closes. */
  const sendDrained = (frame: Record<string, unknown>): Promise<void> => {
    if (socket.destroyed) return Promise.resolve();
    if (socket.write(`${JSON.stringify(frame)}\n`)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        socket.off("drain", done);
        socket.off("close", done);
        resolve();
      };
      socket.once("drain", done);
      socket.once("close", done);
    });
  };
  const finish = (frame: Record<string, unknown>) => {
    if (done) return;
    done = true;
    send(frame);
    socket.end();
  };
  /** Input and signals waiting for `run` to listen. */
  const waiting: { data: Array<Buffer | null>; signals: CommandSignal[] } = {
    data: [],
    signals: [],
  };
  const deliver = (event: { data?: Buffer | null; signal?: CommandSignal }) => {
    if (event.signal) {
      if (signals.length === 0) waiting.signals.push(event.signal);
      for (const listener of signals) listener(event.signal);
    } else if (event.data !== undefined) {
      if (inputs.length === 0) waiting.data.push(event.data);
      for (const listener of inputs) listener(event.data);
    }
  };
  const line = (text: string) => {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    if (!session) {
      const request = parseRequest(frame);
      if (!request) {
        finish({ error: "Work could not read this command" });
        return;
      }
      session = {
        request,
        aborted: abort.signal,
        onInput: (listener) => {
          inputs.push(listener);
          for (const data of waiting.data.splice(0)) listener(data);
        },
        onSignal: (listener) => {
          signals.push(listener);
          for (const signal of waiting.signals.splice(0)) listener(signal);
        },
        stdout: async (data) => {
          for (let at = 0; at < data.length; at += OUTPUT_CHUNK_BYTES)
            await sendDrained({
              o: data.subarray(at, at + OUTPUT_CHUNK_BYTES).toString("base64"),
            });
        },
        stderr: async (data) => {
          for (let at = 0; at < data.length; at += OUTPUT_CHUNK_BYTES)
            await sendDrained({
              e: data.subarray(at, at + OUTPUT_CHUNK_BYTES).toString("base64"),
            });
        },
        returned: (files) =>
          send({
            r: Object.fromEntries(
              Object.entries(files).map(([file, content]) => [
                file,
                content.toString("base64"),
              ]),
            ),
          }),
        exit: (code) => finish({ x: code }),
        error: (message) => finish({ error: message }),
      };
      void args.run(session).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        args.log?.(`A separated command failed to run: ${message}`);
        finish({ error: `the command did not run: ${message}` });
      });
      return;
    }
    const input = Reflect.get(frame, "i");
    if (typeof input === "string")
      deliver({ data: Buffer.from(input, "base64") });
    else if (Reflect.get(frame, "eof") === true) deliver({ data: null });
    else {
      const signal = COMMAND_SIGNALS.find(
        (known) => known === Reflect.get(frame, "signal"),
      );
      if (signal) deliver({ signal });
    }
  };
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      const text = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + 1);
      if (text.trim()) line(text);
    }
    if (pending.length > (session ? MAX_LINE_BYTES : MAX_REQUEST_BYTES)) {
      finish({ error: "a line of this command was too long" });
      socket.destroy();
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    if (!done) abort.abort();
    done = true;
  });
}

/** A request as {@link CommandRequest} describes it, or nothing. */
export function parseRequest(frame: object): CommandRequest | undefined {
  const argv = Reflect.get(frame, "argv");
  const cwd = Reflect.get(frame, "cwd");
  const env = Reflect.get(frame, "env");
  const returns = Reflect.get(frame, "returns") ?? [];
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > 4096 ||
    !argv.every((part) => typeof part === "string" && !part.includes("\0")) ||
    // Only what a shim stands for: the harness's shell and Git.
    !COMMAND_PROGRAMS.some((program) => program === argv[0])
  )
    return undefined;
  if (
    typeof cwd !== "string" ||
    !path.posix.isAbsolute(cwd) ||
    cwd.includes("\0")
  )
    return undefined;
  if (typeof env !== "object" || env === null || Array.isArray(env))
    return undefined;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (typeof value === "string" && !value.includes("\0"))
      values[name] = value;
  if (!Array.isArray(returns)) return undefined;
  const files = returns
    .filter(
      (file): file is string =>
        typeof file === "string" &&
        path.posix.isAbsolute(file) &&
        COMMAND_RETURN_NAME.test(path.posix.basename(file)) &&
        !file.split("/").includes("..") &&
        !file.includes("\0"),
    )
    .slice(0, COMMAND_RETURN_LIMIT.files);
  // Every returned file sits in one folder, the shim's.
  const folders = new Set(files.map((file) => path.posix.dirname(file)));
  if (folders.size > 1) return undefined;
  return {
    argv: argv.map(String),
    cwd,
    env: commandEnvironment(values),
    returns: files,
  };
}
