import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { type IPty, spawn as spawnPty } from "@lydell/node-pty";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type { ServerState } from "./ipc.js";

/**
 * PTY sessions for terminal tabs. The renderer runs the emulator
 * (ghostty-web, libghostty-vt compiled to WASM); this side owns the real
 * processes.
 *
 * Two owners exist: user sessions are bound to the window that created
 * them (output streams only there; the window closing reaps them), and
 * agent sessions belong to a project (output broadcasts to every window
 * so any renderer can attach a live view; they outlive windows and die
 * with the app or by agent request).
 *
 * Every session keeps a rolling output buffer so agents can read what a
 * terminal shows and renderers can replay history when attaching.
 */

const BUFFER_CAP = 200_000;

interface TerminalSession {
  pty: IPty;
  /** User sessions stream to their window; agent sessions broadcast. */
  sender: WebContents | null;
  buffer: string;
  running: boolean;
  /** The shell binary's name — the idle foreground process. */
  shellName: string;
  /** A foreground command is running (chip spinners, agent waits). */
  busy: boolean;
  /** Set for agent-owned sessions. */
  agent?: { projectId: string };
}

/** The user's login shell — terminals should feel like Terminal.app. */
function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/zsh";
}

/** Main-side handle the agent workspace bridge drives terminals with. */
export interface AgentTerminals {
  create(projectId: string): Promise<{ sessionId: string; cwd: string }>;
  /** Write to an agent-owned session only (the default input path). */
  write(sessionId: string, data: string): boolean;
  /**
   * Write to ANY running session, including user terminals — the bridge
   * uses it for agent-targeted runs, after the control handoff marks the
   * terminal agent-controlled.
   */
  writeAny(sessionId: string, data: string): boolean;
  /** Rolling buffer tail (most recent `maxChars`). */
  read(sessionId: string, maxChars?: number): string | null;
  /** Total buffered length — baseline for "output since" reads. */
  bufferLength(sessionId: string): number | null;
  /** Buffer content from `offset`, capped to `maxChars`. */
  readFrom(sessionId: string, offset: number, maxChars?: number): string;
  isRunning(sessionId: string): boolean;
  /** A foreground command is running (vs. the shell idling). */
  isBusy(sessionId: string): boolean;
  /** Whether the session is agent-owned (vs. a user's terminal tab). */
  isAgentOwned(sessionId: string): boolean;
  kill(sessionId: string): boolean;
}

export function registerTerminalSupport(state: ServerState): {
  dispose(): void;
  agentTerminals: AgentTerminals;
} {
  const sessions = new Map<string, TerminalSession>();

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };

  const emit = (
    session: TerminalSession,
    channel: string,
    payload: unknown,
  ) => {
    if (session.sender) {
      if (!session.sender.isDestroyed()) session.sender.send(channel, payload);
    } else {
      broadcast(channel, payload);
    }
  };

  const reapFor = (sender: WebContents) => {
    for (const [id, session] of sessions) {
      if (session.sender === sender) {
        sessions.delete(id);
        session.pty.kill();
      }
    }
  };

  const spawnSession = async (input: {
    projectId?: string;
    cols?: number;
    rows?: number;
    sender: WebContents | null;
    agent?: { projectId: string };
  }): Promise<{ sessionId: string; cwd: string }> => {
    const rootPath = input.projectId
      ? await state.current?.projectRoots.get(input.projectId)
      : null;
    const cwd = rootPath ?? os.homedir();
    const shell = defaultShell();
    const pty = spawnPty(
      shell,
      // A login shell, like Terminal.app — the user's PATH and prompt
      // come from their profile, not from how Electron was launched.
      process.platform === "win32" ? [] : ["-l"],
      {
        name: "xterm-256color",
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      },
    );
    const sessionId = crypto.randomUUID();
    const session: TerminalSession = {
      pty,
      sender: input.sender,
      buffer: "",
      running: true,
      shellName: path.basename(shell),
      busy: false,
      agent: input.agent,
    };
    sessions.set(sessionId, session);

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_CAP);
      emit(session, "catamorphic:terminal-data", { sessionId, data });
    });
    pty.onExit(({ exitCode }) => {
      session.running = false;
      if (!sessions.has(sessionId)) return;
      emit(session, "catamorphic:terminal-exit", { sessionId, exitCode });
      // Agent sessions stay readable (buffer) until explicitly killed or
      // the app quits; user sessions are done once their tab reacts.
      if (!session.agent) sessions.delete(sessionId);
    });
    if (input.sender) {
      // A closed window can't kill its tabs' sessions itself.
      input.sender.once("destroyed", () =>
        reapFor(input.sender as WebContents),
      );
    }
    return { sessionId, cwd };
  };

  ipcMain.handle(
    "catamorphic:terminal-create",
    (event, input: { projectId?: string; cols?: number; rows?: number }) =>
      spawnSession({ ...input, sender: event.sender }),
  );

  ipcMain.handle(
    "catamorphic:terminal-write",
    (_event, sessionId: string, data: string) => {
      const session = sessions.get(sessionId);
      if (session?.running) session.pty.write(data);
    },
  );

  ipcMain.handle(
    "catamorphic:terminal-resize",
    (_event, sessionId: string, cols: number, rows: number) => {
      const session = sessions.get(sessionId);
      if (session?.running && cols > 0 && rows > 0) {
        session.pty.resize(cols, rows);
      }
    },
  );

  ipcMain.handle("catamorphic:terminal-kill", (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.running) session.pty.kill();
  });

  /** Replay history when a renderer attaches to a live (agent) session. */
  ipcMain.handle("catamorphic:terminal-buffer", (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session
      ? { buffer: session.buffer, running: session.running }
      : null;
  });

  /**
   * Busy tracking: a session is busy while its foreground process is not
   * the shell itself — node-pty's `process` reports the tty's foreground
   * process name. Polled (the pty has no event for it); changes are
   * pushed to renderers so chip spinners track the COMMAND, not the
   * shell's lifetime.
   */
  const computeBusy = (session: TerminalSession): boolean => {
    if (!session.running) return false;
    try {
      const foreground = path.basename(session.pty.process || "");
      return foreground !== "" && foreground !== session.shellName;
    } catch {
      return false;
    }
  };
  const busyPoll = setInterval(() => {
    for (const [sessionId, session] of sessions) {
      const busy = computeBusy(session);
      if (busy !== session.busy) {
        session.busy = busy;
        emit(session, "catamorphic:terminal-busy", { sessionId, busy });
      }
    }
  }, 500);

  const agentTerminals: AgentTerminals = {
    create: (projectId) =>
      spawnSession({
        projectId,
        cols: 100,
        rows: 30,
        sender: null,
        agent: { projectId },
      }),
    write: (sessionId, data) => {
      const session = sessions.get(sessionId);
      if (!session?.agent || !session.running) return false;
      session.pty.write(data);
      return true;
    },
    writeAny: (sessionId, data) => {
      const session = sessions.get(sessionId);
      if (!session?.running) return false;
      session.pty.write(data);
      return true;
    },
    read: (sessionId, maxChars = 20_000) => {
      const session = sessions.get(sessionId);
      return session ? session.buffer.slice(-maxChars) : null;
    },
    bufferLength: (sessionId) => sessions.get(sessionId)?.buffer.length ?? null,
    readFrom: (sessionId, offset, maxChars = 20_000) => {
      const session = sessions.get(sessionId);
      if (!session) return "";
      // The rolling buffer may have shed its head since the offset was
      // taken; clamp into range, newest content wins.
      const start = Math.max(0, Math.min(offset, session.buffer.length));
      return session.buffer.slice(start).slice(-maxChars);
    },
    isRunning: (sessionId) => sessions.get(sessionId)?.running ?? false,
    isBusy: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return false;
      // Compute live (not the cached poll value): agents polling for
      // completion deserve sub-interval accuracy.
      return computeBusy(session);
    },
    isAgentOwned: (sessionId) => Boolean(sessions.get(sessionId)?.agent),
    kill: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session?.agent) return false;
      sessions.delete(sessionId);
      if (session.running) session.pty.kill();
      broadcast("catamorphic:terminal-exit", { sessionId, exitCode: 0 });
      return true;
    },
  };

  return {
    dispose() {
      clearInterval(busyPoll);
      for (const session of sessions.values()) {
        if (session.running) session.pty.kill();
      }
      sessions.clear();
    },
    agentTerminals,
  };
}
