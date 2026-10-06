import { randomUUID } from "node:crypto";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  PROCESS_READ_MAX_WAIT_MS,
  PROCESS_WRITE_MAX_BYTES,
  type ProcessOutput,
  type SandboxProcessProvider,
} from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "./agent-sessions-service.js";
import {
  parseTerminalPty,
  prepareTerminalCommand,
  removeTerminalCommand,
  resizeTerminalCommand,
  sessionDirectoryFromProject,
  terminalProcessCommand,
} from "./session-terminal-scripts.js";
import {
  markWorkspaceUsed,
  type SessionWorkspaceHandle,
  SessionWorkspaceUnavailableError,
} from "./session-workspace.js";

const tracer = getTracer("@catamorphic/core");

/**
 * A terminal ends this long after it is asked to, or is killed: util-linux
 * `script` outlives a TERM until killed.
 */
const CLOSE_GRACE_MS = 1_500;
const SIZE_LIMIT = 1_000;

/** A terminal just opened in a chat's workspace. */
export interface SessionTerminal {
  /** The terminal's process in the workspace's sandbox (ADR 0174). */
  terminalId: string;
  /**
   * Whether the shell runs on a pseudo-terminal. Without one (a sandbox
   * without `script`) it is an interactive shell on a pipe: line by line,
   * no full-screen programs, no resizing.
   */
  pty: boolean;
}

/** Output of a terminal from a cursor (UTF-8 text). */
export interface SessionTerminalOutput {
  data: string;
  /** Where `data` starts: past the cursor asked for when it fell inside a character. */
  cursor: number;
  /** The cursor the next read starts from. */
  nextCursor: number;
  /** More output already waits past `nextCursor`; read again at once. */
  more: boolean;
  /** The shell ended and everything it wrote has been read. */
  exited: boolean;
  exitCode: number | null;
}

/** No such terminal of this person in this chat's current workspace. */
export class SessionTerminalNotFoundError extends Error {
  constructor(message = "This terminal has ended.") {
    super(message);
    this.name = "SessionTerminalNotFoundError";
  }
}

interface TerminalInput {
  identity: Identity;
  projectId: string;
  sessionId: string;
  terminalId: string;
}

/**
 * Terminals in a chat's workspace (ADR 0208): a login shell on a
 * pseudo-terminal, started as one of the workspace's background processes
 * (ADR 0174) with the Environment's secrets loaded (ADR 0205). Output is
 * read by cursor with a wait; input and resizes are posted. A terminal is
 * its opener's alone, and it ends with the workspace. Every call is a
 * request on its own, so any replica serves any of them.
 */
export class SessionTerminalsService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      sessions: Pick<AgentSessionsService, "personWorkspace">;
    },
  ) {}

  /** Open a terminal, starting the chat's workspace when it is not running. */
  async open(input: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): Promise<SessionTerminal> {
    return withSpan(
      {
        tracer,
        name: "session.terminal.open",
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.session.id": input.sessionId,
        },
      },
      async (span) => {
        const workspace = await this.deps.sessions.personWorkspace({
          identity: input.identity,
          projectId: input.projectId,
          sessionId: input.sessionId,
          start: true,
        });
        // Used from now on, before the shell starts: the idle sweep never
        // gives the workspace back between the shell starting and its row.
        await markWorkspaceUsed({
          db: this.deps.db,
          sessionId: input.sessionId,
        });
        const processes = processesOf(workspace);
        const sessionFromProject = sessionDirectoryFromProject(workspace);
        const key = `term-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
        const prepared = await workspace.provider.executeCommand(
          workspace.sandboxId,
          prepareTerminalCommand({ sessionFromProject, key }),
          { cwd: workspace.projectDirectory, timeout: 30 },
        );
        if (prepared.exitCode !== 0)
          throw new Error(
            `Could not prepare the terminal: ${prepared.result.trim().slice(-500)}`,
          );
        const pty = parseTerminalPty(prepared.result);
        span.setAttribute("catamorphic.terminal.pty", pty);
        const started = await processes.startProcess({
          sandboxId: workspace.sandboxId,
          command: terminalProcessCommand({ sessionFromProject, key, pty }),
          cwd: workspace.projectDirectory,
          env: {
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            COLUMNS: String(terminalSize(input.cols)),
            LINES: String(terminalSize(input.rows)),
            // macOS's bash otherwise greets every shell with a notice.
            BASH_SILENCE_DEPRECATION_WARNING: "1",
          },
          name: "Terminal",
          stdin: true,
        });
        await this.deps.db.transaction().execute(async (trx) => {
          // Terminals of the chat's earlier workspaces ended with them.
          await trx
            .deleteFrom("session_terminals")
            .where("session_id", "=", input.sessionId)
            .where("sandbox_id", "!=", workspace.sandboxId)
            .execute();
          await trx
            .insertInto("session_terminals")
            .values({
              session_id: input.sessionId,
              process_id: started.processId,
              sandbox_id: workspace.sandboxId,
              terminal_key: key,
              external_user_id: input.identity.externalUserId,
              pty: pty !== "none",
            })
            .execute();
        });
        return { terminalId: started.processId, pty: pty !== "none" };
      },
    );
  }

  /**
   * Output from `cursor`. With `waitMs`, answers as soon as there is output
   * past the cursor or the shell ended, and at the latest after `waitMs`.
   */
  async read(
    input: TerminalInput & { cursor: number; waitMs?: number },
  ): Promise<SessionTerminalOutput> {
    return terminalSpan("read", input, async () => {
      const terminal = await this.terminal(input);
      const output: ProcessOutput = await ended(() =>
        terminal.processes.readProcessOutput({
          sandboxId: terminal.workspace.sandboxId,
          processId: input.terminalId,
          cursor: input.cursor,
          waitMs: Math.min(
            Math.max(0, input.waitMs ?? 0),
            PROCESS_READ_MAX_WAIT_MS,
          ),
        }),
      );
      const exited = output.status === "exited" && !output.more;
      return {
        data: output.chunk,
        cursor: output.cursor,
        nextCursor: output.nextCursor,
        more: output.more,
        exited,
        exitCode: exited ? output.exitCode : null,
      };
    });
  }

  /** Type into the terminal: keys, pastes, control characters. */
  async write(input: TerminalInput & { data: string }): Promise<void> {
    if (Buffer.byteLength(input.data, "utf8") > PROCESS_WRITE_MAX_BYTES)
      throw new RangeError(
        `A terminal input carries at most ${PROCESS_WRITE_MAX_BYTES} bytes`,
      );
    return terminalSpan("write", input, async () => {
      const terminal = await this.terminal(input);
      await ended(() =>
        terminal.processes.writeProcessInput({
          sandboxId: terminal.workspace.sandboxId,
          processId: input.terminalId,
          data: input.data,
        }),
      );
    });
  }

  /** Size the terminal's device; full-screen programs redraw. */
  async resize(
    input: TerminalInput & { cols: number; rows: number },
  ): Promise<void> {
    return terminalSpan("resize", input, async () => {
      const terminal = await this.terminal(input);
      if (!terminal.pty) return;
      await terminal.workspace.provider.executeCommand(
        terminal.workspace.sandboxId,
        resizeTerminalCommand({
          sessionFromProject: sessionDirectoryFromProject(terminal.workspace),
          key: terminal.key,
          cols: terminalSize(input.cols),
          rows: terminalSize(input.rows),
        }),
        { cwd: terminal.workspace.projectDirectory, timeout: 30 },
      );
    });
  }

  /** End the terminal: asked to stop, then killed after a short grace. */
  async close(input: TerminalInput): Promise<void> {
    return terminalSpan("close", input, async () => {
      const terminal = await this.terminal(input);
      const { processes, workspace } = terminal;
      const sandboxId = workspace.sandboxId;
      const processId = input.terminalId;
      try {
        const signalled = await processes.signalProcess({
          sandboxId,
          processId,
          signal: "SIGTERM",
        });
        let cursor = signalled.outputBytes;
        let running = signalled.status === "running";
        const deadline = Date.now() + CLOSE_GRACE_MS;
        while (running && Date.now() < deadline) {
          const read = await processes.readProcessOutput({
            sandboxId,
            processId,
            cursor,
            maxBytes: 64 * 1024,
            waitMs: Math.max(0, Math.min(1_000, deadline - Date.now())),
          });
          cursor = read.nextCursor;
          running = read.status === "running";
        }
        if (running)
          await processes.signalProcess({
            sandboxId,
            processId,
            signal: "SIGKILL",
          });
        await workspace.provider
          .executeCommand(
            sandboxId,
            removeTerminalCommand({
              sessionFromProject: sessionDirectoryFromProject(workspace),
              key: terminal.key,
            }),
            { cwd: workspace.projectDirectory, timeout: 30 },
          )
          .catch(() => undefined);
      } catch (error) {
        // A process the sandbox no longer knows has ended already.
        if (!isUnknownProcess(error)) throw error;
      }
      await this.deps.db
        .deleteFrom("session_terminals")
        .where("session_id", "=", input.sessionId)
        .where("process_id", "=", processId)
        .execute();
    });
  }

  /**
   * The caller's terminal in the chat's current workspace. Access is
   * checked again on every call, so a person who lost access to the chat
   * loses its terminals too.
   */
  private async terminal(input: TerminalInput): Promise<{
    workspace: SessionWorkspaceHandle;
    processes: SandboxProcessProvider;
    key: string;
    pty: boolean;
  }> {
    let workspace: SessionWorkspaceHandle;
    try {
      workspace = await this.deps.sessions.personWorkspace({
        identity: input.identity,
        projectId: input.projectId,
        sessionId: input.sessionId,
        start: false,
      });
    } catch (error) {
      if (
        error instanceof SessionWorkspaceUnavailableError &&
        (error.reason === "not_running" || error.reason === "closed")
      )
        throw new SessionTerminalNotFoundError(
          "This terminal ended with its chat's workspace.",
        );
      throw error;
    }
    const row = await this.deps.db
      .selectFrom("session_terminals")
      .select(["terminal_key", "pty"])
      .where("session_id", "=", input.sessionId)
      .where("process_id", "=", input.terminalId)
      .where("sandbox_id", "=", workspace.sandboxId)
      .where("external_user_id", "=", input.identity.externalUserId)
      .executeTakeFirst();
    if (!row) throw new SessionTerminalNotFoundError();
    // Typing, and watching output (a dev server's log), keep the workspace.
    await markWorkspaceUsed({ db: this.deps.db, sessionId: input.sessionId });
    return {
      workspace,
      processes: processesOf(workspace),
      key: row.terminal_key,
      pty: row.pty,
    };
  }
}

function terminalSpan<T>(
  operation: "read" | "write" | "resize" | "close",
  input: TerminalInput,
  work: () => Promise<T>,
): Promise<T> {
  return withSpan(
    {
      tracer,
      name: `session.terminal.${operation}`,
      attributes: {
        "catamorphic.project.id": input.projectId,
        "catamorphic.session.id": input.sessionId,
        "catamorphic.process.id": input.terminalId,
      },
    },
    work,
  );
}

function processesOf(
  workspace: SessionWorkspaceHandle,
): SandboxProcessProvider {
  const processes = workspace.provider.processes;
  if (!processes)
    throw new SessionWorkspaceUnavailableError(
      "unsupported",
      "This chat's machine does not run terminals.",
    );
  return processes;
}

/** A column or row count a terminal accepts. */
function terminalSize(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), SIZE_LIMIT)
    : 80;
}

function isUnknownProcess(error: unknown): boolean {
  return error instanceof Error && /Unknown process/.test(error.message);
}

/** A process the sandbox no longer knows is a terminal that ended. */
async function ended<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUnknownProcess(error)) throw new SessionTerminalNotFoundError();
    throw error;
  }
}
