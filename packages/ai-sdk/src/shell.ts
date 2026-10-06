import crypto from "node:crypto";
import {
  type FollowProcessResult,
  followProcess,
  type SandboxProcessProvider,
  type SandboxProvider,
} from "@catamorphic/sandbox";
import { type Tool, tool } from "ai";
import { z } from "zod";

/** Foreground commands wait this long unless the agent asks for more. */
export const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
/**
 * The longest a foreground command may run when its Environment sets no
 * `commandTimeoutSeconds` budget (ADR 0174).
 */
export const SHELL_DEFAULT_BUDGET_SECONDS = 600;
/** Model-facing output budget: the start and the end of long output survive. */
export const SHELL_OUTPUT_LIMIT = 30_000;
/** How long starting a background command waits so quick failures show. */
const START_SETTLE_MS = 3_000;
/** How long a stopped command gets to exit before it is killed. */
const STOP_GRACE_MS = 2_000;

export type ShellProvider = Pick<SandboxProvider, "executeCommand"> &
  Partial<Pick<SandboxProvider, "processes">>;

/** Per-session shell state. */
export interface ShellState {
  /** The directory the last command left behind. */
  cwd?: string;
  /** This chat's background commands and where their next read starts. */
  background?: Map<string, { cursor: number }>;
}

/**
 * The lines that start a command from the project folder: load the
 * session's environment files (ADRs 0205, 0211) while still there, then
 * move to `cwd`. The command starts in the root already; a root only the
 * provider can map (a virtual `/workspace`) stays where the provider put
 * it.
 */
function commandPrelude(input: {
  root: string;
  cwd: string;
  envFiles?: readonly string[];
}): string[] {
  return [
    ...(input.envFiles ?? []).map(
      (file) => `if [ -f ${quote(file)} ]; then . ${quote(file)}; fi`,
    ),
    `cd ${quote(input.cwd)} 2>/dev/null || cd ${quote(input.root)} 2>/dev/null`,
  ];
}

/**
 * Run one foreground command the way a terminal user expects: in the
 * directory the previous command left (so `cd` persists between calls),
 * with stdout and stderr together, bounded in time, and cancellable. Where
 * the sandbox runs background processes, the command is one the shell waits
 * on (ADR 0174): no transport has to hold a request open for as long as it
 * runs, so the bound is the Environment's budget, not a queue's.
 */
export async function runShell(input: {
  provider: ShellProvider;
  sandboxId: string;
  /** The session's project folder: the starting directory and the fallback. */
  root: string;
  state: ShellState;
  command: string;
  timeoutMs?: number;
  /** The Environment's budget for one command; ten minutes by default. */
  budgetSeconds?: number;
  signal?: AbortSignal;
  /**
   * The session's environment files (ADRs 0205, 0211), from the project
   * folder or absolute: each loaded before the command when it exists.
   */
  envFiles?: readonly string[];
}): Promise<{ exitCode: number; output: string }> {
  const marker = `__catamorphic_cwd_${crypto.randomUUID().replaceAll("-", "")}__`;
  const cwd = input.state.cwd ?? input.root;
  const script = [
    ...commandPrelude({
      root: input.root,
      cwd,
      ...(input.envFiles ? { envFiles: input.envFiles } : {}),
    }),
    input.command,
    "__catamorphic_status=$?",
    `printf '\\n${marker}%s\\n' "$PWD"`,
    "exit $__catamorphic_status",
  ].join("\n");
  const budgetMs =
    (input.budgetSeconds ?? SHELL_DEFAULT_BUDGET_SECONDS) * 1_000;
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS, 1_000),
    budgetMs,
  );
  const processes = input.provider.processes;
  const result = processes
    ? await waitedCommand({
        processes,
        sandboxId: input.sandboxId,
        root: input.root,
        script,
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    : await input.provider
        .executeCommand(input.sandboxId, script, {
          cwd: input.root,
          timeout: Math.ceil(timeoutMs / 1000),
          ...(input.signal ? { signal: input.signal } : {}),
        })
        .then((executed) => ({
          exitCode: executed.exitCode,
          output: truncateOutput(executed.result),
          note: undefined,
        }));
  const at = result.output.lastIndexOf(marker);
  if (at !== -1) {
    const directory = result.output.slice(at + marker.length).split("\n", 1)[0];
    if (directory) input.state.cwd = directory;
  }
  const output = (
    at === -1 ? result.output : result.output.slice(0, at)
  ).replace(/\n+$/, "");
  return {
    exitCode: result.exitCode,
    output: result.note ? `${output}\n${result.note}`.trimStart() : output,
  };
}

/** A foreground command as a process the shell waits on (ADR 0174). */
async function waitedCommand(args: {
  processes: SandboxProcessProvider;
  sandboxId: string;
  root: string;
  script: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; output: string; note?: string }> {
  const started = await args.processes.startProcess({
    sandboxId: args.sandboxId,
    command: args.script,
    cwd: args.root,
  });
  const followed = await followProcess({
    processes: args.processes,
    sandboxId: args.sandboxId,
    processId: started.processId,
    cursor: 0,
    timeoutMs: args.timeoutMs,
    outputLimit: SHELL_OUTPUT_LIMIT,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!followed.timedOut && !followed.aborted)
    return { exitCode: followed.exitCode ?? 1, output: followed.output };
  // Out of time or cancelled: the command stops with everything it started.
  const stopped = await stopProcess({
    processes: args.processes,
    sandboxId: args.sandboxId,
    processId: started.processId,
    cursor: followed.cursor,
  }).catch(() => undefined);
  return {
    exitCode: followed.timedOut ? 124 : 130,
    output: followed.output + (stopped?.output ?? ""),
    note: followed.timedOut
      ? `Command timed out after ${Math.round(args.timeoutMs / 1000)}s and was stopped. Use run_background_command for longer work.`
      : "Command was cancelled.",
  };
}

/** Interrupt, give it a moment, then kill whatever remains of its group. */
async function stopProcess(args: {
  processes: SandboxProcessProvider;
  sandboxId: string;
  processId: string;
  cursor: number;
}): Promise<FollowProcessResult> {
  await args.processes.signalProcess({
    sandboxId: args.sandboxId,
    processId: args.processId,
    signal: "SIGTERM",
  });
  const settled = await followProcess({
    processes: args.processes,
    sandboxId: args.sandboxId,
    processId: args.processId,
    cursor: args.cursor,
    timeoutMs: STOP_GRACE_MS,
    outputLimit: SHELL_OUTPUT_LIMIT,
    pollMs: 500,
  });
  if (settled.status === "exited") return settled;
  await args.processes.signalProcess({
    sandboxId: args.sandboxId,
    processId: args.processId,
    signal: "SIGKILL",
  });
  const killed = await followProcess({
    processes: args.processes,
    sandboxId: args.sandboxId,
    processId: args.processId,
    cursor: settled.cursor,
    timeoutMs: STOP_GRACE_MS,
    outputLimit: SHELL_OUTPUT_LIMIT,
    pollMs: 500,
  });
  return { ...killed, output: settled.output + killed.output };
}

/** Keep the first and last parts of long output; errors usually sit at the end. */
export function truncateOutput(
  output: string,
  limit = SHELL_OUTPUT_LIMIT,
): string {
  if (output.length <= limit) return output;
  const head = Math.floor(limit / 3);
  const tail = limit - head;
  const omitted = output.length - head - tail;
  return `${output.slice(0, head)}\n[… ${omitted} characters omitted …]\n${output.slice(-tail)}`;
}

export interface ShellToolContext {
  provider: ShellProvider;
  sandboxId: string;
  /** The session's project folder, read at each call (checkouts move). */
  root(): string;
  state: ShellState;
  /** The Environment's budget for one foreground command, in seconds. */
  budgetSeconds?: number;
  /**
   * The session's environment files (ADRs 0205, 0211), from the project
   * folder or absolute: every command loads each that exists first.
   */
  envFiles?: readonly string[];
}

type BackgroundStatus = "running" | "finished" | "stopped";

function backgroundStatus(result: {
  status: "running" | "exited";
  signal: string | null;
}): BackgroundStatus {
  if (result.status === "running") return "running";
  return result.signal ? "stopped" : "finished";
}

/**
 * The shell tools of the built-in harness: `bash`, and where the sandbox
 * runs background processes, the background commands every Work harness
 * knows (ADR 0155): run_background_command, read_background_output and
 * stop_background_command. On the desktop the host supplies those as
 * workspace tools in visible terminals instead (ADR 0174).
 */
export function shellTools(context: ShellToolContext): Record<string, Tool> {
  const budgetSeconds = context.budgetSeconds ?? SHELL_DEFAULT_BUDGET_SECONDS;
  const budgetMs = budgetSeconds * 1_000;
  const processes = context.provider.processes;
  const bash = tool({
    description: `Run a shell command and wait for it to finish. The working directory persists between calls (a \`cd\` carries over); it starts in the project folder. Output combines stdout and stderr; long output keeps its start and end. Default timeout ${SHELL_DEFAULT_TIMEOUT_MS / 1000}s, at most ${budgetSeconds}s; a command that runs out of time is stopped. For servers, watchers and anything long-lived, use run_background_command instead${processes ? "" : " when it is available"}. Quote paths with spaces. Prefer read/edit/write for files.`,
    inputSchema: z.object({
      command: z.string().describe("The command to run"),
      description: z
        .string()
        .optional()
        .describe(
          "What this command does in 5-10 plain words, e.g. 'Run the test suite'. Shown to the person as what you're doing.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .max(budgetMs)
        .optional()
        .describe(`Milliseconds (max ${budgetMs})`),
    }),
    execute: async ({ command, timeout }, { abortSignal }) =>
      runShell({
        provider: context.provider,
        sandboxId: context.sandboxId,
        root: context.root(),
        state: context.state,
        command,
        budgetSeconds,
        ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
        ...(abortSignal ? { signal: abortSignal } : {}),
        ...(context.envFiles ? { envFiles: context.envFiles } : {}),
      }),
  });
  if (!processes) return { bash };

  const background = () => {
    context.state.background ??= new Map();
    return context.state.background;
  };
  const owned = (id: string) => {
    const entry = background().get(id);
    if (!entry)
      throw new Error(
        `No background command '${id}' in this chat. Start one with run_background_command.`,
      );
    return entry;
  };
  const report = (followed: FollowProcessResult) => ({
    status: backgroundStatus(followed),
    exitCode: followed.exitCode,
    output: followed.output,
  });

  return {
    bash,
    run_background_command: tool({
      description:
        "Start a long-running command (a dev server, a watcher, a slow build or test run, anything you would otherwise wait on) in the background and keep working. It runs in this chat's workspace, keeps running after this turn, and is stopped when the chat is closed. Returns its id, status, and first output (a quick failure shows up here). Follow it with read_background_output, which can wait for it to finish or print a line; end it with stop_background_command. Use bash for quick commands.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to run"),
        description: z
          .string()
          .describe(
            "What it does in 3-8 plain words, e.g. 'Start the dev server'. Shown to the person.",
          ),
      }),
      execute: async ({ command, description }, { abortSignal }) => {
        if (!command.trim()) throw new Error("Empty command.");
        const root = context.root();
        // Started in the project folder, so it loads the secrets from
        // there, then where the shell is.
        const started = await processes.startProcess({
          sandboxId: context.sandboxId,
          command: [
            ...commandPrelude({
              root,
              cwd: context.state.cwd ?? root,
              ...(context.envFiles ? { envFiles: context.envFiles } : {}),
            }),
            command,
          ].join("\n"),
          cwd: root,
          ...(description.trim() ? { name: description.trim() } : {}),
        });
        background().set(started.processId, { cursor: 0 });
        const settled = await followProcess({
          processes,
          sandboxId: context.sandboxId,
          processId: started.processId,
          cursor: 0,
          timeoutMs: START_SETTLE_MS,
          outputLimit: SHELL_OUTPUT_LIMIT,
          pollMs: 1_000,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        owned(started.processId).cursor = settled.cursor;
        return { id: started.processId, ...report(settled) };
      },
    }),
    read_background_output: tool({
      description: `Read a background command's output since your last read, with its status (running, finished, stopped) and exit code. Pass wait_seconds to block until it prints something new or finishes, when you have nothing else to do meanwhile. Add wait_for, a regular expression, to keep waiting until an output line matches (e.g. 'ready on|listening|error'); matched returns that line. Waits last at most ${budgetSeconds}s; wait again for work that takes longer.`,
      inputSchema: z.object({
        id: z.string().describe("The id run_background_command returned"),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(budgetSeconds)
          .optional()
          .describe("Block up to this long for new output or the end"),
        wait_for: z
          .string()
          .optional()
          .describe(
            "A regular expression; with wait_seconds, wait until an output line matches",
          ),
      }),
      execute: async ({ id, wait_seconds, wait_for }, { abortSignal }) => {
        const entry = owned(id);
        const until = wait_for ? pattern(wait_for) : "output";
        const followed = await followProcess({
          processes,
          sandboxId: context.sandboxId,
          processId: id,
          cursor: entry.cursor,
          timeoutMs: (wait_seconds ?? 0) * 1_000,
          until,
          outputLimit: SHELL_OUTPUT_LIMIT,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        entry.cursor = followed.cursor;
        return {
          ...report(followed),
          ...(followed.matched !== undefined
            ? { matched: followed.matched }
            : {}),
        };
      },
    }),
    stop_background_command: tool({
      description:
        "Stop a background command (interrupt, then kill whatever it left running) and return its last output.",
      inputSchema: z.object({
        id: z.string().describe("The id run_background_command returned"),
      }),
      execute: async ({ id }) => {
        const entry = owned(id);
        const stopped = await stopProcess({
          processes,
          sandboxId: context.sandboxId,
          processId: id,
          cursor: entry.cursor,
        });
        entry.cursor = stopped.cursor;
        return report(stopped);
      },
    }),
  };
}

/**
 * End every background command this chat still runs: a closed chat leaves
 * nothing behind, even before its sandbox is destroyed. Best effort.
 */
export async function stopBackgroundCommands(args: {
  provider: ShellProvider;
  sandboxId: string;
  state: ShellState;
}): Promise<void> {
  const processes = args.provider.processes;
  const ids = [...(args.state.background?.keys() ?? [])];
  args.state.background?.clear();
  if (!processes || ids.length === 0) return;
  await Promise.all(
    ids.map((processId) =>
      processes
        .signalProcess({
          sandboxId: args.sandboxId,
          processId,
          signal: "SIGKILL",
        })
        .catch(() => undefined),
    ),
  );
}

function pattern(source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(
      `wait_for is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
