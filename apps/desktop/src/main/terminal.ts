import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type IPty, spawn as spawnPty } from "@lydell/node-pty";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type { ServerState } from "./ipc.js";
import { shellBinShimDir, shellIntegrationEnv } from "./shell-integration.js";
import { scanOsc133 } from "./terminal-text.js";

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
  /**
   * Rolling output, kept as chunks: appending must not copy the whole
   * cap on every PTY data event (a chatty build produces thousands of
   * chunks per second — `buffer + data` churned hundreds of MB/s).
   * Reads join lazily via bufferText(), which collapses to one chunk.
   */
  chunks: string[];
  chunksLength: number;
  running: boolean;
  /** The shell binary's name — the idle foreground process. */
  shellName: string;
  /** A foreground command is running (chip spinners, agent waits). */
  busy: boolean;
  /** The project this terminal belongs to; home terminals have none. */
  projectId?: string;
  /** Set for agent-owned sessions. */
  agent?: { projectId: string; sessionId: string };
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
  /** Rolling buffer tail (most recent `maxChars`). */
  read(sessionId: string, maxChars?: number): string | null;
  /** Total buffered length — baseline for "output since" reads. */
  bufferLength(sessionId: string): number | null;
  /** Buffer content from `offset`, capped to `maxChars`. */
  readFrom(sessionId: string, offset: number, maxChars?: number): string;
  isRunning(sessionId: string): boolean;
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

/** Closed-session scrollback kept for Cmd+Shift+T restores. */
const MORGUE_CAP = 10;

export function registerTerminalSupport(
  state: ServerState,
  /**
   * Extra env for AGENT terminals, resolved at spawn (late-bound: the
   * agent bridge that provides it registers after terminal support).
   * Today: the `open`-shim hook URL + shim bin dir.
   */
  agentEnv?: (projectId: string) => Record<string, string>,
): {
  dispose(): void;
  agentTerminals: AgentTerminals;
} {
  const sessions = new Map<string, TerminalSession>();

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
    }
    const only = session.chunks[0];
    if (session.chunks.length === 1 && only && only.length > BUFFER_CAP) {
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

  // When a user session ends (shell exit, tab close), its buffer moves
  // here so a reopened tab can replay the scrollback above its fresh
  // shell. Insertion-ordered; oldest entries fall off past the cap.
  const morgue = new Map<string, string>();
  const bury = (sessionId: string, session: TerminalSession) => {
    if (session.agent || session.chunksLength === 0) return;
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
    workingDirectory?: string;
    cols?: number;
    rows?: number;
    sender: WebContents | null;
    agent?: { projectId: string; sessionId: string };
  }): Promise<{ sessionId: string; cwd: string }> => {
    const rootPath = input.projectId
      ? await state.current?.projectRoots.get(input.projectId)
      : null;
    const requestedDirectory = input.workingDirectory
      ? await fs.access(input.workingDirectory).then(
          () => input.workingDirectory,
          () => undefined,
        )
      : undefined;
    const cwd = requestedDirectory ?? rootPath ?? os.homedir();
    const shell = defaultShell();
    // Agent terminals spawn with OSC 133 shell integration for exact
    // busy/exit tracking; user terminals stay exactly as the user's
    // dotfiles configure them (their sessions fall back to the
    // foreground-process heuristic when an agent borrows one).
    const integrationEnv = input.agent
      ? await shellIntegrationEnv(shell)
      : null;
    // The `open` shim (URLs land as in-app tabs) rides the same
    // agent-only integration: the zsh hooks put CATAMORPHIC_BIN first on
    // PATH after the user's profiles ran.
    const shimBin = input.agent ? await shellBinShimDir() : null;
    const agentExtraEnv = input.agent
      ? (agentEnv?.(input.agent.projectId) ?? {})
      : {};
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
          ...integrationEnv,
          ...(shimBin ? { CATAMORPHIC_BIN: shimBin } : {}),
          ...agentExtraEnv,
        },
      },
    );
    const sessionId = crypto.randomUUID();
    const session: TerminalSession = {
      pty,
      sender: input.sender,
      chunks: [],
      chunksLength: 0,
      running: true,
      shellName: path.basename(shell),
      busy: false,
      projectId: input.projectId ?? input.agent?.projectId,
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
    pty.onExit(({ exitCode }) => {
      session.running = false;
      if (!sessions.has(sessionId)) return;
      emit(session, "catamorphic:terminal-exit", { sessionId, exitCode });
      // Agent sessions stay readable (buffer) until explicitly killed or
      // the app quits; user sessions are done once their tab reacts —
      // their scrollback moves to the morgue for Cmd+Shift+T.
      if (!session.agent) {
        bury(sessionId, session);
        sessions.delete(sessionId);
      }
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
    bury(sessionId, session);
    sessions.delete(sessionId);
    if (session.running) session.pty.kill();
    // The pty exit callback skips deleted sessions — announce the death
    // ourselves so a kill triggered by a live tab (Cmd+D) still closes
    // it. Unmount-triggered kills unsubscribed already; this is a no-op
    // for them.
    emit(session, "catamorphic:terminal-exit", { sessionId, exitCode: 0 });
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

  /** Replay history when a renderer attaches to a live (agent) session. */
  ipcMain.handle("catamorphic:terminal-buffer", (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session
      ? { buffer: bufferText(session), running: session.running }
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
      return session ? bufferText(session).slice(-maxChars) : null;
    },
    bufferLength: (sessionId) => {
      const session = sessions.get(sessionId);
      return session ? session.chunksLength : null;
    },
    readFrom: (sessionId, offset, maxChars = 20_000) => {
      const session = sessions.get(sessionId);
      if (!session) return "";
      const text = bufferText(session);
      // The rolling buffer may have shed its head since the offset was
      // taken; clamp into range, newest content wins.
      const start = Math.max(0, Math.min(offset, text.length));
      return text.slice(start).slice(-maxChars);
    },
    isRunning: (sessionId) => sessions.get(sessionId)?.running ?? false,
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
      for (const [sessionId, session] of matches) {
        sessions.delete(sessionId);
        if (session.running) session.pty.kill();
        broadcast("catamorphic:terminal-exit", { sessionId, exitCode: 0 });
      }
      return matches.length;
    },
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
