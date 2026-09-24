import type { BackgroundCommandView } from "../shared/background-commands.js";
import type { AgentTerminals } from "./terminal.js";

export type { BackgroundCommandView };

/**
 * Background commands (ADR 0155): long-running processes an agent starts
 * and keeps working beside. Each runs in its own agent terminal, so the
 * person can open it and watch; it outlives the turn that started it; and
 * it wakes the agent's chat when it finishes (or prints a line the agent
 * asked to hear about), for every harness alike.
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
  /** Reads in progress: the agent is watching, so nothing needs waking. */
  reading: number;
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
}

/** Wakes a chat with a message about one of its commands. */
export type BackgroundNotifier = (input: {
  projectId: string;
  sessionId: string;
  /** What the agent reads. */
  content: string;
  /** What the person sees in the chat, in plain words. */
  notice: string;
  idempotencyKey: string;
  /**
   * `message_only` records the news without starting a turn: the agent
   * heard about this command moments ago and will read it next turn.
   */
  mode?: "next_turn" | "message_only";
}) => Promise<void>;

/** The model reads at most this much in one wake message. */
const WAKE_OUTPUT_TAIL = 3_000;
/** Output matches wake the chat at most this often per command. */
const OUTPUT_WAKE_INTERVAL_MS = 15_000;
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
    let wakeOnOutput: RegExp | null = null;
    if (input.wakeOnOutput) {
      try {
        wakeOnOutput = new RegExp(input.wakeOnOutput, "m");
      } catch (error) {
        throw new Error(
          `wake_on_output is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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
      reading: 0,
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
   * command finishes or prints something new, whichever comes first.
   */
  async read(input: {
    sessionId: string;
    id: string;
    waitMs?: number;
  }): Promise<{
    status: BackgroundCommandView["status"];
    exitCode: number | null;
    output: string;
  }> {
    const tracked = this.owned(input.sessionId, input.id);
    const deadline =
      Date.now() + Math.min(Math.max(input.waitMs ?? 0, 0), READ_MAX_WAIT_MS);
    tracked.reading++;
    try {
      while (
        Date.now() < deadline &&
        tracked.status === "running" &&
        (this.deps.terminals.bufferLength(tracked.id) ?? 0) <=
          tracked.readOffset
      ) {
        await sleep(250);
        this.observe(tracked, { wake: false });
      }
      // The agent is watching: an end it sees here needs no wake message.
      this.observe(tracked, { wake: false });
      return {
        status: tracked.status,
        exitCode: tracked.exitCode,
        output: this.takeOutput(tracked),
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
    if (tracked.status === "running") {
      const { terminals } = this.deps;
      terminals.writeAny(tracked.id, "\u0003");
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && terminals.isBusy(tracked.id)) {
        await sleep(100);
      }
      const output = this.takeOutput(tracked);
      terminals.kill(tracked.id);
      tracked.status = "stopped";
      tracked.endedAt = Date.now();
      this.changed();
      return { status: tracked.status, output };
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

  /** Advance one command: detect its end and watched output, and wake its chat. */
  private observe(tracked: Tracked, opts: { wake: boolean }): void {
    if (tracked.status !== "running") return;
    const { terminals } = this.deps;
    if (tracked.wakeOnOutput && opts.wake) this.scanOutput(tracked);
    const shellExit = terminals.isRunning(tracked.id)
      ? undefined
      : terminals.exitCode(tracked.id);
    if (!terminals.isRunning(tracked.id) && shellExit === undefined) {
      // The person closed its terminal (or the chat was archived).
      tracked.status = "stopped";
      tracked.endedAt = Date.now();
      this.changed();
      if (opts.wake)
        this.wake(tracked, {
          key: "closed",
          notice: `${tracked.description} was stopped`,
          content: `Background command ${tracked.id} (${tracked.description}) was stopped: its terminal was closed.`,
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
    tracked.status = "finished";
    tracked.exitCode = exitCode;
    tracked.endedAt = Date.now();
    this.changed();
    if (opts.wake && tracked.wakeOnExit) {
      const tail = this.deps
        .modelOutput(
          terminals.readFrom(tracked.id, tracked.startOffset, RAW_READ_CAP),
        )
        .slice(-WAKE_OUTPUT_TAIL);
      const outcome =
        exitCode === null
          ? "finished"
          : exitCode === 0
            ? "finished successfully"
            : `failed with exit code ${exitCode}`;
      this.wake(tracked, {
        key: "exit",
        // Just woken by its output: the end is news, not a new errand.
        quiet: Date.now() - tracked.lastOutputWake < OUTPUT_WAKE_INTERVAL_MS,
        notice:
          exitCode && exitCode !== 0
            ? `${tracked.description} failed (exit ${exitCode})`
            : `${tracked.description} finished`,
        content: [
          `Background command ${tracked.id} (${tracked.description}) ${outcome}.`,
          `Command: ${tracked.command}`,
          tail ? `Last output:\n${tail}` : "It printed nothing.",
        ].join("\n"),
      });
    }
  }

  private wake(
    tracked: Tracked,
    message: { key: string; notice: string; content: string; quiet?: boolean },
  ): void {
    // An archived chat no longer takes messages; its command ended with it.
    this.notify?.({
      projectId: tracked.projectId,
      sessionId: tracked.sessionId,
      idempotencyKey: `background:${tracked.id}:${message.key}`,
      notice: message.notice,
      content: message.content,
      ...(message.quiet ? { mode: "message_only" as const } : {}),
    }).catch(() => {});
  }

  private scanOutput(tracked: Tracked): void {
    const { terminals } = this.deps;
    const end = terminals.bufferLength(tracked.id) ?? 0;
    if (end <= tracked.scanOffset || !tracked.wakeOnOutput) return;
    if (Date.now() - tracked.lastOutputWake < OUTPUT_WAKE_INTERVAL_MS) return;
    const text = this.deps.modelOutput(
      terminals.readFrom(tracked.id, tracked.scanOffset, RAW_READ_CAP),
    );
    tracked.scanOffset = end;
    const lines = text
      .split("\n")
      .filter((line) => tracked.wakeOnOutput?.test(line));
    if (lines.length === 0) return;
    tracked.lastOutputWake = Date.now();
    this.wake(tracked, {
      key: `output:${end}`,
      notice: `${tracked.description} printed what you were waiting for`,
      content: [
        `Background command ${tracked.id} (${tracked.description}) printed output matching /${tracked.wakeOnOutput.source}/. It is still running.`,
        `Matching lines:\n${lines.slice(-20).join("\n")}`,
      ].join("\n"),
    });
  }

  private changed(): void {
    this.deps.changed(this.list());
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
