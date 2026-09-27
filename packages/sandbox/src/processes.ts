import type { ExecOpts, ExecResult } from "./types.js";

/**
 * Background processes as a sandbox capability (ADR 0174). A process
 * belongs to its sandbox and dies with it. Its combined stdout and stderr
 * stay inside the sandbox, addressed by byte cursors, so every operation is
 * a short request and response: callers follow a process by reading from
 * the cursor the previous read returned. No streaming transport is needed,
 * which is what lets a remote worker's lease-fenced queue (ADR 0164) carry
 * them unchanged.
 */
export interface SandboxProcessProvider {
  startProcess(args: StartProcessArgs): Promise<SandboxProcess>;
  /**
   * Output from `cursor` (default 0). With `waitMs`, answers as soon as
   * there is output past the cursor or the process has exited, and at the
   * latest after `waitMs` (capped at {@link PROCESS_READ_MAX_WAIT_MS}).
   */
  readProcessOutput(args: ReadProcessOutputArgs): Promise<ProcessOutput>;
  /** Signals the process's whole group, so everything it started stops too. */
  signalProcess(args: SignalProcessArgs): Promise<SandboxProcess>;
  listProcesses(args: { sandboxId: string }): Promise<SandboxProcess[]>;
  /**
   * Write to the standard input of a process started with `stdin: true`
   * (ADR 0180), in order; `end` closes it after `data`. How a harness CLI
   * speaking a stdio protocol runs inside a sandbox: every write is one
   * short operation, like a read.
   */
  writeProcessInput(args: WriteProcessInputArgs): Promise<void>;
}

export interface WriteProcessInputArgs {
  sandboxId: string;
  processId: string;
  /** UTF-8 text appended to the process's input. */
  data: string;
  /** Close the input after `data`: the process reads end of file. */
  end?: boolean;
}

/** Largest input one write carries: a write crosses queues and Postgres. */
export const PROCESS_WRITE_MAX_BYTES = 1024 * 1024;

export interface StartProcessArgs {
  sandboxId: string;
  /** A shell command line, run with bash. */
  command: string;
  /** Absolute sandbox path; the provider's workspace root by default. */
  cwd?: string;
  env?: Record<string, string>;
  /** A few human words for what it is ("Dev server"). */
  name?: string;
  /**
   * Keep standard input open for {@link SandboxProcessProvider.writeProcessInput}.
   * Without it the process reads end of file at once.
   */
  stdin?: boolean;
}

export interface ReadProcessOutputArgs {
  sandboxId: string;
  processId: string;
  /** Byte offset into the process's output; 0 by default. */
  cursor?: number;
  /** Most bytes one read returns; see {@link PROCESS_READ_MAX_BYTES}. */
  maxBytes?: number;
  waitMs?: number;
}

export const PROCESS_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
] as const;
export type ProcessSignal = (typeof PROCESS_SIGNALS)[number];

export interface SignalProcessArgs {
  sandboxId: string;
  processId: string;
  signal: ProcessSignal;
}

export type SandboxProcessStatus = "running" | "exited";

export interface SandboxProcess {
  processId: string;
  sandboxId: string;
  command: string;
  name?: string;
  cwd: string;
  status: SandboxProcessStatus;
  /** The command's exit code; null while running or when a signal ended it. */
  exitCode: number | null;
  /**
   * The signal that stopped it, when known: the last one sent through
   * {@link SandboxProcessProvider.signalProcess}, or one the provider saw
   * end it (a stopped sandbox).
   */
  signal: ProcessSignal | null;
  startedAt: string;
  endedAt: string | null;
  /** Output bytes written so far: the cursor a fully caught-up reader holds. */
  outputBytes: number;
}

export interface ProcessOutput {
  processId: string;
  /** UTF-8 text between `cursor` and `nextCursor`. */
  chunk: string;
  cursor: number;
  nextCursor: number;
  /** More output already waits past `nextCursor`; read again at once. */
  more: boolean;
  /** All output written so far, in bytes. */
  outputBytes: number;
  status: SandboxProcessStatus;
  exitCode: number | null;
  signal: ProcessSignal | null;
}

/** Default and largest bytes per read: a read crosses queues and Postgres. */
export const PROCESS_READ_DEFAULT_BYTES = 64 * 1024;
export const PROCESS_READ_MAX_BYTES = 1024 * 1024;
/** The longest one read blocks; followers read again for longer waits. */
export const PROCESS_READ_MAX_WAIT_MS = 20_000;

const PROCESS_ID = /^proc-[a-z0-9]{8,32}$/;

export function newProcessId(): string {
  return `proc-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Rejects ids that did not come from {@link newProcessId}. */
export function assertProcessId(processId: string): void {
  if (!PROCESS_ID.test(processId))
    throw new Error(`Unknown process '${processId}'`);
}

export function processReadBounds(args: ReadProcessOutputArgs): {
  cursor: number;
  maxBytes: number;
  waitMs: number;
} {
  const whole = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : fallback;
  return {
    cursor: whole(args.cursor, 0),
    maxBytes: Math.min(
      Math.max(whole(args.maxBytes, PROCESS_READ_DEFAULT_BYTES), 1),
      PROCESS_READ_MAX_BYTES,
    ),
    waitMs: Math.min(whole(args.waitMs, 0), PROCESS_READ_MAX_WAIT_MS),
  };
}

/**
 * Decode the longest valid UTF-8 prefix of `bytes`: a read that ends inside
 * a multi-byte character leaves it for the next read. At the true end of the
 * output (`final`), whatever remains decodes as is.
 */
export function decodeUtf8Prefix(
  bytes: Uint8Array,
  final: boolean,
): { text: string; bytes: number } {
  let end = bytes.length;
  if (!final) {
    // Walk back over at most three continuation bytes to the lead byte.
    for (let back = 1; back <= Math.min(4, bytes.length); back++) {
      const byte = bytes[bytes.length - back] ?? 0;
      if ((byte & 0xc0) === 0x80) continue;
      const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (length > back) end = bytes.length - back;
      break;
    }
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    bytes: end,
  };
}

/**
 * Keeps the start and the end of long output within `limit` characters:
 * errors usually sit at the end, and what a command printed first explains
 * what it was doing.
 */
export class OutputWindow {
  private head = "";
  private tail = "";
  private omitted = 0;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    const headLimit = Math.floor(this.limit / 3);
    const tailLimit = this.limit - headLimit;
    if (this.head.length < headLimit) {
      const room = headLimit - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    this.tail += text;
    if (this.tail.length > tailLimit) {
      this.omitted += this.tail.length - tailLimit;
      this.tail = this.tail.slice(-tailLimit);
    }
  }

  toString(): string {
    return this.omitted > 0
      ? `${this.head}\n[… ${this.omitted} characters omitted …]\n${this.tail}`
      : `${this.head}${this.tail}`;
  }
}

export interface FollowProcessResult {
  output: string;
  /** Where the next read starts. */
  cursor: number;
  status: SandboxProcessStatus;
  exitCode: number | null;
  signal: ProcessSignal | null;
  /** The first complete output line that matched `until`. */
  matched?: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Follow a process from `cursor` until it exits, until a complete output
 * line matches `until` (`"output"` stops at any new output), until
 * `timeoutMs` passes, or until `signal` aborts. Only reads; stopping the
 * process is the caller's decision.
 */
export async function followProcess(args: {
  processes: Pick<SandboxProcessProvider, "readProcessOutput">;
  sandboxId: string;
  processId: string;
  cursor: number;
  timeoutMs: number;
  until?: RegExp | "output";
  signal?: AbortSignal;
  /** Characters of output kept (start and end); 30 000 by default. */
  outputLimit?: number;
  /** The longest one read blocks, so an abort is noticed this quickly. */
  pollMs?: number;
  /**
   * Output further behind than this (bytes) is skipped, not read: a
   * follower catching up on hours of server logs reads their end.
   */
  backlogBytes?: number;
}): Promise<FollowProcessResult> {
  const deadline = Date.now() + Math.max(0, args.timeoutMs);
  const output = new OutputWindow(args.outputLimit ?? 30_000);
  const pollMs = Math.min(args.pollMs ?? 5_000, PROCESS_READ_MAX_WAIT_MS);
  const backlogBytes = args.backlogBytes ?? 1024 * 1024;
  let cursor = args.cursor;
  let partial = "";
  let matched: string | undefined;
  let sawOutput = false;
  const test = (line: string) => {
    if (matched !== undefined || !(args.until instanceof RegExp)) return;
    if (args.until.test(line)) matched = line;
  };
  for (;;) {
    const remaining = deadline - Date.now();
    const read = await args.processes.readProcessOutput({
      sandboxId: args.sandboxId,
      processId: args.processId,
      cursor,
      waitMs: args.signal?.aborted
        ? 0
        : Math.max(0, Math.min(remaining, pollMs)),
    });
    cursor = read.nextCursor;
    if (read.chunk) {
      output.append(read.chunk);
      const lines = (partial + read.chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) test(line);
    }
    const backlog = read.outputBytes - cursor;
    if (backlog > backlogBytes) {
      output.append(`\n[… ${backlog - backlogBytes} bytes skipped …]\n`);
      cursor = read.outputBytes - backlogBytes;
      partial = "";
    }
    const exited = read.status === "exited" && !read.more;
    if (exited && partial) test(partial);
    if (!read.chunk && !exited && !read.more && Date.now() < deadline) {
      // A withheld partial character reads as "new output" to the
      // provider; pause instead of spinning until the rest arrives.
      await sleep(Math.min(200, deadline - Date.now()));
    }
    if (read.chunk) sawOutput = true;
    // What already waits is read before answering: a caller gets all the
    // output up to now, not the first page of it.
    const done =
      exited ||
      (!read.more &&
        (matched !== undefined || (args.until === "output" && sawOutput)));
    const timedOut = !done && !read.more && Date.now() >= deadline;
    const aborted = !done && Boolean(args.signal?.aborted);
    if (done || timedOut || aborted) {
      return {
        output: output.toString(),
        cursor,
        status: read.status,
        exitCode: read.exitCode,
        signal: read.signal,
        ...(matched !== undefined ? { matched } : {}),
        timedOut,
        aborted,
      };
    }
  }
}

/**
 * {@link SandboxProcessProvider} for any sandbox that runs bash, built only
 * on `executeCommand`. Each process gets a state directory inside the
 * sandbox (its output, process group id, and exit code), so its state lives
 * and dies with the sandbox. The process runs in its own session and group
 * (`setsid`, or job control where `setsid` is missing) so it survives the
 * command that started it and a signal reaches everything it spawned. When
 * the command ends, whatever it left running in its group is stopped.
 */
export function shellSandboxProcesses(args: {
  executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult>;
  workspaceRoot: string;
  /** Absolute sandbox directory for process state. */
  stateDirectory?: string;
}): SandboxProcessProvider {
  const stateDirectory = args.stateDirectory ?? "/tmp/.catamorphic-processes";
  const directory = (processId: string) => {
    assertProcessId(processId);
    return `${stateDirectory}/${processId}`;
  };
  const run = async (
    sandboxId: string,
    script: string,
    timeoutSeconds = 30,
  ): Promise<string> => {
    const result = await args.executeCommand(sandboxId, script, {
      timeout: timeoutSeconds,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `Sandbox process operation failed (exit ${result.exitCode}): ${result.result.trim()}`,
      );
    return result.result;
  };
  const describe = async (
    sandboxId: string,
    processIds: readonly string[] | "all",
  ): Promise<SandboxProcess[]> => {
    const ids =
      processIds === "all"
        ? `for dir in ${quote(stateDirectory)}/proc-*; do [ -d "$dir" ] || continue; id=\${dir##*/}; state_line; done`
        : processIds
            .map((id) => `dir=${quote(directory(id))}; id=${id}; state_line`)
            .join("\n");
    const output = await run(sandboxId, `${STATE_FUNCTIONS}\n${ids}`);
    return output
      .split("\n")
      .filter((line) => line.startsWith("state\t"))
      .flatMap((line) => {
        const parsed = parseStateLine(line, sandboxId);
        return parsed ? [parsed.process] : [];
      });
  };
  const one = async (sandboxId: string, processId: string) => {
    const [found] = await describe(sandboxId, [processId]);
    if (!found) throw new Error(`Unknown process '${processId}'`);
    return found;
  };
  return {
    async startProcess(start) {
      const processId = newProcessId();
      const dir = directory(processId);
      const cwd = start.cwd ?? args.workspaceRoot;
      const meta = JSON.stringify({
        command: start.command,
        cwd,
        startedAt: new Date().toISOString(),
        ...(start.name ? { name: start.name } : {}),
      });
      // Input, when kept open, is a file the writes append to, followed
      // into a pipe by `tail -f`; stopping the follower is end of file.
      const input = start.stdin
        ? [
            'mkfifo "$D/stdin.pipe"',
            '(exec tail -c +1 -f "$D/input" > "$D/stdin.pipe") &',
            'printf %s "$!" > "$D/stdin.pid"',
            // Its end is expected: no job report in the output.
            "disown",
          ]
        : [];
      const runner = [
        'D="$(cd "$(dirname "$0")" && pwd)"',
        'exec > "$D/output" 2>&1 < /dev/null',
        // The script carries the env; nothing needs it once it runs.
        'rm -f "$0"',
        ...Object.entries(start.env ?? {}).map(([name, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error(`Invalid environment variable name '${name}'`);
          return `export ${name}=${quote(value)}`;
        }),
        ...input,
        `if cd ${quote(cwd)}; then bash -c ${quote(start.command)}${start.stdin ? ' < "$D/stdin.pipe"' : ""}; code=$?; else code=1; fi`,
        'date -u +%s > "$D/ended"',
        'printf %s "$code" > "$D/exit"',
        // A finished command leaves nothing running behind it.
        "kill -KILL 0 2>/dev/null",
        "exit 0",
      ].join("\n");
      await run(
        start.sandboxId,
        [
          "set -e",
          `dir=${quote(dir)}`,
          'mkdir -p "$dir"',
          `printf %s ${quote(toBase64(meta))} | base64 -d > "$dir/meta.json"`,
          `printf %s ${quote(toBase64(runner))} | base64 -d > "$dir/run.sh"`,
          ': > "$dir/output"',
          ...(start.stdin ? [': > "$dir/input"'] : []),
          "set +e",
          "if command -v setsid >/dev/null 2>&1; then",
          '  setsid bash "$dir/run.sh" >/dev/null 2>&1 < /dev/null &',
          "else",
          "  set -m",
          '  bash "$dir/run.sh" >/dev/null 2>&1 < /dev/null &',
          "fi",
          'printf %s "$!" > "$dir/pid"',
        ].join("\n"),
      );
      return one(start.sandboxId, processId);
    },

    async readProcessOutput(read) {
      const bounds = processReadBounds(read);
      const dir = directory(read.processId);
      const waitSeconds = Math.ceil(bounds.waitMs / 1000);
      const output = await run(
        read.sandboxId,
        [
          STATE_FUNCTIONS,
          `dir=${quote(dir)}; id=${read.processId}`,
          '[ -f "$dir/pid" ] || { echo "Unknown process" >&2; exit 3; }',
          `deadline=$(( $(date +%s) + ${waitSeconds} ))`,
          "while :; do",
          // Exit before size: an exited process's output is complete.
          "  if ! alive; then break; fi",
          `  [ "$(size)" -gt ${bounds.cursor} ] && break`,
          '  [ "$(date +%s)" -ge "$deadline" ] && break',
          "  sleep 0.2",
          "done",
          "state_line",
          `printf 'chunk\\t'; tail -c +${bounds.cursor + 1} "$dir/output" | head -c ${bounds.maxBytes + 1} | base64 | tr -d '\\n'; printf '\\n'`,
        ].join("\n"),
        waitSeconds + 30,
      );
      const lines = output.split("\n");
      const stateLine = lines.find((line) => line.startsWith("state\t"));
      const chunkLine = lines.find((line) => line.startsWith("chunk\t"));
      const state = stateLine
        ? parseStateLine(stateLine, read.sandboxId)
        : undefined;
      if (!state || chunkLine === undefined)
        throw new Error(`Unknown process '${read.processId}'`);
      const raw = fromBase64(chunkLine.slice("chunk\t".length));
      const more = raw.length > bounds.maxBytes;
      // A cursor past the end reads nothing and resumes at the end.
      const cursor =
        raw.length > 0
          ? bounds.cursor
          : Math.min(bounds.cursor, state.sizeAtState);
      const decoded = decodeUtf8Prefix(
        raw.subarray(0, bounds.maxBytes),
        state.process.status === "exited" && !more,
      );
      return {
        processId: read.processId,
        chunk: decoded.text,
        cursor,
        nextCursor: cursor + decoded.bytes,
        more,
        outputBytes: Math.max(state.sizeAtState, cursor + raw.length),
        status: state.process.status,
        exitCode: state.process.exitCode,
        signal: state.process.signal,
      };
    },

    async signalProcess(request) {
      if (!PROCESS_SIGNALS.includes(request.signal))
        throw new Error(`Unsupported signal '${request.signal}'`);
      const dir = directory(request.processId);
      await run(
        request.sandboxId,
        [
          `dir=${quote(dir)}`,
          '[ -f "$dir/pid" ] || { echo "Unknown process" >&2; exit 3; }',
          'if [ ! -f "$dir/exit" ]; then',
          `  printf %s ${request.signal} > "$dir/signal"`,
          `  kill -s ${request.signal.slice(3)} -- "-$(cat "$dir/pid")" 2>/dev/null || true`,
          "fi",
        ].join("\n"),
      );
      return one(request.sandboxId, request.processId);
    },

    listProcesses: ({ sandboxId }) => describe(sandboxId, "all"),

    async writeProcessInput(write) {
      assertWriteSize(write.data);
      const dir = directory(write.processId);
      await run(
        write.sandboxId,
        [
          `dir=${quote(dir)}`,
          '[ -f "$dir/pid" ] || { echo "Unknown process" >&2; exit 3; }',
          '[ -f "$dir/input" ] || { echo "The process was started without input" >&2; exit 3; }',
          '[ -f "$dir/input.closed" ] && { echo "The process input is closed" >&2; exit 3; }',
          ...(write.data
            ? [
                `printf %s ${quote(toBase64(write.data))} | base64 -d >> "$dir/input"`,
              ]
            : []),
          ...(write.end
            ? [
                ': > "$dir/input.closed"',
                // `tail -f` polls once a second where inotify is missing:
                // give it that long to pass on the last write, then stop
                // it, which the process reads as end of file.
                'sleep 1; kill "$(cat "$dir/stdin.pid" 2>/dev/null || echo 0)" 2>/dev/null || true',
              ]
            : []),
        ].join("\n"),
      );
    },
  };
}

/** Refuses input larger than one write may carry. */
export function assertWriteSize(data: string): void {
  if (Buffer.byteLength(data, "utf8") > PROCESS_WRITE_MAX_BYTES)
    throw new Error(
      `A process input write carries at most ${PROCESS_WRITE_MAX_BYTES} bytes`,
    );
}

/**
 * Shell helpers shared by the state queries: whether the process group is
 * alive, its output size, and one tab-separated state line.
 */
const STATE_FUNCTIONS = [
  'alive() { [ -f "$dir/exit" ] && return 1; kill -0 -- "-$(cat "$dir/pid" 2>/dev/null || echo 0)" 2>/dev/null; }',
  'size() { if [ -f "$dir/output" ]; then echo $(( $(wc -c < "$dir/output") )); else echo 0; fi; }',
  "state_line() {",
  '  [ -f "$dir/pid" ] || return 0',
  "  if alive; then running=1; else running=0; fi",
  '  printf "state\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$id" "$running" "$(size)" "$(cat "$dir/exit" 2>/dev/null)" "$(cat "$dir/signal" 2>/dev/null)" "$(cat "$dir/ended" 2>/dev/null)" "$(base64 < "$dir/meta.json" | tr -d \'\\n\')"',
  "}",
].join("\n");

function parseStateLine(
  line: string,
  sandboxId: string,
): { process: SandboxProcess; sizeAtState: number } | undefined {
  const [, id, running, size, exit, signal, ended, meta] = line.split("\t");
  if (!id || !meta) return undefined;
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(fromBase64(meta)),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("command" in parsed) ||
    typeof parsed.command !== "string" ||
    !("cwd" in parsed) ||
    typeof parsed.cwd !== "string" ||
    !("startedAt" in parsed) ||
    typeof parsed.startedAt !== "string"
  )
    return undefined;
  const name =
    "name" in parsed && typeof parsed.name === "string"
      ? parsed.name
      : undefined;
  const exited = running !== "1";
  const exitCode = exit && /^\d+$/.test(exit) ? Number(exit) : null;
  const sentSignal = PROCESS_SIGNALS.find((known) => known === signal) ?? null;
  const endedAt =
    ended && /^\d+$/.test(ended)
      ? new Date(Number(ended) * 1000).toISOString()
      : null;
  const outputBytes = Number(size ?? 0) || 0;
  return {
    sizeAtState: outputBytes,
    process: {
      processId: id,
      sandboxId,
      command: parsed.command,
      ...(name ? { name } : {}),
      cwd: parsed.cwd,
      status: exited ? "exited" : "running",
      exitCode: exited ? exitCode : null,
      signal: sentSignal,
      startedAt: parsed.startedAt,
      endedAt: exited ? (endedAt ?? new Date().toISOString()) : null,
      outputBytes,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.trim(), "base64"));
}
