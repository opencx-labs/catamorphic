import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn as spawnPty } from "@lydell/node-pty";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type { TerminalCreateInput } from "../shared/terminal.js";
import { scanOsc133 } from "../shared/terminal-text.js";
import type { ServerState } from "./ipc.js";
import { registerProcessOwner } from "./process-owners.js";
import { openRemoteTerminal, type TerminalBackend } from "./remote-terminal.js";
import { shellBinShimDir, shellIntegration } from "./shell-integration.js";
import { readGhosttyAppearance } from "./terminal-appearance.js";
import { TerminalLifecycle } from "./terminal-lifecycle.js";

/**
 * PTY sessions for terminal tabs. The renderer runs the emulator
 * (ghostty-web, libghostty-vt compiled to WASM); this side owns the real
 * processes.
 *
 * Two owners exist: user sessions are bound to the window that created
 * them (output streams only there; the window closing reaps them), and
 * agent sessions belong to a project (output broadcasts to every window
 * so any renderer can attach a live view; they outlive windows and live
 * as long as their command, ADR 0223).
 *
 * Every session keeps a rolling output buffer so agents can read what a
 * terminal shows and renderers can replay history when attaching.
 */

const BUFFER_CAP = 200_000;

/** How long a shell whose project moved waits for its new window. */
const HANDOFF_MS = 30_000;

interface TerminalSession {
  /** A local PTY, or a shell in a remote chat's workspace (ADR 0209). */
  pty: TerminalBackend;
  releaseSender?: () => void;
  /** User sessions stream to their window; agent sessions broadcast. */
  sender: WebContents | null;
  /**
   * Rolling output, kept as chunks: appending must not copy the whole
   * cap on every PTY data event (a chatty build produces thousands of
   * chunks per second — `buffer + data` churned hundreds of MB/s).
   * Reads join lazily via bufferText(), which collapses to one chunk.
   */
  chunks: string[];
  chunksLength: number;
  /**
   * Characters shed from the head of the buffer so far: offsets handed to
   * agents count every character ever written, so "output since" reads
   * stay exact however much a chatty process prints.
   */
  shed: number;
  running: boolean;
  /** The shell's own exit code once it ended by itself (not killed). */
  exitCode?: number;
  /** The shell binary's name — the idle foreground process. */
  shellName: string;
  /** A foreground command is running (chip spinners, agent waits). */
  busy: boolean;
  /** The project this terminal belongs to; home terminals have none. */
  projectId?: string;
  /** Set for agent-owned sessions. */
  agent?: { projectId: string; sessionId: string };
  /**
   * Its project moved to another window: the shell waits there to be taken
   * over (`catamorphic:terminal-adopt`) and ends if it is not, in time.
   */
  transit?: ReturnType<typeof setTimeout>;
  /**
   * OSC 133 semantic-prompt state (agent sessions spawn with shell
   * integration; see shell-integration.ts). Once markers are `seen`,
   * busy/exit tracking switches from the foreground-process heuristic
   * to exact command boundaries.
   */
  integration: {
    seen: boolean;
    /** A command is running: `133;C` seen without its closing `133;D`. */
    active: boolean;
    /** Exit code of the most recently completed command. */
    lastExit: number | null;
    /** Completed-command count — lets callers detect "my command ended". */
    completions: number;
    /**
     * Every `133;D` (prompt shown), including ones with no preceding C —
     * a submitted line the shell consumed without running anything
     * (blank, comment-only) still comes back to a prompt.
     */
    prompts: number;
    /** Trailing fragment of a marker split across PTY data chunks. */
    carry: string;
  };
}

/** Exposed integration snapshot for the agent bridge. */
export interface CommandTracking {
  seen: boolean;
  completions: number;
  prompts: number;
  lastExitCode: number | null;
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
  create(
    projectId: string,
    ownerSessionId: string,
    workingDirectory?: string,
  ): Promise<{ sessionId: string; cwd: string }>;
  /** Write to an agent-owned session only (the default input path). */
  write(sessionId: string, data: string): boolean;
  /**
   * Write to ANY running session, including user terminals — the bridge
   * uses it for agent-targeted runs, after the control handoff marks the
   * terminal agent-controlled.
   */
  writeAny(sessionId: string, data: string): boolean;
  /** Rolling buffer tail (most recent `maxChars`), or an ended one's last. */
  read(sessionId: string, maxChars?: number): string | null;
  /** Characters written so far (absolute) — baseline for "output since" reads. */
  bufferLength(sessionId: string): number | null;
  /** Buffer content from `offset`, capped to `maxChars`. */
  readFrom(sessionId: string, offset: number, maxChars?: number): string;
  isRunning(sessionId: string): boolean;
  /**
   * The exit code of a shell that ended by itself (a command ran `exit`);
   * undefined while it runs, or once its terminal was closed or killed.
   */
  exitCode(sessionId: string): number | undefined;
  /** A foreground command is running (vs. the shell idling). */
  isBusy(sessionId: string): boolean;
  /**
   * Shell-integration snapshot: whether OSC 133 markers are live for the
   * session, how many commands have completed, and the last exit code.
   */
  commandTracking(sessionId: string): CommandTracking | null;
  /** Whether the session is agent-owned (vs. a user's terminal tab). */
  isAgentOwned(sessionId: string): boolean;
  countForOwners(projectId: string, ownerSessionIds: readonly string[]): number;
  killForOwners(projectId: string, ownerSessionIds: readonly string[]): number;
  kill(sessionId: string): boolean;
}

/**
 * Ended sessions' scrollback: Cmd+Shift+T restores a user terminal with it,
 * and a tab still open on an ended agent terminal keeps showing it.
 */
const MORGUE_CAP = 20;

export function registerTerminalSupport(
  state: ServerState,
  /**
   * Extra env for AGENT terminals, resolved at spawn (late-bound: the
   * agent bridge that provides it registers after terminal support).
   * Today: the `open`-shim hook URL + shim bin dir.
   */
  agentEnv?: (
    projectId: string,
  ) => Record<string, string> | Promise<Record<string, string>>,
  /** Whether `sender`'s window is the one `projectId` lives in now. */
  ownsProject?: (projectId: string, sender: WebContents) => boolean,
): {
  dispose(): Promise<void>;
  hasActiveWork(): boolean;
  agentTerminals: AgentTerminals;
  /**
   * `projectId` left `from` for a window of its own: its shells there
   * wait to be taken over, and end if nothing does within a while.
   */
  handOff(projectId: string, from: WebContents): void;
} {
  const sessions = new Map<string, TerminalSession>();
  const lifecycle = new TerminalLifecycle();

  const appendBuffer = (session: TerminalSession, data: string) => {
    session.chunks.push(data);
    session.chunksLength += data.length;
    // Shed whole head chunks once the cap is comfortably exceeded; a
    // single oversized chunk is trimmed in place.
    while (
      session.chunks.length > 1 &&
      session.chunksLength - (session.chunks[0]?.length ?? 0) >= BUFFER_CAP
    ) {
      const head = session.chunks.shift();
      session.chunksLength -= head?.length ?? 0;
      session.shed += head?.length ?? 0;
    }
    const only = session.chunks[0];
    if (session.chunks.length === 1 && only && only.length > BUFFER_CAP) {
      session.shed += only.length - BUFFER_CAP;
      session.chunks[0] = only.slice(-BUFFER_CAP);
      session.chunksLength = session.chunks[0].length;
    }
  };

  /** Join (and collapse — repeated reads stay cheap) the rolling buffer. */
  const bufferText = (session: TerminalSession): string => {
    if (session.chunks.length > 1) {
      const joined = session.chunks.join("");
      session.chunks = [joined];
      session.chunksLength = joined.length;
    }
    return session.chunks[0] ?? "";
  };

  // When a session ends (shell exit, tab close, its command over), its
  // buffer moves here: a reopened user tab replays the scrollback above
  // its fresh shell, and a view of an ended agent terminal (a tab that
  // remounts, or mounted late) still shows what it printed.
  // Insertion-ordered; oldest entries fall off past the cap.
  const morgue = new Map<string, string>();
  const bury = (sessionId: string, session: TerminalSession) => {
    if (session.chunksLength === 0) return;
    morgue.delete(sessionId);
    morgue.set(sessionId, bufferText(session));
    while (morgue.size > MORGUE_CAP) {
      const oldest = morgue.keys().next().value;
      if (oldest === undefined) break;
      morgue.delete(oldest);
    }
  };

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

  /**
   * Every way a session ends says so here (ADR 0223): no command runs in a
   * shell that is gone, so its chip stops spinning first, then its views
   * hear that it ended.
   */
  const announceEnd = (
    sessionId: string,
    session: TerminalSession,
    exit: { exitCode: number; message?: string },
  ) => {
    if (session.busy) {
      session.busy = false;
      emit(session, "catamorphic:terminal-busy", { sessionId, busy: false });
    }
    emit(session, "catamorphic:terminal-exit", { sessionId, ...exit });
  };

  /**
   * End a session for good: closed, killed, its window, its chat archived,
   * or its command over. The pty exit callback skips deleted sessions, so
   * a shell still running is announced here; one that exited by itself
   * was announced then.
   */
  const end = (sessionId: string, session: TerminalSession) => {
    clearTimeout(session.transit);
    session.transit = undefined;
    bury(sessionId, session);
    sessions.delete(sessionId);
    session.releaseSender?.();
    if (!session.running) return;
    session.pty.kill();
    announceEnd(sessionId, session, { exitCode: 0 });
  };

  const reapFor = (sender: WebContents) => {
    for (const [id, session] of sessions) {
      if (session.sender === sender) end(id, session);
    }
  };

  /**
   * A terminal in a remote chat's workspace (ADR 0209): the shell runs
   * there, so it has no local folder or shell integration.
   */
  const openRemoteSession = async (input: {
    projectId: string;
    chatSessionId: string;
    cols?: number;
    rows?: number;
    sender: WebContents;
  }): Promise<TerminalBackend> => {
    const request = state.current?.remoteTerminalRequest({
      projectId: input.projectId,
      sessionId: input.chatSessionId,
    });
    if (!request)
      throw new Error("This project has no server to open a terminal on");
    if (lifecycle.disposed)
      throw new Error("Terminal support is shutting down");
    return openRemoteTerminal({
      request,
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
    }).catch((error: unknown) => {
      // The tab writes the reason: a plain Error crosses IPC as its
      // words alone, without a class name in front.
      throw new Error(error instanceof Error ? error.message : String(error));
    });
  };

  const spawnSession = async (
    input: TerminalCreateInput & {
      workingDirectory?: string;
      sender: WebContents | null;
      agent?: { projectId: string; sessionId: string };
    },
  ): Promise<{ sessionId: string; cwd: string }> => {
    if (input.chat?.remote) {
      if (!input.projectId || !input.sender)
        throw new Error("A remote terminal belongs to a project's window");
      const backend = await openRemoteSession({
        projectId: input.projectId,
        chatSessionId: input.chat.sessionId,
        cols: input.cols,
        rows: input.rows,
        sender: input.sender,
      });
      // No project: this desktop's terminal triggers are about its own
      // shells, not ones on the server.
      return {
        sessionId: track({ pty: backend, shellName: "", sender: input.sender }),
        cwd: "",
      };
    }
    const rootPath = input.projectId
      ? await state.current?.projectRoots.get(input.projectId)
      : null;
    // Resolve the assignment when opening, never a renderer-supplied path or
    // a cached copy. A missing checkout must not silently open the project root.
    const chatDirectory = input.chat
      ? await state.current?.sessionCheckouts.resolve({
          projectId: input.projectId ?? "",
          sessionId: input.chat.sessionId,
        })
      : undefined;
    if (input.chat && !chatDirectory)
      throw new Error("This chat's working folder is unavailable.");
    const requestedDirectory = input.workingDirectory
      ? await fs.access(input.workingDirectory).then(
          () => input.workingDirectory,
          () => undefined,
        )
      : undefined;
    const cwd = chatDirectory ?? requestedDirectory ?? rootPath ?? os.homedir();
    const shell = defaultShell();
    // Agent terminals spawn with OSC 133 shell integration for exact
    // busy/exit tracking; user terminals stay exactly as the user's
    // dotfiles configure them (their sessions fall back to the
    // foreground-process heuristic when an agent borrows one).
    const integration = input.agent ? await shellIntegration(shell) : null;
    // The `open` shim (URLs land as in-app tabs) rides the same
    // agent-only integration: the zsh and bash hooks put CATAMORPHIC_BIN
    // first on PATH after the user's profiles ran.
    const shimBin = input.agent ? await shellBinShimDir() : null;
    const agentExtraEnv = input.agent
      ? ((await agentEnv?.(input.agent.projectId)) ?? {})
      : {};
    if (lifecycle.disposed)
      throw new Error("Terminal support is shutting down");
    const pty = spawnPty(
      shell,
      // A login shell, like Terminal.app — the user's PATH and prompt
      // come from their profile, not from how Electron was launched.
      // An integrated shell starts as its shim says (it reads the same
      // profile files).
      integration?.args ?? (process.platform === "win32" ? [] : ["-l"]),
      {
        name: "xterm-256color",
        cols: input.cols ?? 80,
        rows: input.rows ?? 24,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          ...integration?.env,
          ...(shimBin ? { CATAMORPHIC_BIN: shimBin } : {}),
          ...agentExtraEnv,
        },
      },
    );
    return {
      sessionId: track({
        pty,
        shellName: path.basename(shell),
        projectId: input.projectId ?? input.agent?.projectId,
        agent: input.agent,
        sender: input.sender,
      }),
      cwd,
    };
  };

  /** Follow a started terminal: buffer, markers, exit, its window. */
  const track = (input: {
    pty: TerminalBackend;
    shellName: string;
    projectId?: string;
    agent?: { projectId: string; sessionId: string };
    sender: WebContents | null;
  }): string => {
    const { pty } = input;
    lifecycle.track(pty);
    const sessionId = crypto.randomUUID();
    const session: TerminalSession = {
      pty,
      sender: input.sender,
      chunks: [],
      chunksLength: 0,
      shed: 0,
      running: true,
      shellName: input.shellName,
      busy: false,
      projectId: input.projectId,
      agent: input.agent,
      integration: {
        seen: false,
        active: false,
        lastExit: null,
        completions: 0,
        prompts: 0,
        carry: "",
      },
    };
    sessions.set(sessionId, session);
    // Resources credits the shell and what runs in it (ADR 0266): an
    // agent's terminal to its chat.
    const unregister = registerProcessOwner(
      pty.pid,
      input.agent
        ? {
            kind: "chat",
            sessionId: input.agent.sessionId,
            projectId: input.agent.projectId,
          }
        : { kind: "terminal", terminalId: sessionId, title: input.shellName },
    );

    pty.onData((data) => {
      appendBuffer(session, data);
      // Track OSC 133 markers on every session — agent terminals emit
      // them via the integration shim, and a user's own dotfiles may
      // emit them too (iTerm2/VS Code shell integration).
      const tracking = session.integration;
      tracking.carry = scanOsc133(tracking.carry + data, (marker) => {
        if (marker.kind === "C") {
          tracking.seen = true;
          tracking.active = true;
        } else if (marker.kind === "D") {
          tracking.seen = true;
          tracking.prompts += 1;
          // A D with no preceding C is a prompt with nothing run behind
          // it (startup, blank or comment-only line) — not a completion.
          if (tracking.active) {
            tracking.active = false;
            tracking.completions += 1;
            tracking.lastExit = marker.exitCode ?? null;
          }
        }
      });
      emit(session, "catamorphic:terminal-data", { sessionId, data });
    });
    pty.onExit(({ exitCode, message }) => {
      unregister();
      session.running = false;
      session.exitCode = exitCode;
      session.releaseSender?.();
      if (!sessions.has(sessionId)) return;
      announceEnd(sessionId, session, {
        exitCode,
        ...(message ? { message } : {}),
      });
      // An agent session stays until its background command reads the
      // exit code and ends it; user sessions are done once their tab
      // reacts — their scrollback moves to the morgue for Cmd+Shift+T.
      if (!session.agent) {
        bury(sessionId, session);
        sessions.delete(sessionId);
      }
    });
    if (input.sender) streamTo(session, input.sender);
    return sessionId;
  };

  /** A user session streams to its window, and ends should it close. */
  const streamTo = (session: TerminalSession, sender: WebContents) => {
    session.releaseSender?.();
    session.sender = sender;
    // A closed window can't kill its tabs' sessions itself.
    const onDestroyed = () => reapFor(sender);
    sender.once("destroyed", onDestroyed);
    session.releaseSender = () => {
      sender.removeListener("destroyed", onDestroyed);
      session.releaseSender = undefined;
    };
  };

  ipcMain.handle("catamorphic:terminal-ghostty-appearance", () =>
    readGhosttyAppearance(),
  );

  ipcMain.handle(
    "catamorphic:terminal-create",
    (event, input: TerminalCreateInput) =>
      spawnSession({
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.cols ? { cols: input.cols } : {}),
        ...(input.rows ? { rows: input.rows } : {}),
        ...(typeof input.chat?.sessionId === "string"
          ? {
              chat: {
                sessionId: input.chat.sessionId,
                remote: input.chat.remote === true,
              },
            }
          : {}),
        sender: event.sender,
      }),
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

  /**
   * A project moving to a window of its own takes its shells with it: the
   * new window's tab takes over a running one (renderer/lib/project-move.ts)
   * and gets what it printed so far. Only a shell handed off with its
   * project, and only by the window that project lives in now.
   */
  ipcMain.handle(
    "catamorphic:terminal-adopt",
    (event, sessionId: unknown, projectId: unknown) => {
      if (typeof sessionId !== "string" || typeof projectId !== "string")
        return null;
      const session = sessions.get(sessionId);
      if (
        !session?.running ||
        !session.transit ||
        session.projectId !== projectId ||
        !ownsProject?.(projectId, event.sender)
      )
        return null;
      clearTimeout(session.transit);
      session.transit = undefined;
      streamTo(session, event.sender);
      return { buffer: bufferText(session) };
    },
  );

  ipcMain.handle("catamorphic:terminal-kill", (_event, sessionId: string) => {
    // A kill from a live tab (Cmd+D) closes it through the exit event.
    // Unmount-triggered kills unsubscribed already; it is a no-op for them.
    const session = sessions.get(sessionId);
    if (session) end(sessionId, session);
  });

  /**
   * Scrollback of a CLOSED user session (Cmd+Shift+T): the reopened tab
   * replays it above the fresh shell. Not one-shot — StrictMode double
   * mounts would eat a one-shot read; the cap is the cleanup.
   */
  ipcMain.handle(
    "catamorphic:terminal-restore-buffer",
    (_event, sessionId: string) => {
      const buffer = morgue.get(sessionId);
      return buffer !== undefined ? { buffer } : null;
    },
  );

  /**
   * Replay history when a renderer attaches to an agent session: a live
   * one, or one that ended (its view keeps the final output).
   */
  ipcMain.handle("catamorphic:terminal-buffer", (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session)
      return { buffer: bufferText(session), running: session.running };
    const buffer = morgue.get(sessionId);
    return buffer !== undefined ? { buffer, running: false } : null;
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
    // Shell-integration markers are exact — they catch pure-shell work
    // (builtins, functions, loops) that never changes the tty's
    // foreground process, which the heuristic below misses entirely.
    if (session.integration.seen) return session.integration.active;
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
        // Busy → idle means a foreground command returned to the prompt —
        // the desktop's terminal trigger kind. Poll-rate quantized: bursts
        // of sub-500ms commands coalesce into one firing.
        if (!busy && session.running && session.projectId) {
          state.current?.triggers.onTerminalIdle(session.projectId, {
            sessionId,
            shell: session.shellName,
          });
        }
      }
    }
  }, 500);

  const agentTerminals: AgentTerminals = {
    create: (projectId, ownerSessionId, workingDirectory) =>
      spawnSession({
        projectId,
        workingDirectory,
        cols: 100,
        rows: 30,
        sender: null,
        agent: { projectId, sessionId: ownerSessionId },
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
      // An ended terminal's tab still shows its last output: so does this.
      const text = session ? bufferText(session) : morgue.get(sessionId);
      return text === undefined ? null : text.slice(-maxChars);
    },
    bufferLength: (sessionId) => {
      const session = sessions.get(sessionId);
      return session ? session.shed + session.chunksLength : null;
    },
    readFrom: (sessionId, offset, maxChars = 20_000) => {
      const session = sessions.get(sessionId);
      if (!session) return "";
      const text = bufferText(session);
      // Offsets are absolute; output shed since the offset was taken is
      // gone, so reading resumes at the oldest retained character.
      const start = Math.max(0, Math.min(offset - session.shed, text.length));
      return text.slice(start).slice(-maxChars);
    },
    isRunning: (sessionId) => sessions.get(sessionId)?.running ?? false,
    exitCode: (sessionId) => sessions.get(sessionId)?.exitCode,
    isBusy: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return false;
      // Compute live (not the cached poll value): agents polling for
      // completion deserve sub-interval accuracy.
      return computeBusy(session);
    },
    commandTracking: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return {
        seen: session.integration.seen,
        completions: session.integration.completions,
        prompts: session.integration.prompts,
        lastExitCode: session.integration.lastExit,
      };
    },
    isAgentOwned: (sessionId) => Boolean(sessions.get(sessionId)?.agent),
    countForOwners: (projectId, ownerSessionIds) => {
      const owners = new Set(ownerSessionIds);
      return [...sessions.values()].filter(
        (session) =>
          session.running &&
          session.agent?.projectId === projectId &&
          owners.has(session.agent.sessionId),
      ).length;
    },
    killForOwners: (projectId, ownerSessionIds) => {
      const owners = new Set(ownerSessionIds);
      const matches = [...sessions.entries()].filter(
        ([, session]) =>
          session.agent?.projectId === projectId &&
          owners.has(session.agent.sessionId),
      );
      for (const [sessionId, session] of matches) end(sessionId, session);
      return matches.length;
    },
    kill: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session?.agent) return false;
      end(sessionId, session);
      return true;
    },
  };

  return {
    // Work is a command running in a terminal, not a shell idling there.
    hasActiveWork: () => [...sessions.values()].some(computeBusy),
    handOff(projectId, from) {
      for (const [sessionId, session] of sessions) {
        if (
          session.agent ||
          !session.running ||
          session.projectId !== projectId ||
          session.sender !== from
        )
          continue;
        clearTimeout(session.transit);
        session.transit = setTimeout(() => end(sessionId, session), HANDOFF_MS);
      }
    },
    dispose() {
      clearInterval(busyPoll);
      for (const session of sessions.values()) session.releaseSender?.();
      sessions.clear();
      morgue.clear();
      return lifecycle.dispose();
    },
    agentTerminals,
  };
}
