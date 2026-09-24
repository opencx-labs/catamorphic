import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { ElicitRequest, ElicitResult } from "@catamorphic/mcp";
import type {
  ToolPermissionDecision,
  ToolPermissionRequest,
} from "@catamorphic/sandbox";
import { BrowserWindow, ipcMain, webContents } from "electron";
import {
  capOutput,
  encodeCommand,
  sanitizeTerminalOutput,
  waitForShellReady,
} from "../shared/terminal-text.js";
import {
  BackgroundCommands,
  type BackgroundCommandView,
  type BackgroundNotifier,
} from "./background-commands.js";
import {
  type BrowserAction,
  BrowserDriver,
  browserUrl,
} from "./browser-driver.js";
import {
  CommandWatches,
  isCommandWatch,
  runShellCheck,
} from "./command-watches.js";
import type { AgentTerminals } from "./terminal.js";

/**
 * The workspace bridge: how chat agents see and drive the app itself.
 *
 * Tool calls originate in the embedded server (same process), hop to a
 * renderer that has the project open for workspace state and surface
 * creation, and drive browser pages directly from here via each
 * webview's guest WebContents (the chrome-devtools-mcp grammar: snapshot
 * with element uids, then click/fill by uid). Terminals are driven
 * through the shared PTY registry (see terminal.ts).
 *
 * Control handoff: surfaces an agent spawns are marked agent-controlled;
 * the renderer reports a user "take over", after which agent actions on
 * that surface fail with an explanatory error until the agent reclaims.
 */

export interface WorkspaceBridge {
  /** Tabs, chats, and sidebar items of the project's open workspace. */
  overview(projectId: string): Promise<unknown>;
  /**
   * A passive look at a browser tab (title, description, selection, main
   * text excerpt) for per-turn context; never focuses it or shows activity.
   */
  glanceBrowser(
    projectId: string,
    key: string,
    limit: number,
  ): Promise<unknown>;
  /** Expand a tab from the overview: page text, terminal buffer, file. */
  readTab(projectId: string, key: string): Promise<unknown>;
  openBrowser(
    projectId: string,
    sessionId: string,
    url: string,
  ): Promise<{ key: string }>;
  browserSnapshot(
    projectId: string,
    key: string,
    format?: "dom" | "image",
  ): Promise<unknown>;
  browserAct(
    projectId: string,
    key: string,
    action: BrowserAction,
  ): Promise<unknown>;
  /**
   * Start a long-running command in its own background agent terminal
   * (ADR 0155): it outlives the turn, shows as a chip the person can open,
   * and wakes the chat when it finishes or prints a watched line.
   */
  startBackgroundCommand(input: {
    projectId: string;
    sessionId: string;
    command: string;
    description: string;
    workingDirectory?: string;
    wakeOnExit?: boolean;
    wakeOnOutput?: string;
  }): Promise<{
    id: string;
    key: string;
    status: BackgroundCommandView["status"];
    exitCode: number | null;
    output: string;
  }>;
  /** New output since the last read; `waitMs` blocks for news or the end. */
  readBackgroundCommand(input: {
    sessionId: string;
    id: string;
    waitMs?: number;
  }): Promise<{
    status: BackgroundCommandView["status"];
    exitCode: number | null;
    output: string;
  }>;
  stopBackgroundCommand(input: { sessionId: string; id: string }): Promise<{
    status: BackgroundCommandView["status"];
    output: string;
  }>;
  /**
   * Repeat a check until it succeeds or report when its output changes
   * (ADR 0156). Durable across restarts; wakes the chat like a background
   * command does.
   */
  startCommandWatch(input: {
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
  }>;
  stopCommandWatch(input: {
    sessionId: string;
    id: string;
  }): Promise<{ status: BackgroundCommandView["status"] }>;
  backgroundCommands(filter?: {
    projectId?: string;
    sessionId?: string;
  }): BackgroundCommandView[];
  /** Late-bound: how a finished command wakes its chat. */
  setBackgroundNotifier(notify: BackgroundNotifier): void;
  /**
   * Send raw input. Works on agent terminals and on user terminals the
   * agent has taken over (an untouched user terminal is taken over
   * first, so the handoff is always visible).
   */
  writeTerminal(
    projectId: string,
    terminalId: string,
    data: string,
  ): Promise<boolean>;
  /** Hand a surface back to the user (agent done) or reclaim it. */
  setControl(
    projectId: string,
    key: string,
    controlled: boolean,
  ): Promise<void>;
  closeSurface(projectId: string, key: string): Promise<void>;
  sessionProcessCount(
    projectId: string,
    sessionIds: readonly string[],
  ): Promise<number>;
  stopSessionProcesses(
    projectId: string,
    sessionIds: readonly string[],
  ): Promise<number>;
  /**
   * Open (or focus) something tab-shaped: an existing tab by key, a
   * project app ("app:<name>"), a file ("file:<path>"), or a URL. If the
   * user is watching the agent's chat, the tab opens BEHIND it (the chat
   * steps down to its floating dock; `opened: "focused"`). If the user
   * is on another surface, the tab is prepared in the background and the
   * surface's chip on the agent's chat carries an attention indicator
   * instead (`opened: "background"`, plus a `note` telling the agent to
   * narrate rather than assume the user saw it).
   */
  openTarget(
    projectId: string,
    sessionId: string,
    target: string,
  ): Promise<{
    key: string;
    opened: "focused" | "background";
    note?: string;
  }>;
  /**
   * Point the user's attention at a UI element: a subtle glow plus
   * scroll-into-view. The glow stays until the user interacts with the
   * element or the agent points elsewhere / clears.
   */
  pointAt(
    projectId: string,
    target: string,
    note: string | undefined,
    keepPrevious: boolean,
    uid?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  clearPointers(projectId: string): Promise<void>;
  /**
   * Ask the user an MCP `elicitation/create`: a form to fill, or a URL to
   * open (OAuth/credential handoffs). Rendered by the front window;
   * resolves with the user's answer (or a decline if no window can show
   * it). Long-lived — the user may take minutes.
   */
  elicit(
    label: string | undefined,
    request: ElicitRequest,
    signal?: AbortSignal,
  ): Promise<ElicitResult>;
  /**
   * An agent wants to use an MCP tool whose policy says "ask": the front
   * window shows the consent card (tool, server, arguments); resolves
   * with allow (once / always) or deny. Null when no window can show it,
   * or when `signal` aborts (another surface answered first — the modal
   * is withdrawn); callers without another surface treat null as deny.
   */
  toolPermission(
    label: string | undefined,
    request: ToolPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ToolPermissionDecision | null>;
  /**
   * An agent asks for a connector: the front window opens the connectors
   * modal pre-filled with the agent's search query; the user decides what
   * (if anything) to install. Resolves with the names of connections
   * installed while the request was open. Long-lived — install flows
   * include secrets forms and OAuth handoffs.
   */
  requestConnection(
    projectId: string,
    sessionId: string,
    query: string,
    reason: string | undefined,
  ): Promise<{ installed: string[] }>;
}

const RPC_TIMEOUT_MS = 12_000;
/** Elicitation waits on a human (form entry, OAuth) — give it real time. */
const ELICIT_TIMEOUT_MS = 300_000;

/** Model-facing output cap (matches stock Bash's ~30k inline window). */
const OUTPUT_CAP = 30_000;
/** Raw chars sliced before sanitizing (redraw noise shrinks a lot). */
const RAW_READ_CAP = 150_000;

/** Raw PTY buffer → what the model reads: sanitized, tail-capped. */
const modelOutput = (raw: string): string =>
  capOutput(sanitizeTerminalOutput(raw), OUTPUT_CAP);

export function registerAgentBridge(
  agentTerminals: AgentTerminals,
  targetFor: (projectId?: string) => Electron.WebContents | undefined,
  watchOptions: {
    /** Where command watches are saved between runs of the app. */
    file: string;
    /** The agent's toolchain env, so a check finds the same tools. */
    env: () => Promise<Record<string, string>>;
  },
): {
  bridge: WorkspaceBridge;
  /** Env for an agent terminal so its `open` shim reaches this app. */
  openHookEnv(projectId: string): Record<string, string>;
  dispose(): void;
} {
  // --- renderer RPC ---
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      remaining: number;
      timer: ReturnType<typeof setTimeout>;
      senders: Set<number>;
    }
  >();

  ipcMain.on(
    "catamorphic:bridge-response",
    (event, payload: { id: number; result: unknown }) => {
      const entry = pending.get(payload.id);
      if (!entry?.senders.delete(event.sender.id)) return;
      if (payload.result !== null && payload.result !== undefined) {
        pending.delete(payload.id);
        clearTimeout(entry.timer);
        entry.resolve(payload.result);
        return;
      }
      entry.remaining -= 1;
      if (entry.remaining <= 0) {
        pending.delete(payload.id);
        clearTimeout(entry.timer);
        entry.resolve(null);
      }
    },
  );

  /** Ask every window; the first renderer with an answer wins. */
  const rpc = <T>(
    method: string,
    params: unknown,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<T | null> => {
    const projectId =
      typeof params === "object" &&
      params !== null &&
      "projectId" in params &&
      typeof params.projectId === "string"
        ? params.projectId
        : undefined;
    const target = targetFor(projectId);
    const windows = target ? [{ webContents: target }] : [];
    if (windows.length === 0) return Promise.resolve(null);
    const id = ++nextId;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, timeoutMs);
      pending.set(id, {
        timer,
        resolve: resolve as (value: unknown) => void,
        remaining: windows.length,
        senders: new Set(windows.map((window) => window.webContents.id)),
      });
      for (const window of windows) {
        window.webContents.send("catamorphic:bridge-request", {
          id,
          method,
          params,
        });
      }
    });
  };

  /**
   * Ask ONE window — the focused one, else the first alive — for flows
   * that open interactive UI (a broadcast would pop the same modal in
   * every window showing the project).
   */
  const rpcToFront = <T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = RPC_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T | null> => {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed(),
    );
    const recipient = targetFor(
      typeof params.projectId === "string" ? params.projectId : undefined,
    );
    const target = recipient
      ? { webContents: recipient, isDestroyed: () => recipient.isDestroyed() }
      : (BrowserWindow.getFocusedWindow() ?? windows[0]);
    if (!target || target.isDestroyed() || signal?.aborted)
      return Promise.resolve(null);
    const id = ++nextId;
    return new Promise<T | null>((resolve) => {
      const finish = (value: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(value as T | null);
      };
      const abort = () => {
        if (!pending.delete(id)) return;
        if (!target.isDestroyed())
          target.webContents.send("catamorphic:bridge-request", {
            id: ++nextId,
            method: `${method}Cancel`,
            params: { askId: id },
          });
        finish(null);
      };
      const timer = setTimeout(abort, timeoutMs);
      pending.set(id, {
        timer,
        remaining: 1,
        resolve: finish,
        senders: new Set([target.webContents.id]),
      });
      signal?.addEventListener("abort", abort, { once: true });
      target.webContents.send("catamorphic:bridge-request", {
        id,
        method,
        params: { ...params, askId: id },
      });
    });
  };

  // --- control handoff ---
  const takenOver = new Set<string>();
  /** Agent terminal session id → its tab key (for the take-over guard). */
  const terminalKeys = new Map<string, string>();
  ipcMain.on(
    "catamorphic:bridge-takeover",
    (_event, payload: { key: string }) => {
      takenOver.add(payload.key);
    },
  );
  const guardControl = (key: string) => {
    if (takenOver.has(key)) {
      throw new Error(
        "The user has taken control of this surface. Wait for them to " +
          "finish, explain what you need, or reclaim control only if your " +
          "task requires it.",
      );
    }
  };

  // --- browser guests ---
  const guestFor = async (projectId: string, key: string) => {
    const result = await rpc<{ guestId: number } | { error: string }>(
      "browserGuest",
      { projectId, key },
    );
    if (!result || "error" in result) {
      throw new Error(
        (result as { error?: string } | null)?.error ??
          `No open browser tab for ${key}`,
      );
    }
    const guest = webContents.fromId(result.guestId);
    if (!guest || guest.isDestroyed()) {
      throw new Error(`The page for ${key} is gone.`);
    }
    return guest;
  };

  const drivers = new Map<
    number,
    { projectId: string; driver: BrowserDriver }
  >();
  const driverFor = async (projectId: string, key: string) => {
    const guest = await guestFor(projectId, key);
    const existing = drivers.get(guest.id);
    if (existing) return existing.driver;
    const driver = new BrowserDriver(
      guest,
      () => guardControl(key),
      async (active) => {
        const result = await rpc<{ ok: true } | { error: string }>(
          "browserActivity",
          { projectId, key, active },
        );
        if (active && (!result || "error" in result))
          throw new Error(
            result && "error" in result
              ? result.error
              : "Browser workspace unavailable",
          );
      },
    );
    drivers.set(guest.id, { projectId, driver });
    const guestId = guest.id;
    guest.once("destroyed", () => {
      drivers.delete(guestId);
      takenOver.delete(key);
    });
    return driver;
  };
  const clearPagePointers = async (projectId: string) => {
    await Promise.all(
      [...drivers.values()]
        .filter((entry) => entry.projectId === projectId)
        .map(({ driver }) => driver.clear()),
    );
  };

  const background = new BackgroundCommands({
    terminals: agentTerminals,
    attach: async ({ projectId, sessionId, terminalId, title }) => {
      const attached = await rpc<{ key: string } | null>(
        "attachAgentTerminal",
        { projectId, sessionId, terminalId, title: title.slice(0, 100) },
      );
      const key = attached?.key ?? `terminal:${terminalId}`;
      terminalKeys.set(terminalId, key);
      return key;
    },
    // Never write into a shell that hasn't shown its first prompt: bytes
    // queued during startup are echoed twice (see waitForShellReady).
    waitReady: (terminalId) =>
      waitForShellReady({
        running: () => agentTerminals.isRunning(terminalId),
        prompts: () => agentTerminals.commandTracking(terminalId)?.prompts ?? 0,
        bufferLength: () => agentTerminals.bufferLength(terminalId) ?? 0,
      }),
    modelOutput,
    encode: encodeCommand,
    changed: () => publishBackground(),
  });
  const watches = new CommandWatches({
    run: async ({ command, workingDirectory, timeoutMs }) => {
      const result = await runShellCheck({
        command,
        ...(workingDirectory ? { workingDirectory } : {}),
        timeoutMs,
        env: { ...process.env, ...(await watchOptions.env()) },
      });
      return { exitCode: result.exitCode, output: modelOutput(result.raw) };
    },
    load: async () => {
      try {
        const saved: unknown = JSON.parse(
          await fs.readFile(watchOptions.file, "utf8"),
        );
        return Array.isArray(saved) ? saved.filter(isCommandWatch) : [];
      } catch {
        return [];
      }
    },
    save: async (list) => {
      const temporary = `${watchOptions.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(list, null, 2));
      await fs.rename(temporary, watchOptions.file);
    },
    changed: () => publishBackground(),
  });
  const backgroundWork = () => [...background.list(), ...watches.list()];
  function publishBackground() {
    const work = backgroundWork();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send("catamorphic:background-commands", work);
    }
  }
  ipcMain.handle("catamorphic:background-commands", () => backgroundWork());

  const bridge: WorkspaceBridge = {
    async overview(projectId) {
      const result = await rpc("overview", { projectId });
      if (!result) {
        throw new Error(
          "No window has this project open, so the workspace is not visible.",
        );
      }
      return result;
    },

    async glanceBrowser(projectId, key, limit) {
      return (await driverFor(projectId, key)).glance(limit);
    },

    async readTab(projectId, key) {
      if (key.startsWith("terminal:")) {
        const info = await rpc<{ terminalId: string } | null>("terminalId", {
          projectId,
          key,
        });
        if (info?.terminalId) {
          return {
            kind: "terminal",
            output: modelOutput(
              agentTerminals.read(info.terminalId, RAW_READ_CAP) ?? "",
            ),
            running: agentTerminals.isRunning(info.terminalId),
          };
        }
        throw new Error(`No terminal found for ${key}`);
      }
      if (key.startsWith("browser:")) {
        return (await driverFor(projectId, key)).read();
      }
      const result = await rpc("readTab", { projectId, key });
      if (!result) throw new Error(`Nothing readable behind ${key}`);
      return result;
    },

    async openBrowser(projectId, sessionId, url) {
      const result = await rpc<{ key: string } | { error: string }>(
        "openAgentBrowser",
        { projectId, sessionId, url: browserUrl(url) },
      );
      if (!result || "error" in result) {
        throw new Error(
          (result as { error?: string } | null)?.error ??
            "Could not open a browser tab (is the workspace open?)",
        );
      }
      return result;
    },

    async browserSnapshot(projectId, key, format) {
      return (await driverFor(projectId, key)).snapshot(format);
    },

    async browserAct(projectId, key, action) {
      return (await driverFor(projectId, key)).act(action);
    },

    startBackgroundCommand: (input) => background.start(input),
    readBackgroundCommand: (input) => background.read(input),
    stopBackgroundCommand: (input) => background.stop(input),
    startCommandWatch: (input) => watches.start(input),
    stopCommandWatch: (input) => watches.stop(input),
    backgroundCommands: (filter) => [
      ...background.list(filter),
      ...watches.list(filter),
    ],
    setBackgroundNotifier: (notify) => {
      background.setNotifier(notify);
      void watches.setNotifier(notify);
    },

    async writeTerminal(projectId, terminalId, data) {
      const key =
        terminalKeys.get(terminalId) ??
        (
          await rpc<{ key: string } | null>("terminalKey", {
            projectId,
            terminalId,
          })
        )?.key;
      if (key) {
        guardControl(key);
        // Writing into the user's own terminal is a take-over, exactly
        // like running a command there — mark it so the handoff (and
        // the Take over button) is visible.
        if (
          !agentTerminals.isAgentOwned(terminalId) &&
          !terminalKeys.has(terminalId)
        ) {
          await rpc("surfaceControl", { projectId, key, controlled: true });
        }
        terminalKeys.set(terminalId, key);
      } else if (!agentTerminals.isAgentOwned(terminalId)) {
        // A user terminal we can't even resolve a tab for: never write
        // into it invisibly.
        return false;
      }
      return agentTerminals.writeAny(terminalId, data);
    },

    async openTarget(projectId, sessionId, target) {
      const result = await rpc<
        | { key: string; opened: "focused" | "background"; note?: string }
        | { error: string }
      >("openTarget", { projectId, sessionId, target });
      if (!result || "error" in result) {
        throw new Error(
          (result as { error?: string } | null)?.error ??
            "Could not open that target (is the workspace open?)",
        );
      }
      return result;
    },

    async pointAt(projectId, target, note, keepPrevious, uid) {
      if (!keepPrevious) await bridge.clearPointers(projectId);
      if (uid !== undefined) {
        await (await driverFor(projectId, target)).point(
          uid,
          note,
          keepPrevious,
        );
        return { ok: true };
      }
      const result = await rpc<{ ok: boolean; error?: string } | null>(
        "pointAt",
        { projectId, target, note, keepPrevious },
      );
      if (!result) {
        return { ok: false, error: "No window has this project open." };
      }
      return result;
    },

    async clearPointers(projectId) {
      await clearPagePointers(projectId);
      await rpc("clearPointers", { projectId });
    },

    async elicit(label, request, signal) {
      const result = await rpcToFront<ElicitResult>(
        "elicit",
        { label, request },
        ELICIT_TIMEOUT_MS,
        signal,
      );
      // No window, or the user closed it without answering → decline; a
      // pending tool call must never hang forever on a missing UI.
      return result ?? { action: "decline" };
    },

    async toolPermission(label, request, signal) {
      const result = await rpcToFront<unknown>(
        "toolPermission",
        { label, request },
        ELICIT_TIMEOUT_MS,
        signal,
      );
      if (result === null || result === undefined) return null;
      // Anything but a well-formed "allow" is a deny — a renderer error
      // reply ({ error }) must never read as consent.
      const decision = result as { decision?: unknown; remember?: unknown };
      if (decision.decision === "allow") {
        return decision.remember === "always"
          ? { decision: "allow", remember: "always" }
          : { decision: "allow" };
      }
      return { decision: "deny" };
    },

    async requestConnection(projectId, sessionId, query, reason) {
      const result = await rpc<{ installed: string[] }>(
        "requestConnection",
        { projectId, sessionId, query, reason },
        ELICIT_TIMEOUT_MS,
      );
      // No window, or the request expired unanswered → nothing installed;
      // the tool call must resolve either way.
      return result ?? { installed: [] };
    },

    async setControl(projectId, key, controlled) {
      if (controlled) takenOver.delete(key);
      else takenOver.add(key);
      await rpc("surfaceControl", { projectId, key, controlled });
    },

    async closeSurface(projectId, key) {
      takenOver.delete(key);
      // An agent closing its terminal tab also ends the process behind
      // it — a headless PTY nobody can see must not keep running.
      if (key.startsWith("terminal:")) {
        const info = await rpc<{ terminalId: string } | null>("terminalId", {
          projectId,
          key,
        });
        if (info?.terminalId) {
          agentTerminals.kill(info.terminalId);
          terminalKeys.delete(info.terminalId);
        }
      }
      await rpc("closeSurface", { projectId, key });
    },
    async sessionProcessCount(projectId, sessionIds) {
      return (
        agentTerminals.countForOwners(projectId, sessionIds) +
        watches.count(projectId, sessionIds)
      );
    },
    async stopSessionProcesses(projectId, sessionIds) {
      return (
        agentTerminals.killForOwners(projectId, sessionIds) +
        (await watches.stopForSessions(projectId, sessionIds))
      );
    },
  };

  // --- the terminal `open` hook ---
  // A loopback endpoint the shell shim posts URLs to (see
  // shell-integration.ts): `open https://…` in an agent terminal becomes
  // the same in-app open as the open_surface tool — browser tab in front,
  // the chat stepping down to its floating dock. Token-pathed so nothing
  // else on the machine can drive it.
  const hookToken = crypto.randomBytes(16).toString("hex");
  let hookPort: number | null = null;
  const hookServer = http.createServer((request, response) => {
    const finish = (status: number, body: string) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(body);
    };
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== `/${hookToken}/open`) {
      finish(404, "not found");
      return;
    }
    const projectId = url.searchParams.get("projectId") ?? "";
    let body = "";
    request.on("data", (chunk: Buffer) => {
      if (body.length < 16_384) body += chunk.toString();
    });
    request.on("end", () => {
      const target = new URLSearchParams(body).get("url") ?? "";
      if (!/^https?:\/\//.test(target) || !projectId) {
        finish(400, "bad request");
        return;
      }
      bridge
        .openTarget(projectId, "", target)
        .then(() => finish(200, "ok"))
        .catch(() => finish(502, "no window"));
    });
  });
  hookServer.listen(0, "127.0.0.1", () => {
    const address = hookServer.address();
    if (address && typeof address === "object") hookPort = address.port;
  });

  return {
    bridge,
    /** Env for an agent terminal so its `open` shim reaches this app. */
    openHookEnv(projectId: string): Record<string, string> {
      if (hookPort === null) return {};
      return {
        CATAMORPHIC_OPEN_HOOK: `http://127.0.0.1:${hookPort}/${hookToken}/open?projectId=${encodeURIComponent(projectId)}`,
      };
    },
    dispose() {
      background.dispose();
      watches.dispose();
      ipcMain.removeHandler("catamorphic:background-commands");
      hookServer.close();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(null);
      }
      pending.clear();
      takenOver.clear();
      terminalKeys.clear();
    },
  };
}
