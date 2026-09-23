import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { BackgroundCommandView } from "../shared/background-commands.js";
import type { BackgroundNotifier } from "./background-commands.js";

/**
 * Command watches (ADR 0156): a check an agent asks this computer to repeat
 * until it succeeds, or to report whenever its output changes. The check
 * runs where the agent's own commands run (the chat's working directory,
 * the person's tools and network), so a command can watch a URL, a file,
 * a build or a deploy alike.
 *
 * Watches are durable. They are saved with the profile and resume when the
 * app starts. Checks missed while the computer slept or the app was closed
 * are not replayed: an overdue watch checks once, right away, against the
 * output it saw last, so a change that happened meanwhile is reported once.
 * A watch past its expiry ends with one message saying so.
 */
export interface CommandWatch {
  id: string;
  projectId: string;
  sessionId: string;
  command: string;
  description: string;
  workingDirectory?: string;
  everySeconds: number;
  until: "success" | "change";
  createdAt: number;
  expiresAt: number | null;
  /** When the next check is due. */
  dueAt: number;
  /** Digest of the last output seen, in change mode. */
  baseline: string | null;
  /** The last output seen, so a change message can show before and after. */
  lastOutput: string;
  checks: number;
}

export interface CheckResult {
  exitCode: number | null;
  output: string;
}

export interface CommandWatchesDeps {
  /** Run one check in the chat's working directory, bounded by `timeoutMs`. */
  run(input: {
    command: string;
    workingDirectory?: string;
    timeoutMs: number;
  }): Promise<CheckResult>;
  load(): Promise<CommandWatch[]>;
  save(watches: CommandWatch[]): Promise<void>;
  changed(): void;
  now?: () => number;
}

/** The shortest interval between checks. */
export const MIN_WATCH_SECONDS = 5;
/** Default interval between checks. */
const DEFAULT_WATCH_SECONDS = 30;
/** One check may run at most this long. */
const CHECK_TIMEOUT_MS = 60_000;
/** What a wake message quotes of a check's output. */
const OUTPUT_TAIL = 2_000;
/** Raw output one check keeps (its tail). */
const RAW_CHECK_CAP = 200_000;
/** Ended watches the chat still shows, so their steps settle. */
const ENDED_KEPT = 50;

interface Ended {
  view: BackgroundCommandView;
}

export class CommandWatches {
  private watches = new Map<string, CommandWatch>();
  private readonly ended: Ended[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly checking = new Set<string>();
  private notify?: BackgroundNotifier;
  private loaded?: Promise<void>;
  private saving = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: CommandWatchesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Late-bound like background commands; resumes saved watches. */
  setNotifier(notify: BackgroundNotifier): Promise<void> {
    this.notify = notify;
    return this.resume();
  }

  /** Load saved watches once and schedule them; overdue ones check now. */
  resume(): Promise<void> {
    this.loaded ??= this.deps
      .load()
      .catch(() => [])
      .then((saved) => {
        for (const watch of saved) {
          if (!this.watches.has(watch.id)) this.watches.set(watch.id, watch);
        }
        for (const watch of this.watches.values()) this.schedule(watch);
        this.deps.changed();
      });
    return this.loaded;
  }

  /**
   * Start watching. The first check runs now: in success mode a command
   * that already succeeds ends the watch at once; in change mode its output
   * becomes the baseline later checks compare against.
   */
  async start(input: {
    projectId: string;
    sessionId: string;
    command: string;
    description: string;
    workingDirectory?: string;
    everySeconds?: number;
    until: "success" | "change";
    expiresInSeconds?: number;
  }): Promise<{
    id: string;
    status: BackgroundCommandView["status"];
    exitCode: number | null;
    output: string;
    nextCheckInSeconds: number | null;
  }> {
    await this.resume();
    const command = input.command.trim();
    if (!command) throw new Error("Empty command.");
    const everySeconds = Math.max(
      MIN_WATCH_SECONDS,
      Math.round(input.everySeconds ?? DEFAULT_WATCH_SECONDS),
    );
    const now = this.now();
    const watch: CommandWatch = {
      id: `watch-${randomUUID()}`,
      projectId: input.projectId,
      sessionId: input.sessionId,
      command,
      description:
        input.description.replace(/\s+/g, " ").trim() ||
        command.replace(/\s+/g, " ").slice(0, 80),
      ...(input.workingDirectory
        ? { workingDirectory: input.workingDirectory }
        : {}),
      everySeconds,
      until: input.until,
      createdAt: now,
      expiresAt: input.expiresInSeconds
        ? now + input.expiresInSeconds * 1000
        : null,
      dueAt: now + everySeconds * 1000,
      baseline: null,
      lastOutput: "",
      checks: 0,
    };
    const first = await this.check(watch.command, watch.workingDirectory);
    watch.checks = 1;
    watch.lastOutput = first.output;
    if (watch.until === "success" && first.exitCode === 0) {
      // Already true: nothing to watch, and nothing to wake about later.
      this.end(watch, "finished", 0);
      return {
        id: watch.id,
        status: "finished",
        exitCode: 0,
        output: first.output,
        nextCheckInSeconds: null,
      };
    }
    watch.baseline = digest(first);
    this.watches.set(watch.id, watch);
    await this.persist();
    this.schedule(watch);
    this.deps.changed();
    return {
      id: watch.id,
      status: "running",
      exitCode: first.exitCode,
      output: first.output,
      nextCheckInSeconds: everySeconds,
    };
  }

  async stop(input: {
    sessionId: string;
    id: string;
  }): Promise<{ status: BackgroundCommandView["status"] }> {
    await this.resume();
    const watch = this.watches.get(input.id);
    if (!watch || watch.sessionId !== input.sessionId) {
      const ended = this.ended.find(
        (entry) =>
          entry.view.id === input.id &&
          entry.view.sessionId === input.sessionId,
      );
      if (ended) return { status: ended.view.status };
      throw new Error(`No watch '${input.id}' in this chat.`);
    }
    this.end(watch, "stopped", null);
    await this.persist();
    return { status: "stopped" };
  }

  /** Archive ends a chat's watches along with its processes. */
  async stopForSessions(projectId: string, sessionIds: readonly string[]) {
    await this.resume();
    const ids = new Set(sessionIds);
    let stopped = 0;
    for (const watch of [...this.watches.values()]) {
      if (watch.projectId !== projectId || !ids.has(watch.sessionId)) continue;
      this.end(watch, "stopped", null);
      stopped++;
    }
    if (stopped) await this.persist();
    return stopped;
  }

  count(projectId: string, sessionIds: readonly string[]): number {
    const ids = new Set(sessionIds);
    return [...this.watches.values()].filter(
      (watch) => watch.projectId === projectId && ids.has(watch.sessionId),
    ).length;
  }

  /** Live and recently ended watches, shaped like background commands. */
  list(filter?: {
    projectId?: string;
    sessionId?: string;
  }): BackgroundCommandView[] {
    return [
      ...this.ended.map((entry) => entry.view),
      ...[...this.watches.values()].map((watch) =>
        view(watch, "running", null),
      ),
    ].filter(
      (item) =>
        (!filter?.projectId || item.projectId === filter.projectId) &&
        (!filter?.sessionId || item.sessionId === filter.sessionId),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(watch: CommandWatch): void {
    if (this.disposed) return;
    const existing = this.timers.get(watch.id);
    if (existing) clearTimeout(existing);
    const at = Math.min(
      watch.dueAt,
      watch.expiresAt ?? Number.POSITIVE_INFINITY,
    );
    const timer = setTimeout(
      () => void this.tick(watch.id),
      Math.max(0, at - this.now()),
    );
    timer.unref?.();
    this.timers.set(watch.id, timer);
  }

  /** One due check. Missed checks collapse into this one. */
  private async tick(id: string): Promise<void> {
    this.timers.delete(id);
    const watch = this.watches.get(id);
    if (!watch || this.checking.has(id) || this.disposed) return;
    const now = this.now();
    if (watch.expiresAt !== null && now >= watch.expiresAt) {
      this.end(watch, "stopped", null);
      await this.persist();
      await this.wake(watch, {
        key: "expired",
        notice: `Stopped watching: ${watch.description}`,
        content: [
          `Watch ${watch.id} (${watch.description}) expired after ${watch.checks} check${watch.checks === 1 ? "" : "s"} without ${watch.until === "success" ? "succeeding" : "a change"}.`,
          `Command: ${watch.command}`,
          watch.lastOutput
            ? `Last output:\n${tail(watch.lastOutput)}`
            : "It printed nothing.",
        ].join("\n"),
      });
      return;
    }
    this.checking.add(id);
    let result: CheckResult;
    try {
      result = await this.check(watch.command, watch.workingDirectory);
    } finally {
      this.checking.delete(id);
    }
    // Stopped or archived while the check ran.
    if (!this.watches.has(id)) return;
    watch.checks++;
    const previous = watch.lastOutput;
    watch.lastOutput = result.output;
    // The next check is an interval from now, never a backlog.
    watch.dueAt = this.now() + watch.everySeconds * 1000;
    if (watch.until === "success" && result.exitCode === 0) {
      this.end(watch, "finished", 0);
      await this.persist();
      await this.wake(watch, {
        key: "success",
        notice: `${watch.description}: done`,
        content: [
          `Watch ${watch.id} (${watch.description}) succeeded on check ${watch.checks}. It has stopped.`,
          `Command: ${watch.command}`,
          result.output
            ? `Output:\n${tail(result.output)}`
            : "It printed nothing.",
        ].join("\n"),
      });
      return;
    }
    if (watch.until === "change") {
      const next = digest(result);
      if (next !== watch.baseline) {
        watch.baseline = next;
        await this.persist();
        this.schedule(watch);
        await this.wake(watch, {
          key: `change:${next}:${watch.checks}`,
          notice: `${watch.description}: changed`,
          content: [
            `Watch ${watch.id} (${watch.description}) saw its output change on check ${watch.checks}. It keeps watching; stop it with stop_background_command when you no longer need it.`,
            `Command: ${watch.command}`,
            `Before:\n${tail(previous) || "(nothing)"}`,
            `Now${result.exitCode ? ` (exit ${result.exitCode})` : ""}:\n${tail(result.output) || "(nothing)"}`,
          ].join("\n"),
        });
        return;
      }
    }
    await this.persist();
    this.schedule(watch);
  }

  private async check(
    command: string,
    workingDirectory: string | undefined,
  ): Promise<CheckResult> {
    try {
      return await this.deps.run({
        command,
        ...(workingDirectory ? { workingDirectory } : {}),
        timeoutMs: CHECK_TIMEOUT_MS,
      });
    } catch (error) {
      return {
        exitCode: null,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private end(
    watch: CommandWatch,
    status: "finished" | "stopped",
    exitCode: number | null,
  ): void {
    this.watches.delete(watch.id);
    const timer = this.timers.get(watch.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(watch.id);
    this.ended.push({ view: view(watch, status, exitCode, this.now()) });
    if (this.ended.length > ENDED_KEPT) this.ended.shift();
    this.deps.changed();
  }

  private async wake(
    watch: CommandWatch,
    message: { key: string; notice: string; content: string },
  ): Promise<void> {
    try {
      await this.notify?.({
        projectId: watch.projectId,
        sessionId: watch.sessionId,
        idempotencyKey: `watch:${watch.id}:${message.key}`,
        notice: message.notice,
        content: message.content,
      });
    } catch {
      // The chat is gone or archived: nobody is left to tell.
      if (this.watches.has(watch.id)) {
        this.end(watch, "stopped", null);
        await this.persist();
      }
    }
  }

  private persist(): Promise<void> {
    const snapshot = [...this.watches.values()];
    this.saving = this.saving
      .then(() => this.deps.save(snapshot))
      .catch((error) => {
        console.warn("[desktop] Saving command watches failed", error);
      });
    return this.saving;
  }
}

function view(
  watch: CommandWatch,
  status: BackgroundCommandView["status"],
  exitCode: number | null,
  endedAt: number | null = null,
): BackgroundCommandView {
  return {
    id: watch.id,
    kind: "watch",
    projectId: watch.projectId,
    sessionId: watch.sessionId,
    command: watch.command,
    description: watch.description,
    key: null,
    status,
    exitCode,
    startedAt: watch.createdAt,
    endedAt,
  };
}

/** Output and exit status, so a check that starts failing is a change too. */
function digest(result: CheckResult): string {
  return createHash("sha256")
    .update(`${result.exitCode ?? "none"}\n${result.output}`)
    .digest("hex");
}

function tail(output: string): string {
  return output.length > OUTPUT_TAIL
    ? `…${output.slice(-OUTPUT_TAIL)}`
    : output;
}

/** A saved watch as the profile file holds it; anything else is dropped. */
export function isCommandWatch(value: unknown): value is CommandWatch {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "projectId" in value &&
    typeof value.projectId === "string" &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "command" in value &&
    typeof value.command === "string" &&
    "description" in value &&
    typeof value.description === "string" &&
    "everySeconds" in value &&
    typeof value.everySeconds === "number" &&
    "until" in value &&
    (value.until === "success" || value.until === "change") &&
    "dueAt" in value &&
    typeof value.dueAt === "number" &&
    "lastOutput" in value &&
    typeof value.lastOutput === "string"
  );
}

/**
 * Run a check in a login shell (the person's PATH and tools), killing its
 * whole process group if it outlives `timeoutMs`.
 */
export function runShellCheck(input: {
  command: string;
  workingDirectory?: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  shell?: string;
}): Promise<{ exitCode: number | null; raw: string }> {
  return new Promise((resolve) => {
    const shell = input.shell ?? process.env.SHELL ?? "/bin/zsh";
    const child = spawn(shell, ["-lc", input.command], {
      ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
      env: input.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let raw = "";
    const collect = (chunk: Buffer) => {
      raw = (raw + chunk.toString("utf8")).slice(-RAW_CHECK_CAP);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, input.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, raw: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        raw: timedOut
          ? `${raw}\n(check timed out after ${Math.round(input.timeoutMs / 1000)}s)`
          : raw,
      });
    });
  });
}
