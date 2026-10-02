import { randomUUID } from "node:crypto";
import {
  encodeLine,
  framePayload,
  type HarnessAdapter,
  parseFrame,
  RUNNER_LINE_MAX_BYTES,
  type RunnerCommandFrame,
  type RunnerFrame,
  splitLines,
} from "@catamorphic/agent-protocol/runner";
import {
  AGENT_RUNNER_VERSION,
  InProcessRunner,
} from "@catamorphic/agent-runner";
import { loadRunnerBundle } from "@catamorphic/runner-bundle";
import {
  PROCESS_READ_MAX_BYTES,
  PROCESS_READ_MAX_WAIT_MS,
  PROCESS_WRITE_MAX_BYTES,
  type ProcessOutput,
  type SandboxProvider,
} from "@catamorphic/sandbox";

/**
 * Where an attempt's runner is (ADR 0197), persisted on the attempt so any
 * replica can find it again. A sandbox runner is reattachable by whoever
 * holds the turn; an in-process runner only by the process that made it.
 */
export type RunnerLocation =
  | { kind: "in_process"; process: string; runnerId: string }
  | {
      kind: "sandbox_process";
      allocationId: string;
      sandboxId: string;
      processId: string;
    };

export interface RunnerRead {
  frames: RunnerFrame[];
  /** Lines that were not frames: what a harness printed, a crash trace. */
  diagnostics: string[];
  /**
   * Where the next read starts: never past an incomplete line, except one
   * already too long to be a frame, which is skipped.
   */
  cursor: number;
  /** The runner process is gone and everything it wrote was read. */
  exited: boolean;
}

export interface RunnerChannel {
  readonly location: RunnerLocation;
  send(frames: readonly RunnerCommandFrame[]): Promise<void>;
  /** Frames after `cursor`, waiting up to `waitMs` for the first. */
  read(input: { cursor: number; waitMs: number }): Promise<RunnerRead>;
  /** End the runner process (it should have exited already). */
  kill(): Promise<void>;
}

/**
 * This process's identity in in-process runner locations. Replica memory
 * (a): runners of turns this process claimed, rebuilt by no one; a turn
 * whose process died finds its runner missing and is recovered as lost.
 */
const PROCESS_INSTANCE = randomUUID();
// Replica memory (a): runners of turns this replica holds by lease; they stop with it, and another holder starts the attempt again.
const inProcessRunners = new Map<string, InProcessRunner>();

export function startInProcessRunner(input: {
  adapter: HarnessAdapter;
  local?: Record<string, unknown>;
}): RunnerChannel {
  const runnerId = randomUUID();
  const runner = new InProcessRunner({
    adapters: { [input.adapter.id]: input.adapter },
    version: AGENT_RUNNER_VERSION,
    ...(input.local ? { local: input.local } : {}),
  });
  inProcessRunners.set(runnerId, runner);
  void runner.done.then(() => {
    // Read-out keeps it a little while after exit; then it is gone.
    setTimeout(() => inProcessRunners.delete(runnerId), 60_000).unref?.();
  });
  return inProcessChannel(runnerId, runner);
}

function inProcessChannel(
  runnerId: string,
  runner: InProcessRunner,
): RunnerChannel {
  return {
    location: { kind: "in_process", process: PROCESS_INSTANCE, runnerId },
    send: async (frames) => {
      for (const frame of frames) runner.send(frame);
    },
    read: async ({ cursor, waitMs }) => {
      const frames = await runner.read({ afterSeq: cursor, waitMs });
      const last = frames.at(-1);
      return {
        frames,
        diagnostics: [],
        cursor: last ? last.seq : cursor,
        exited: runner.exited && frames.length === 0,
      };
    },
    kill: async () => {
      inProcessRunners.delete(runnerId);
      runner.kill();
    },
  };
}

/** Finds an in-process runner again, only within the process that made it. */
export function reattachInProcessRunner(
  location: Extract<RunnerLocation, { kind: "in_process" }>,
): RunnerChannel | undefined {
  if (location.process !== PROCESS_INSTANCE) return undefined;
  const runner = inProcessRunners.get(location.runnerId);
  return runner ? inProcessChannel(location.runnerId, runner) : undefined;
}

let bundle: ReturnType<typeof loadRunnerBundle> | undefined;

/**
 * Start the runner in a sandbox as a process with standard input (ADR
 * 0197). The bundle is uploaded once per sandbox, by content hash, so the
 * sandbox always runs the host's own runner. The process gets no
 * credential: the harness's own model access arrives with its attempt.
 */
export async function startSandboxRunner(input: {
  provider: SandboxProvider;
  allocationId: string;
  sandboxId: string;
  stateDirectory: string;
  env?: Record<string, string>;
}): Promise<RunnerChannel> {
  const processes = input.provider.processes;
  if (!processes)
    throw new Error(
      "This Environment's sandboxes cannot run processes, so they cannot run this agent's harness.",
    );
  bundle ??= loadRunnerBundle();
  const { source, hash, digest } = await bundle;
  const directory = `${input.stateDirectory}/runner`;
  // Its contents are checked, not its name: anything in the sandbox could
  // have replaced the file since it was uploaded.
  const relative = `runner/${hash}.mjs`;
  const present = await input.provider
    .executeCommand(
      input.sandboxId,
      `(sha256sum ${shellQuote(relative)} 2>/dev/null || shasum -a 256 ${shellQuote(relative)}) | cut -d ' ' -f 1`,
      { cwd: input.stateDirectory },
    )
    .then(
      (result) => result.exitCode === 0 && result.result.trim() === digest,
      () => false,
    );
  if (!present)
    await input.provider.uploadFiles(
      input.sandboxId,
      { [`${hash}.mjs`]: source },
      directory,
    );
  const started = await processes.startProcess({
    sandboxId: input.sandboxId,
    // Relative to its working directory: a provider maps only the cwd onto
    // its own filesystem, never paths inside a command.
    command: `runtime="$(command -v bun || command -v node)"; if [ -z "$runtime" ]; then echo "This sandbox has neither Bun nor Node to run the agent runner." >&2; exit 127; fi; exec "$runtime" ${shellQuote(`runner/${hash}.mjs`)}`,
    cwd: input.stateDirectory,
    ...(input.env ? { env: input.env } : {}),
    name: "Agent runner",
    stdin: true,
  });
  return sandboxChannel({
    provider: input.provider,
    location: {
      kind: "sandbox_process",
      allocationId: input.allocationId,
      sandboxId: input.sandboxId,
      processId: started.processId,
    },
  });
}

/** A sandbox runner, from its stored location, through the given provider. */
export function sandboxChannel(input: {
  provider: SandboxProvider;
  location: Extract<RunnerLocation, { kind: "sandbox_process" }>;
}): RunnerChannel {
  const { provider, location } = input;
  const processes = provider.processes;
  if (!processes) throw new Error("This sandbox cannot run processes");
  /**
   * A line longer than any frame, being skipped: where this channel's last
   * read left off inside it. Only such a line ever leaves a cursor mid-line;
   * a holder that reattaches there reads its tail as a diagnostic.
   */
  let skipping: { cursor: number; bytes: number } | undefined;
  /** Sends in order: one send may take several writes. */
  let sending: Promise<void> = Promise.resolve();
  return {
    location,
    send: (frames) => {
      if (frames.length === 0) return Promise.resolve();
      // The leading newline ends whatever a failed earlier send left half
      // written, so it never runs into this send's first command.
      const data = `\n${frames.map((frame) => encodeLine(frame)).join("")}`;
      const next = sending.then(async () => {
        for (const piece of utf8Pieces(data, WRITE_PIECE_BYTES))
          await processes.writeProcessInput({
            sandboxId: location.sandboxId,
            processId: location.processId,
            data: piece,
          });
      });
      sending = next.catch(() => {});
      return next;
    },
    read: async ({ cursor, waitMs }) => {
      const frames: RunnerFrame[] = [];
      const diagnostics: string[] = [];
      const take = (line: string) => {
        const payload = framePayload(line);
        if (payload === undefined) {
          if (line.trim()) diagnostics.push(diagnostic(line));
          return;
        }
        try {
          frames.push(parseFrame(payload));
        } catch {
          diagnostics.push(diagnostic(line));
        }
      };
      const deadline = Date.now() + Math.min(waitMs, PROCESS_READ_MAX_WAIT_MS);
      // Where the next page starts, and the incomplete line just before it:
      // a line longer than one page is read on across pages.
      let position = cursor;
      let partial: string[] = [];
      let partialBytes = 0;
      let skipped = skipping?.cursor === cursor ? skipping.bytes : undefined;
      let wait = Math.max(0, deadline - Date.now());
      let pages = 0;
      let output: ProcessOutput;
      for (;;) {
        output = await processes.readProcessOutput({
          sandboxId: location.sandboxId,
          processId: location.processId,
          cursor: position,
          maxBytes: PROCESS_READ_MAX_BYTES,
          waitMs: wait,
        });
        position = output.nextCursor;
        let text = output.chunk;
        if (skipped !== undefined) {
          const end = text.indexOf("\n");
          if (end < 0) {
            skipped += Buffer.byteLength(text, "utf8");
            text = "";
          } else {
            skipped += Buffer.byteLength(text.slice(0, end), "utf8");
            diagnostics.push(skippedLine(skipped));
            skipped = undefined;
            text = text.slice(end + 1);
          }
        }
        if (text) {
          const split = splitLines(text);
          const [first, ...lines] = split.lines;
          if (first !== undefined) {
            take(partial.join("") + first);
            partial = [];
            partialBytes = 0;
            for (const line of lines) take(line);
          }
          if (split.rest) {
            partial.push(split.rest);
            partialBytes += Buffer.byteLength(split.rest, "utf8");
          }
        }
        // No runner writes a line this long: it is skipped, not held.
        if (partialBytes > RUNNER_LINE_MAX_BYTES) {
          skipped = partialBytes;
          partial = [];
          partialBytes = 0;
        }
        if (output.status === "exited" && !output.more) {
          // The last line has no newline, and never will.
          if (skipped !== undefined) diagnostics.push(skippedLine(skipped));
          skipped = undefined;
          if (partialBytes > 0) take(partial.join(""));
          partial = [];
          partialBytes = 0;
          break;
        }
        const incomplete = partialBytes > 0 || skipped !== undefined;
        if (output.more) {
          // A skipped line is passed over a few pages per read at most.
          pages += 1;
          if (!incomplete || (skipped !== undefined && pages > SKIP_PAGES))
            break;
          wait = 0;
          continue;
        }
        // Nothing more yet: answer with what was read, or wait on for the
        // rest of a line rather than answer with nothing.
        if (frames.length > 0 || diagnostics.length > 0 || !incomplete) break;
        wait = deadline - Date.now();
        if (!output.chunk || wait <= 0) break;
      }
      skipping =
        skipped === undefined
          ? undefined
          : { cursor: position, bytes: skipped };
      // An incomplete line is read again from its start by the next read.
      const next = skipped === undefined ? position - partialBytes : position;
      const exited =
        output.status === "exited" &&
        !output.more &&
        next >= output.outputBytes;
      return { frames, diagnostics, cursor: next, exited };
    },
    kill: async () => {
      await processes
        .signalProcess({
          sandboxId: location.sandboxId,
          processId: location.processId,
          signal: "SIGTERM",
        })
        .catch(() => {});
    },
  };
}

/** Each input write stays well under what one write may carry. */
const WRITE_PIECE_BYTES = Math.floor(PROCESS_WRITE_MAX_BYTES / 2);
/** Pages one read passes over inside a skipped line before answering. */
const SKIP_PAGES = 8;
/** Characters of one diagnostic line kept for the log. */
const DIAGNOSTIC_CHARS = 4_000;

function diagnostic(line: string): string {
  return line.length > DIAGNOSTIC_CHARS
    ? `${line.slice(0, DIAGNOSTIC_CHARS)} [${line.length - DIAGNOSTIC_CHARS} more characters]`
    : line;
}

function skippedLine(bytes: number): string {
  return `[A ${bytes}-byte line of output, longer than any runner frame, was skipped]`;
}

/** `text` in pieces of at most `maxBytes` UTF-8 bytes, never inside a character. */
export function utf8Pieces(text: string, maxBytes: number): string[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return [text];
  const pieces: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    // Back up over continuation bytes to the start of a character.
    while (end > start + 1 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    pieces.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return pieces;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
