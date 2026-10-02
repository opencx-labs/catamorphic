import { randomUUID } from "node:crypto";
import {
  encodeLine,
  framePayload,
  type HarnessAdapter,
  parseFrame,
  type RunnerCommandFrame,
  type RunnerFrame,
  splitLines,
} from "@catamorphic/agent-protocol/runner";
import {
  AGENT_RUNNER_VERSION,
  InProcessRunner,
} from "@catamorphic/agent-runner";
import { loadRunnerBundle } from "@catamorphic/runner-bundle";
import type { SandboxProvider } from "@catamorphic/sandbox";

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
  /** Where the next read starts: never past an incomplete line. */
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

let bundle: Promise<{ source: string; hash: string }> | undefined;

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
  const { source, hash } = await bundle;
  const directory = `${input.stateDirectory}/runner`;
  const present = await input.provider
    .executeCommand(
      input.sandboxId,
      `test -f ${shellQuote(`runner/${hash}.mjs`)} && echo present`,
      { cwd: input.stateDirectory },
    )
    .then(
      (result) => result.result.includes("present"),
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
  return {
    location,
    send: async (frames) => {
      if (frames.length === 0) return;
      await processes.writeProcessInput({
        sandboxId: location.sandboxId,
        processId: location.processId,
        data: frames.map((frame) => encodeLine(frame)).join(""),
      });
    },
    read: async ({ cursor, waitMs }) => {
      const output = await processes.readProcessOutput({
        sandboxId: location.sandboxId,
        processId: location.processId,
        cursor,
        // Frames stay below this (the runner bounds them), so a read always
        // holds at least one whole line.
        maxBytes: 1024 * 1024,
        waitMs: Math.min(waitMs, 20_000),
      });
      const split = splitLines(output.chunk);
      const frames: RunnerFrame[] = [];
      const diagnostics: string[] = [];
      for (const line of split.lines) {
        const payload = framePayload(line);
        if (payload === undefined) {
          if (line.trim()) diagnostics.push(line);
          continue;
        }
        try {
          frames.push(parseFrame(payload));
        } catch {
          diagnostics.push(line);
        }
      }
      // An incomplete last line is read again with the next chunk.
      const next = output.nextCursor - Buffer.byteLength(split.rest, "utf8");
      const exited =
        output.status === "exited" &&
        !output.more &&
        split.rest.length === 0 &&
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
