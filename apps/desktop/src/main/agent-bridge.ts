import { BrowserWindow, ipcMain, webContents } from "electron";
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
   * the latter flips to agent-controlled first). Waits for the command to
   * finish (bounded) and returns only the output it produced.
   */
  runTerminal(
    projectId: string,
    sessionId: string,
    command: string,
    targetTerminalId?: string,
  ): Promise<{
    key: string;
    terminalId: string;
    output: string;
    commandRunning: boolean;
  }>;
  readTerminal(
    projectId: string,
    terminalId: string,
  ): Promise<{ output: string; running: boolean; busy: boolean } | null>;
  writeTerminal(terminalId: string, data: string): Promise<boolean>;
  /** Hand a surface back to the user (agent done) or reclaim it. */
  setControl(
    projectId: string,
    key: string,
    controlled: boolean,
  ): Promise<void>;
  closeSurface(projectId: string, key: string): Promise<void>;
  /**
   * Open (or focus) something tab-shaped BEHIND the agent's chat: an
   * existing tab by key, a project app ("app:<name>"), a file
   * ("file:<path>"), or a URL. The chat steps down to its floating dock
   * so the user sees the opened tab.
   */
  openTarget(
    projectId: string,
    sessionId: string,
    target: string,
  ): Promise<{ key: string }>;
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
}

const RPC_TIMEOUT_MS = 12_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const rpc = <T>(method: string, params: unknown): Promise<T | null> => {
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
      }, RPC_TIMEOUT_MS);
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
            output: agentTerminals.read(info.terminalId) ?? "",
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

    async runTerminal(projectId, sessionId, command, targetTerminalId) {
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
        const created = await agentTerminals.create(projectId);
        terminalId = created.sessionId;
        const attached = await rpc<{ key: string } | null>(
          "attachAgentTerminal",
          { projectId, sessionId, terminalId },
        );
        key = attached?.key ?? `terminal:${terminalId}`;
        terminalKeys.set(terminalId, key);
      }

      const baseline = agentTerminals.bufferLength(terminalId) ?? 0;
      agentTerminals.writeAny(terminalId, `${command}\r`);

      // Wait for the command to finish — most are quick, and complete
      // output beats a partial snapshot. Long runs return early with
      // commandRunning: true; the caller polls read_terminal.
      const graceDeadline = Date.now() + 1_200;
      while (Date.now() < graceDeadline && !agentTerminals.isBusy(terminalId)) {
        await sleep(100);
      }
      const finishDeadline = Date.now() + 15_000;
      while (Date.now() < finishDeadline && agentTerminals.isBusy(terminalId)) {
        await sleep(200);
      }
      // One beat for the tail of the output to flush through the pty.
      await sleep(150);

      return {
        key,
        terminalId,
        output: agentTerminals.readFrom(terminalId, baseline),
        commandRunning: agentTerminals.isBusy(terminalId),
      };
    },

    async readTerminal(_projectId, terminalId) {
      const output = agentTerminals.read(terminalId);
      if (output === null) return null;
      return {
        output,
        running: agentTerminals.isRunning(terminalId),
        busy: agentTerminals.isBusy(terminalId),
      };
    },

    async writeTerminal(terminalId, data) {
      const key = terminalKeys.get(terminalId);
      if (key) guardControl(key);
      return agentTerminals.write(terminalId, data);
    },

    async openTarget(projectId, sessionId, target) {
      const result = await rpc<{ key: string } | { error: string }>(
        "openTarget",
        { projectId, sessionId, target },
      );
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
  };

  return {
    bridge,
    dispose() {
      pending.clear();
      takenOver.clear();
      terminalKeys.clear();
    },
  };
}
