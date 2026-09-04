import crypto from "node:crypto";
import http from "node:http";
import type { ElicitRequest, ElicitResult } from "@catamorphic/mcp";
import type {
  ToolPermissionDecision,
  ToolPermissionRequest,
} from "@catamorphic/sandbox";
import { BrowserWindow, ipcMain, webContents } from "electron";
import type { AgentTerminals } from "./terminal.js";
import {
  capOutput,
  encodeCommand,
  sanitizeTerminalOutput,
  waitForShellReady,
} from "./terminal-text.js";

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
  /** Expand a tab from the overview: page text, terminal buffer, file. */
  readTab(projectId: string, key: string): Promise<unknown>;
  openBrowser(
    projectId: string,
    sessionId: string,
    url: string,
  ): Promise<{ key: string }>;
  browserSnapshot(projectId: string, key: string): Promise<unknown>;
  browserAct(
    projectId: string,
    key: string,
    action:
      | { type: "click"; uid: number }
      | { type: "fill"; uid: number; text: string }
      | { type: "press"; key: string }
      | { type: "navigate"; url: string }
      | { type: "read" }
      | { type: "scroll"; direction: "up" | "down" }
      | { type: "wait_for"; text: string; timeoutMs?: number },
  ): Promise<unknown>;
  /**
   * Run a command in a terminal: a fresh agent terminal by default, or —
   * with `targetTerminalId` — an existing one (agent-owned or the user's;
   * the latter flips to agent-controlled first). Waits up to `timeoutMs`
   * (default 2 minutes, like a stock coding-agent shell) and returns the
   * output the command produced, sanitized for model reading. `exitCode`
   * is present when shell integration saw the command complete; `offset`
   * is the buffer position to pass to readTerminal for output-since-here.
   */
  runTerminal(
    projectId: string,
    sessionId: string,
    command: string,
    targetTerminalId?: string,
    timeoutMs?: number,
    workingDirectory?: string,
  ): Promise<{
    key: string;
    terminalId: string;
    output: string;
    commandRunning: boolean;
    exitCode?: number;
    offset: number;
  }>;
  /**
   * Read a terminal's output — the recent tail, or everything since
   * `sinceOffset` (from an earlier read/run). `waitForIdleMs` blocks
   * until the foreground command finishes (or the deadline), so callers
   * following a long command wait server-side instead of polling.
   */
  readTerminal(
    projectId: string,
    terminalId: string,
    opts?: { sinceOffset?: number; waitForIdleMs?: number },
  ): Promise<{
    output: string;
    running: boolean;
    busy: boolean;
    offset: number;
    lastExitCode?: number;
  } | null>;
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

/**
 * Terminal waits mirror a stock coding-agent shell: 2 minutes by default,
 * 10 at most — a build that takes 90s should come back in one tool call,
 * not a poll loop that burns a model turn every 15 seconds.
 */
const RUN_DEFAULT_WAIT_MS = 120_000;
const RUN_MAX_WAIT_MS = 600_000;
/** Model-facing output cap (matches stock Bash's ~30k inline window). */
const OUTPUT_CAP = 30_000;
/** Raw chars sliced before sanitizing (redraw noise shrinks a lot). */
const RAW_READ_CAP = 150_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Raw PTY buffer → what the model reads: sanitized, tail-capped. */
const modelOutput = (raw: string): string =>
  capOutput(sanitizeTerminalOutput(raw), OUTPUT_CAP);

/** Guest-side script: index interactive elements, act, and visualize. */
const GUEST_HELPERS = `
(() => {
  if (window.__catAgent) return;
  const highlight = (el) => {
    try {
      const rect = el.getBoundingClientRect();
      const glow = document.createElement("div");
      glow.style.cssText =
        "position:fixed;z-index:2147483647;pointer-events:none;" +
        "border:2px solid rgba(249,82,37,.9);border-radius:6px;" +
        "box-shadow:0 0 0 4px rgba(249,82,37,.25);" +
        "transition:opacity .6s ease,transform .6s ease;" +
        "left:" + (rect.left - 3) + "px;top:" + (rect.top - 3) + "px;" +
        "width:" + (rect.width + 6) + "px;height:" + (rect.height + 6) + "px;";
      document.documentElement.appendChild(glow);
      requestAnimationFrame(() => {
        glow.style.opacity = "0";
        glow.style.transform = "scale(1.06)";
      });
      setTimeout(() => glow.remove(), 700);
    } catch {}
  };
  const setNativeValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  window.__catAgent = {
    uids: [],
    snapshot() {
      const selector = [
        "a[href]", "button", "input", "textarea", "select",
        "[role=button]", "[role=link]", "[role=textbox]",
        "[role=combobox]", "[role=checkbox]", "[role=menuitem]",
        "[contenteditable=true]",
      ].join(",");
      const visible = [...document.querySelectorAll(selector)].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      this.uids = visible;
      const lines = visible.slice(0, 300).map((el, i) => {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute("type");
        const text = (el.innerText || el.value || el.placeholder ||
          el.getAttribute("aria-label") || el.title || "")
          .trim().replace(/\\s+/g, " ").slice(0, 90);
        return "[" + i + "] <" + tag + (type ? " type=" + type : "") + "> " + text;
      });
      return {
        url: location.href,
        title: document.title,
        elements: lines.join("\\n"),
        truncated: visible.length > 300,
      };
    },
    click(uid) {
      const el = this.uids[uid];
      if (!el) return { error: "Unknown uid " + uid + ". Take a fresh snapshot." };
      highlight(el);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus && el.focus();
      el.click();
      return { ok: true };
    },
    fill(uid, text) {
      const el = this.uids[uid];
      if (!el) return { error: "Unknown uid " + uid + ". Take a fresh snapshot." };
      highlight(el);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus && el.focus();
      if (el.isContentEditable) el.textContent = text;
      else setNativeValue(el, text);
      return { ok: true };
    },
    press(key) {
      const el = document.activeElement || document.body;
      const options = { key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", options));
      el.dispatchEvent(new KeyboardEvent("keyup", options));
      if (key === "Enter" && el.form) el.form.requestSubmit();
      return { ok: true };
    },
    read() {
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText ?? "").slice(0, 30000),
      };
    },
    scroll(direction) {
      window.scrollBy({
        top: (direction === "up" ? -0.8 : 0.8) * window.innerHeight,
        behavior: "instant",
      });
      return { ok: true, scrollY: window.scrollY };
    },
    waitFor(text, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 5000);
      return new Promise((resolve) => {
        const check = () => {
          if ((document.body?.innerText ?? "").includes(text)) {
            resolve({ found: true });
          } else if (Date.now() > deadline) {
            resolve({ found: false, error: "Timed out waiting for: " + text });
          } else {
            setTimeout(check, 250);
          }
        };
        check();
      });
    },
  };
})();
`;

export function registerAgentBridge(agentTerminals: AgentTerminals): {
  bridge: WorkspaceBridge;
  /** Env for an agent terminal so its `open` shim reaches this app. */
  openHookEnv(projectId: string): Record<string, string>;
  dispose(): void;
} {
  // --- renderer RPC ---
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; remaining: number }
  >();

  ipcMain.on(
    "catamorphic:bridge-response",
    (_event, payload: { id: number; result: unknown }) => {
      const entry = pending.get(payload.id);
      if (!entry) return;
      if (payload.result !== null && payload.result !== undefined) {
        pending.delete(payload.id);
        entry.resolve(payload.result);
        return;
      }
      entry.remaining -= 1;
      if (entry.remaining <= 0) {
        pending.delete(payload.id);
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
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed(),
    );
    if (windows.length === 0) return Promise.resolve(null);
    const id = ++nextId;
    return new Promise<T | null>((resolve) => {
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        remaining: windows.length,
      });
      for (const window of windows) {
        window.webContents.send("catamorphic:bridge-request", {
          id,
          method,
          params,
        });
      }
      setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, timeoutMs);
    });
  };

  /**
   * Ask ONE window — the focused one, else the first alive — for flows
   * that open interactive UI (a broadcast would pop the same modal in
   * every window showing the project).
   */
  const rpcToFront = <T>(
    method: string,
    params: unknown,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<T | null> => {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed(),
    );
    const target = BrowserWindow.getFocusedWindow() ?? windows[0];
    if (!target || target.isDestroyed()) return Promise.resolve(null);
    const id = ++nextId;
    return new Promise<T | null>((resolve) => {
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        remaining: 1,
      });
      target.webContents.send("catamorphic:bridge-request", {
        id,
        method,
        params,
      });
      setTimeout(() => {
        if (pending.delete(id)) resolve(null);
      }, timeoutMs);
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

  const runInGuest = async <T>(
    guest: Electron.WebContents,
    expression: string,
  ): Promise<T> => {
    await guest.executeJavaScript(GUEST_HELPERS);
    return (await guest.executeJavaScript(expression)) as T;
  };

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
        const guest = await guestFor(projectId, key);
        return {
          kind: "page",
          ...(await runInGuest<object>(guest, "window.__catAgent.read()")),
        };
      }
      const result = await rpc("readTab", { projectId, key });
      if (!result) throw new Error(`Nothing readable behind ${key}`);
      return result;
    },

    async openBrowser(projectId, sessionId, url) {
      const result = await rpc<{ key: string } | { error: string }>(
        "openAgentBrowser",
        { projectId, sessionId, url },
      );
      if (!result || "error" in result) {
        throw new Error(
          (result as { error?: string } | null)?.error ??
            "Could not open a browser tab (is the workspace open?)",
        );
      }
      return result;
    },

    async browserSnapshot(projectId, key) {
      const guest = await guestFor(projectId, key);
      return runInGuest(guest, "window.__catAgent.snapshot()");
    },

    async browserAct(projectId, key, action) {
      guardControl(key);
      const guest = await guestFor(projectId, key);
      switch (action.type) {
        case "navigate": {
          await guest.loadURL(action.url).catch((error: Error) => {
            // ERR_ABORTED fires on redirects/SPA takeovers; the load went on.
            if (!/ERR_ABORTED/.test(error.message)) throw error;
          });
          return { ok: true, url: guest.getURL() };
        }
        case "click":
          return runInGuest(guest, `window.__catAgent.click(${action.uid})`);
        case "fill":
          return runInGuest(
            guest,
            `window.__catAgent.fill(${action.uid}, ${JSON.stringify(action.text)})`,
          );
        case "press":
          return runInGuest(
            guest,
            `window.__catAgent.press(${JSON.stringify(action.key)})`,
          );
        case "read":
          return runInGuest(guest, "window.__catAgent.read()");
        case "scroll":
          return runInGuest(
            guest,
            `window.__catAgent.scroll(${JSON.stringify(action.direction)})`,
          );
        case "wait_for":
          return runInGuest(
            guest,
            `window.__catAgent.waitFor(${JSON.stringify(action.text)}, ${
              action.timeoutMs ?? 5000
            })`,
          );
      }
    },

    async runTerminal(
      projectId,
      sessionId,
      command,
      targetTerminalId,
      timeoutMs,
      workingDirectory,
    ) {
      if (!command.trim()) {
        throw new Error("Empty command.");
      }
      let terminalId: string;
      let key: string;
      if (targetTerminalId) {
        if (!agentTerminals.isRunning(targetTerminalId)) {
          throw new Error(
            "That terminal's shell is not running. Pick another from workspace_overview or omit terminalId for a fresh one.",
          );
        }
        const found =
          terminalKeys.get(targetTerminalId) ??
          (
            await rpc<{ key: string } | null>("terminalKey", {
              projectId,
              terminalId: targetTerminalId,
            })
          )?.key;
        if (!found) {
          throw new Error(
            "No workspace tab for that terminal id. Check workspace_overview.",
          );
        }
        key = found;
        guardControl(key);
        if (agentTerminals.isBusy(targetTerminalId)) {
          throw new Error(
            "That terminal is mid-command. Wait (read_terminal), interrupt it (write_terminal with \\u0003), or run elsewhere.",
          );
        }
        terminalId = targetTerminalId;
        terminalKeys.set(terminalId, key);
        // Running in the user's own terminal is a take-over: mark it so
        // they see the handoff (and get the Take over button back).
        if (!agentTerminals.isAgentOwned(terminalId)) {
          await rpc("surfaceControl", { projectId, key, controlled: true });
        }
      } else {
        const created = await agentTerminals.create(
          projectId,
          sessionId,
          workingDirectory,
        );
        terminalId = created.sessionId;
        const attached = await rpc<{ key: string } | null>(
          "attachAgentTerminal",
          { projectId, sessionId, terminalId },
        );
        key = attached?.key ?? `terminal:${terminalId}`;
        terminalKeys.set(terminalId, key);
        // Never write into a shell that hasn't shown its first prompt:
        // bytes queued during startup are echoed by the tty AND again by
        // the line editor, so the transcript showed the command twice
        // (see waitForShellReady). Waiting also pins the prompt baseline,
        // so the completion wait below can't mistake the STARTUP prompt
        // for "the shell consumed my command".
        await waitForShellReady({
          running: () => agentTerminals.isRunning(terminalId),
          prompts: () =>
            agentTerminals.commandTracking(terminalId)?.prompts ?? 0,
          bufferLength: () => agentTerminals.bufferLength(terminalId) ?? 0,
        });
      }

      const baseline = agentTerminals.bufferLength(terminalId) ?? 0;
      const trackingBefore = agentTerminals.commandTracking(terminalId);
      const completionsBefore = trackingBefore?.completions ?? 0;
      const promptsBefore = trackingBefore?.prompts ?? 0;
      agentTerminals.writeAny(terminalId, encodeCommand(command));

      // Wait for the command to finish — most are quick, and complete
      // output beats a partial snapshot. Runs that outlast the wait
      // return with commandRunning: true; the caller follows up with
      // read_terminal (which can block on idle server-side).
      const waitMs = Math.min(
        Math.max(timeoutMs ?? RUN_DEFAULT_WAIT_MS, 1_000),
        RUN_MAX_WAIT_MS,
      );
      const finishDeadline = Date.now() + waitMs;
      // With shell integration, the completion counter is authoritative —
      // it can't miss a fast command or mistake a slow shell startup for
      // "already finished". Without markers, fall back to the busy flag
      // after a short grace for the command to register as busy at all.
      const graceDeadline = Date.now() + 1_200;
      const commandFinished = () => {
        if (!agentTerminals.isRunning(terminalId)) return true;
        const tracking = agentTerminals.commandTracking(terminalId);
        // A new prompt means the shell consumed the submitted line and
        // came back — even for lines that run nothing (comment-only),
        // which produce a prompt but no completion.
        if (tracking?.seen) return tracking.prompts > promptsBefore;
        return Date.now() > graceDeadline && !agentTerminals.isBusy(terminalId);
      };
      while (Date.now() < finishDeadline && !commandFinished()) {
        await sleep(150);
      }
      // One beat for the tail of the output to flush through the pty.
      await sleep(150);

      const commandRunning = agentTerminals.isBusy(terminalId);
      // Exit code only when shell integration watched THIS command end —
      // a completion count that didn't move means the marker (and code)
      // belongs to some earlier command.
      const tracking = agentTerminals.commandTracking(terminalId);
      const exitCode =
        !commandRunning &&
        tracking?.seen &&
        tracking.completions > completionsBefore
          ? tracking.lastExitCode
          : null;
      return {
        key,
        terminalId,
        output: modelOutput(
          agentTerminals.readFrom(terminalId, baseline, RAW_READ_CAP),
        ),
        commandRunning,
        ...(exitCode !== null ? { exitCode } : {}),
        offset: agentTerminals.bufferLength(terminalId) ?? 0,
      };
    },

    async readTerminal(_projectId, terminalId, opts) {
      if (agentTerminals.read(terminalId, 1) === null) return null;
      const idleDeadline =
        Date.now() +
        Math.min(Math.max(opts?.waitForIdleMs ?? 0, 0), RUN_MAX_WAIT_MS);
      while (Date.now() < idleDeadline && agentTerminals.isBusy(terminalId)) {
        await sleep(200);
      }
      const raw =
        opts?.sinceOffset !== undefined
          ? agentTerminals.readFrom(terminalId, opts.sinceOffset, RAW_READ_CAP)
          : (agentTerminals.read(terminalId, RAW_READ_CAP) ?? "");
      const busy = agentTerminals.isBusy(terminalId);
      const tracking = agentTerminals.commandTracking(terminalId);
      return {
        output: modelOutput(raw),
        running: agentTerminals.isRunning(terminalId),
        busy,
        offset: agentTerminals.bufferLength(terminalId) ?? 0,
        // The latest completed command's exit code — meaningful to a
        // caller who just watched their command finish.
        ...(!busy && tracking?.seen && tracking.lastExitCode !== null
          ? { lastExitCode: tracking.lastExitCode }
          : {}),
      };
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

    async pointAt(projectId, target, note, keepPrevious) {
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
      await rpc("clearPointers", { projectId });
    },

    async elicit(label, request) {
      const result = await rpc<ElicitResult>(
        "elicit",
        { label, request },
        ELICIT_TIMEOUT_MS,
      );
      // No window, or the user closed it without answering → decline; a
      // pending tool call must never hang forever on a missing UI.
      return result ?? { action: "decline" };
    },

    async toolPermission(label, request, signal) {
      // ONE window (focused, else the first): an unfocused app must still
      // queue the ask rather than auto-deny it — the user just alt-tabbed.
      const windows = BrowserWindow.getAllWindows().filter(
        (window) => !window.isDestroyed(),
      );
      const target = BrowserWindow.getFocusedWindow() ?? windows[0];
      if (!target || target.isDestroyed()) return null;
      if (signal?.aborted) return null;
      const id = ++nextId;
      const result = await new Promise<unknown>((resolve) => {
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          remaining: 1,
        });
        // askId rides along so a later cancel can name this exact card.
        target.webContents.send("catamorphic:bridge-request", {
          id,
          method: "toolPermission",
          params: { label, request, askId: id },
        });
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve(null);
        }, ELICIT_TIMEOUT_MS);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            if (!pending.delete(id)) return;
            // Another surface answered first: withdraw the queued card.
            if (!target.isDestroyed()) {
              target.webContents.send("catamorphic:bridge-request", {
                id: ++nextId,
                method: "toolPermissionCancel",
                params: { askId: id },
              });
            }
            resolve(null);
          },
          { once: true },
        );
      });
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
      const result = await rpcToFront<{ installed: string[] }>(
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
      return agentTerminals.countForOwners(projectId, sessionIds);
    },
    async stopSessionProcesses(projectId, sessionIds) {
      return agentTerminals.killForOwners(projectId, sessionIds);
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
      hookServer.close();
      pending.clear();
      takenOver.clear();
      terminalKeys.clear();
    },
  };
}
