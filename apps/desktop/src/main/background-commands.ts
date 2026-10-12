import type {
  NotifiedTask,
  TaskNotificationStatus,
} from "@catamorphic/agent-protocol";
import type { BackgroundCommandView } from "../shared/background-commands.js";
import type { AgentTerminals } from "./terminal.js";

export type { BackgroundCommandView };

/**
 * Background commands (ADR 0155): long-running processes an agent starts
 * and keeps working beside. Each runs in its own agent terminal, so the
 * person can open it and watch; it outlives the turn that started it; and
 * it wakes the agent's chat when it finishes (or prints a line the agent
 * asked to hear about), for every harness alike. Its terminal lives as
 * long as the command (ADR 0223): once it finishes or is stopped, the
 * shell ends, and the agent reads what it left from here.
 */
interface Tracked extends Omit<BackgroundCommandView, "kind" | "key"> {
  key: string;
  completionsBefore: number;
  promptsBefore: number;
  startOffset: number;
  /** Where the agent's next read starts. */
  readOffset: number;
  /** Where output matching resumes. */
  scanOffset: number;
  wakeOnExit: boolean;
  wakeOnOutput: RegExp | null;
  lastOutputWake: number;
  /**
   * Matching lines already reported, and when: printed again within a few
   * minutes (an error in a loop), they wake nobody.
   */
  reported: Map<string, number>;
  /** Reads in progress: the agent is watching, so nothing needs waking. */
  reading: number;
  /** Interrupted and ending: what the shell does meanwhile is not news. */
  stopping: boolean;
  /**
   * Once its terminal ended: the output the agent had not read yet, which
   * its next read returns (then nothing).
   */
  unread: string | null;
}

export interface BackgroundCommandsDeps {
  terminals: Pick<
    AgentTerminals,
    | "create"
    | "writeAny"
    | "isRunning"
    | "exitCode"
    | "isBusy"
    | "commandTracking"
    | "bufferLength"
    | "readFrom"
    | "kill"
  >;
  /** Show the terminal as a chip on the agent's chat; returns its tab key. */
  attach(input: {
    projectId: string;
    sessionId: string;
    terminalId: string;
    title: string;
  }): Promise<string>;
  /** Resolves once a fresh shell is ready to read input. */
  waitReady(terminalId: string): Promise<void>;
  /** Raw PTY text → what the model reads (sanitized, capped). */
  modelOutput(raw: string): string;
  /** Encode a command line for the PTY (bracketed paste for multi-line). */
  encode(command: string): string;
  changed(commands: BackgroundCommandView[]): void;
  pollMs?: number;
  /** How often output matches may wake a chat, per command. */
  outputWakeMs?: number;
}

/**
 * Tells a chat's agent about one of its commands: a task notification
 * (ADR 0217) that reaches its turn while it works, or wakes it.
 */
export type BackgroundNotifier = (input: {
  projectId: string;
  sessionId: string;
  task: NotifiedTask;
  /** One line for the person, and the head of what the agent reads. */
  summary: string;
  /** What the agent reads after the summary: output, what changed. */
  detail: string;
  /** The terminal tab the person opens from the notification, if any. */
  surfaceKey: string | null;
  idempotencyKey: string;
}) => Promise<void>;

/** The model reads at most this much in one wake message. */
const WAKE_OUTPUT_TAIL = 3_000;
/** Output matches wake the chat at most this often per command. */
const OUTPUT_WAKE_INTERVAL_MS = 15_000;
/** How many reported matching lines a command remembers. */
const REPORTED_LINES = 500;
/** How long a reported line stays old news. */
const REPORTED_FOR_MS = 5 * 60_000;
/** How long start waits so quick failures come back in the same call. */
const START_SETTLE_MS = 3_000;
/** The longest read_background_output blocks. */
const READ_MAX_WAIT_MS = 600_000;
/** Raw characters sliced before sanitizing. */
const RAW_READ_CAP = 150_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class BackgroundCommands {
  private readonly commands = new Map<string, Tracked>();
  private notify?: BackgroundNotifier;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: BackgroundCommandsDeps) {}

  /** Late-bound: the chat service exists only after the server boots. */
  setNotifier(notify: BackgroundNotifier): void {
    this.notify = notify;
  }

  async start(input: {
    projectId: string;
    sessionId: string;
    command: string;
    description: string;
    workingDirectory?: string;
    wakeOnExit?: boolean;
    wakeOnOutput?: string;
  }): Promise<{
    id: string;
    /** Open it for the person with open_surface. */
    key: string;
    status: BackgroundCommandView["status"];
    exitCode: number | null;
    output: string;
  }> {
    const command = input.command.trim();
    if (!command) throw new Error("Empty command.");
    const wakeOnOutput = input.wakeOnOutput
      ? outputPattern(input.wakeOnOutput, "wake_on_output")
      : null;
    const { terminals } = this.deps;
    const created = await terminals.create(
      input.projectId,
      input.sessionId,
      input.workingDirectory,
    );
    const id = created.sessionId;
    const description =
      input.description.replace(/\s+/g, " ").trim() ||
      command.replace(/\s+/g, " ").slice(0, 80);
    const key = await this.deps.attach({
      projectId: input.projectId,
      sessionId: input.sessionId,
      terminalId: id,
      title: description,
    });
    await this.deps.waitReady(id);
    const tracking = terminals.commandTracking(id);
    const offset = terminals.bufferLength(id) ?? 0;
    const tracked: Tracked = {
      id,
      projectId: input.projectId,
      sessionId: input.sessionId,
      command,
      description,
      key,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      completionsBefore: tracking?.completions ?? 0,
      promptsBefore: tracking?.prompts ?? 0,
      startOffset: offset,
      readOffset: offset,
      scanOffset: offset,
      wakeOnExit: input.wakeOnExit !== false,
      wakeOnOutput,
      lastOutputWake: 0,
      reported: new Map(),
      reading: 0,
      stopping: false,
      unread: null,
    };
    this.commands.set(id, tracked);
    terminals.writeAny(id, this.deps.encode(command));
    this.changed();
    this.ensurePolling();
    // Quick failures (a typo, a port in use) come back in this call.
    const settleDeadline = Date.now() + START_SETTLE_MS;
    while (Date.now() < settleDeadline && tracked.status === "running") {
      await sleep(100);
      this.observe(tracked, { wake: false });
    }
    return {
      id,
      key,
      status: tracked.status,
      exitCode: tracked.exitCode,
      output: this.takeOutput(tracked),
    };
  }

  /**
   * New output since the agent's last read. With `waitMs`, blocks until the
   * command finishes or prints something new, whichever comes first; with
   * `waitFor` too, until it prints a line matching that pattern (the same
   * contract as sandbox background commands, ADR 0174).
   */
  async read(input: {
    sessionId: string;
    id: string;
    waitMs?: number;
    waitFor?: string;
  }): Promise<{
    status: BackgroundCommandView["status"];
    exitCode: number | null;
    output: string;
    matched?: string;
  }> {
    const tracked = this.owned(input.sessionId, input.id);
    const waitFor = input.waitFor
      ? outputPattern(input.waitFor, "wait_for")
      : undefined;
    const deadline =
      Date.now() + Math.min(Math.max(input.waitMs ?? 0, 0), READ_MAX_WAIT_MS);
    const { terminals } = this.deps;
    let scanned = tracked.readOffset;
    let matched: string | undefined;
    const waiting = () => {
      if (tracked.status !== "running") return false;
      const end = terminals.bufferLength(tracked.id) ?? 0;
      if (end <= tracked.readOffset) return true;
      if (!waitFor) return false;
      if (end > scanned) {
        scanned = end;
        matched = this.deps
          .modelOutput(
            terminals.readFrom(tracked.id, tracked.readOffset, RAW_READ_CAP),
          )
          .split("\n")
          .find((line) => waitFor.test(line));
      }
      return matched === undefined;
    };
    tracked.reading++;
    try {
      while (Date.now() < deadline && waiting()) {
        await sleep(250);
        this.observe(tracked, { wake: false });
      }
      // The agent is watching: an end it sees here needs no wake message.
      this.observe(tracked, { wake: false });
      return {
        status: tracked.status,
        exitCode: tracked.exitCode,
        output: this.takeOutput(tracked),
        ...(matched !== undefined ? { matched } : {}),
      };
    } finally {
      tracked.reading--;
    }
  }

  /** Interrupt, then end the terminal: a stopped command leaves nothing running. */
  async stop(input: { sessionId: string; id: string }): Promise<{
    status: BackgroundCommandView["status"];
    output: string;
  }> {
    const tracked = this.owned(input.sessionId, input.id);
    if (tracked.status === "running" && !tracked.stopping) {
      const { terminals } = this.deps;
      // The interrupt ends the command: that is this stop, not its finish.
      tracked.stopping = true;
      terminals.writeAny(tracked.id, "\u0003");
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && terminals.isBusy(tracked.id)) {
        await sleep(100);
      }
      this.end(tracked, "stopped");
    }
    return { status: tracked.status, output: this.takeOutput(tracked) };
  }

  list(filter?: { projectId?: string; sessionId?: string }) {
    return [...this.commands.values()]
      .filter(
        (command) =>
          (!filter?.projectId || command.projectId === filter.projectId) &&
          (!filter?.sessionId || command.sessionId === filter.sessionId),
      )
      .map(view);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private owned(sessionId: string, id: string): Tracked {
    const tracked = this.commands.get(id);
    if (!tracked || tracked.sessionId !== sessionId) {
      throw new Error(
        `No background command '${id}' in this chat. Start one with run_background_command.`,
      );
    }
    return tracked;
  }

  private takeOutput(tracked: Tracked): string {
    // Its terminal is gone: what it left reads once.
    if (tracked.unread !== null) {
      const output = tracked.unread;
      tracked.unread = "";
      return output;
    }
    const raw = this.deps.terminals.readFrom(
      tracked.id,
      tracked.readOffset,
      RAW_READ_CAP,
    );
    tracked.readOffset = this.deps.terminals.bufferLength(tracked.id) ?? 0;
    // Output the agent has read needs no wake about a matching line.
    tracked.scanOffset = Math.max(tracked.scanOffset, tracked.readOffset);
    return this.deps.modelOutput(raw);
  }

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      let running = 0;
      for (const tracked of this.commands.values()) {
        if (tracked.status !== "running") continue;
        this.observe(tracked, { wake: tracked.reading === 0 });
        if (tracked.status === "running") running++;
      }
      if (running === 0) this.dispose();
    }, this.deps.pollMs ?? 500);
    this.timer.unref?.();
  }

  /**
   * The command is over: keep what the agent has not read yet, then end
   * its terminal. It is no longer running by then, so observe never reads
   * this kill as the person closing its terminal.
   */
  private end(tracked: Tracked, status: "finished" | "stopped"): void {
    tracked.unread = this.takeOutput(tracked);
    tracked.status = status;
    tracked.reported.clear();
    tracked.endedAt = Date.now();
    this.deps.terminals.kill(tracked.id);
    this.changed();
  }

  /** Advance one command: detect its end and watched output, and wake its chat. */
  private observe(tracked: Tracked, opts: { wake: boolean }): void {
    if (tracked.status !== "running" || tracked.stopping) return;
    const { terminals } = this.deps;
    if (tracked.wakeOnOutput && opts.wake) this.scanOutput(tracked);
    const shellExit = terminals.isRunning(tracked.id)
      ? undefined
      : terminals.exitCode(tracked.id);
    if (!terminals.isRunning(tracked.id) && shellExit === undefined) {
      // The person closed its terminal (or the chat was archived).
      this.end(tracked, "stopped");
      if (opts.wake)
        this.wake(tracked, {
          key: "closed",
          status: "stopped",
          summary: `${tracked.description} was stopped`,
          detail: `Its terminal was closed.\nCommand: ${tracked.command}`,
          // Its terminal is gone: there is nothing to open.
          surfaceKey: null,
        });
      return;
    }
    let finished = false;
    let exitCode: number | null = null;
    if (shellExit !== undefined) {
      // The command ended its own shell (`exit`): it finished, and the
      // shell's code is the command's.
      finished = true;
      exitCode = shellExit;
    } else {
      const tracking = terminals.commandTracking(tracked.id);
      if (tracking?.seen) {
        // A completion marker for this command is exact, exit code included.
        if (tracking.completions > tracked.completionsBefore) {
          finished = true;
          exitCode = tracking.lastExitCode;
        }
      } else {
        finished =
          Date.now() - tracked.startedAt > 1_200 &&
          !terminals.isBusy(tracked.id);
      }
    }
    if (!finished) return;
    const wake = opts.wake && tracked.wakeOnExit;
    // Read the wake's tail before ending the terminal takes it away.
    const tail = wake
      ? this.deps
          .modelOutput(
            terminals.readFrom(tracked.id, tracked.startOffset, RAW_READ_CAP),
          )
          .slice(-WAKE_OUTPUT_TAIL)
      : "";
    tracked.exitCode = exitCode;
    this.end(tracked, "finished");
    if (!wake) return;
    const failed = exitCode !== null && exitCode !== 0;
    this.wake(tracked, {
      key: "exit",
      status: failed ? "failed" : "completed",
      summary: failed
        ? `${tracked.description} failed (exit ${exitCode})`
        : `${tracked.description} finished`,
      detail: [
        `Command: ${tracked.command}`,
        tail ? `Last output:\n${tail}` : "It printed nothing.",
      ].join("\n"),
      // Its terminal ended with it: there is nothing to open.
      surfaceKey: null,
    });
  }

  private wake(
    tracked: Tracked,
    message: {
      key: string;
      status: TaskNotificationStatus;
      summary: string;
      detail: string;
      surfaceKey?: string | null;
    },
  ): void {
    // An archived chat no longer takes messages; its command ended with it.
    this.notify?.({
      projectId: tracked.projectId,
      sessionId: tracked.sessionId,
      task: {
        type: "background_command",
        id: tracked.id,
        title: tracked.description,
        status: message.status,
      },
      summary: message.summary,
      detail: message.detail,
      surfaceKey:
        message.surfaceKey === undefined ? tracked.key : message.surfaceKey,
      idempotencyKey: `background:${tracked.id}:${message.key}`,
    }).catch(() => {});
  }

  private scanOutput(tracked: Tracked): void {
    const { terminals } = this.deps;
    const end = terminals.bufferLength(tracked.id) ?? 0;
    if (end <= tracked.scanOffset || !tracked.wakeOnOutput) return;
    if (
      Date.now() - tracked.lastOutputWake <
      (this.deps.outputWakeMs ?? OUTPUT_WAKE_INTERVAL_MS)
    )
      return;
    // The read ends where the output does. Whole lines only: a line still
    // being printed is matched once it ends, never as a fragment.
    const raw = terminals.readFrom(
      tracked.id,
      tracked.scanOffset,
      RAW_READ_CAP,
    );
    const cut = raw.lastIndexOf("\n");
    if (cut < 0) return;
    tracked.scanOffset = end - (raw.length - cut - 1);
    const text = this.deps.modelOutput(raw.slice(0, cut + 1));
    // A line the agent heard about lately (an error printed in a loop) is
    // not news: only lines it has not seen wake the chat.
    const now = Date.now();
    for (const [line, at] of tracked.reported)
      if (now - at > REPORTED_FOR_MS) tracked.reported.delete(line);
    const lines = [
      ...new Set(
        text
          .split("\n")
          .filter((line) => tracked.wakeOnOutput?.test(line))
          .filter((line) => !tracked.reported.has(line.trim())),
      ),
    ];
    if (lines.length === 0) return;
    for (const line of lines.slice(-REPORTED_LINES)) {
      if (tracked.reported.size >= REPORTED_LINES) {
        const [oldest] = tracked.reported.keys();
        if (oldest !== undefined) tracked.reported.delete(oldest);
      }
      tracked.reported.set(line.trim(), now);
    }
    tracked.lastOutputWake = now;
    this.wake(tracked, {
      key: `output:${end}`,
      status: "update",
      summary: `${tracked.description} printed what you were waiting for`,
      detail: [
        `It printed lines matching /${tracked.wakeOnOutput.source}/ and is still running.`,
        `Matching lines:\n${lines.slice(-20).join("\n")}`,
      ].join("\n"),
    });
  }

  private changed(): void {
    this.deps.changed(this.list());
  }
}

function outputPattern(source: string, name: string): RegExp {
  try {
    return new RegExp(source, "m");
  } catch (error) {
    throw new Error(
      `${name} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function view(tracked: Tracked): BackgroundCommandView {
  return {
    id: tracked.id,
    kind: "command",
    projectId: tracked.projectId,
    sessionId: tracked.sessionId,
    command: tracked.command,
    description: tracked.description,
    key: tracked.key,
    status: tracked.status,
    exitCode: tracked.exitCode,
    startedAt: tracked.startedAt,
    endedAt: tracked.endedAt,
  };
}
