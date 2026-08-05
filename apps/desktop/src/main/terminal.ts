import crypto from "node:crypto";
import os from "node:os";
import { spawn as spawnPty, type IPty } from "@lydell/node-pty";
import { ipcMain, type WebContents } from "electron";
import type { ServerState } from "./ipc.js";

/**
 * PTY sessions for terminal tabs. The renderer runs the emulator
 * (ghostty-web, libghostty-vt compiled to WASM); this side owns the real
 * processes. Sessions are addressed by id and bound to the window that
 * created them: output streams only there, and a window closing reaps
 * every session it owned.
 */

interface TerminalSession {
  pty: IPty;
  sender: WebContents;
}

/** The user's login shell — terminals should feel like Terminal.app. */
function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/zsh";
}

export function registerTerminalSupport(state: ServerState): {
  dispose(): void;
} {
  const sessions = new Map<string, TerminalSession>();

  const reapFor = (sender: WebContents) => {
    for (const [id, session] of sessions) {
      if (session.sender === sender) {
        sessions.delete(id);
        session.pty.kill();
      }
    }
  };

  ipcMain.handle(
    "catamorphic:terminal-create",
    async (
      event,
      input: { projectId?: string; cols?: number; rows?: number },
    ): Promise<{ sessionId: string; cwd: string }> => {
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
      const sender = event.sender;
      sessions.set(sessionId, { pty, sender });

      pty.onData((data) => {
        if (!sender.isDestroyed()) {
          sender.send("catamorphic:terminal-data", { sessionId, data });
        }
      });
      pty.onExit(({ exitCode }) => {
        if (!sessions.delete(sessionId)) return;
        if (!sender.isDestroyed()) {
          sender.send("catamorphic:terminal-exit", { sessionId, exitCode });
        }
      });
      // A closed window can't kill its tabs' sessions itself.
      sender.once("destroyed", () => reapFor(sender));

      return { sessionId, cwd };
    },
  );

  ipcMain.handle(
    "catamorphic:terminal-write",
    (_event, sessionId: string, data: string) => {
      sessions.get(sessionId)?.pty.write(data);
    },
  );

  ipcMain.handle(
    "catamorphic:terminal-resize",
    (_event, sessionId: string, cols: number, rows: number) => {
      if (cols > 0 && rows > 0) {
        sessions.get(sessionId)?.pty.resize(cols, rows);
      }
    },
  );

  ipcMain.handle("catamorphic:terminal-kill", (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.pty.kill();
  });

  return {
    dispose() {
      for (const session of sessions.values()) {
        session.pty.kill();
      }
      sessions.clear();
    },
  };
}
