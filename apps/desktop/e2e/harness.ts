import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { electronLaunchArgs } from "./harness-args.js";

/**
 * E2E harness: builds the app (electron-vite), launches the real Electron
 * binary against an isolated userData dir with the fake agent enabled, and
 * exposes a minimal CDP client (evaluate/screenshot) over the DevTools
 * WebSocket. No test-only frameworks — Node built-ins only.
 */

const DESKTOP_DIR = path.resolve(import.meta.dirname, "..");
// Unique per-launch port: a leaked instance from an aborted run must not
// answer the next run's CDP handshake.
const cdpPort = () => 9300 + Math.floor(Math.random() * 400);

/** A random CDP port that is actually free — a dev instance of the app
 * (or anything else) may be squatting on one of the candidates. */
async function freeCdpPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = cdpPort();
    const free = await new Promise<boolean>((resolve) => {
      const probe = net
        .connect({ host: "127.0.0.1", port }, () => {
          probe.destroy();
          resolve(false);
        })
        .on("error", () => resolve(true));
    });
    if (free) return port;
  }
  return cdpPort();
}

export interface FrameHandle {
  /** Evaluate JS inside the frame; resolves the JSON-serialized result. */
  eval: <T = unknown>(expression: string) => Promise<T>;
  waitFor: <T = unknown>(
    expression: string,
    opts?: { timeoutMs?: number; label?: string },
  ) => Promise<T>;
  close: () => void;
}

export interface AppHandle {
  /** Evaluate JS in the app window; resolves the JSON-serialized result. */
  eval: <T = unknown>(expression: string) => Promise<T>;
  /** Wait until `expression` evaluates truthy (500ms poll, throws on timeout). */
  waitFor: <T = unknown>(
    expression: string,
    opts?: { timeoutMs?: number; label?: string },
  ) => Promise<T>;
  screenshot: (filePath: string) => Promise<void>;
  /**
   * Press a real key through CDP (Chromium performs its default editing —
   * a synthetic KeyboardEvent can't delete text in a contenteditable).
   * `modifiers` is CDP's bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
   */
  press: (key: KeyName, modifiers?: number) => Promise<void>;
  /**
   * Attach a second CDP session to an out-of-process iframe — e.g. a
   * sandboxed app guest, whose opaque origin makes it unreachable from the
   * page context — found by URL substring across the browser's targets.
   */
  connectToFrame: (
    urlSubstring: string,
    opts?: { timeoutMs?: number },
  ) => Promise<FrameHandle>;
  /** Captured app stdout/stderr so far (diagnosing server-side behavior). */
  getOutput: () => string;
  userDataDir: string;
  stop: () => Promise<void>;
  /**
   * SIGKILL without cleanup — simulates a crash/quit mid-operation. The
   * userData dir survives so a follow-up launchApp({ userDataDir }) can
   * exercise recovery paths.
   */
  kill: () => Promise<void>;
}

export interface LaunchOpts {
  /** Reuse an existing userData dir (relaunch scenarios). */
  userDataDir?: string;
  /** Extra environment variables for the app process (e2e seams). */
  env?: Record<string, string>;
}

export async function launchApp(opts: LaunchOpts = {}): Promise<AppHandle> {
  const userDataDir =
    opts.userDataDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-e2e-data-"));

  // The real binary, not the .bin CLI wrapper — the wrapper spawns Electron
  // as its own child, so killing the wrapper would orphan the app.
  const electronPackage = path.join(DESKTOP_DIR, "node_modules", "electron");
  const electronBinary = path.join(
    electronPackage,
    "dist",
    fs.readFileSync(path.join(electronPackage, "path.txt"), "utf-8").trim(),
  );
  const port = await freeCdpPort();
  const child = spawn(
    electronBinary,
    electronLaunchArgs({
      cdpPort: port,
      ci: process.env.CI,
      platform: process.platform,
    }),
    {
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CATAMORPHIC_E2E_DATA_DIR: userDataDir,
        // Hidden is the interruption-free default. The visible command
        // overrides this for suites that exercise native window semantics.
        CATAMORPHIC_E2E_WINDOW_MODE:
          process.env.CATAMORPHIC_E2E_WINDOW_MODE ?? "hidden",
        // Deterministic fake agent by default. Eval-style tests opt out by
        // passing CATAMORPHIC_E2E_FAKE_AGENT: "" (or "0") in opts.env — the
        // spread below wins, and every main-process check treats anything
        // but "1" as off (boot.ts, ipc.ts, harness-models.ts).
        CATAMORPHIC_E2E_FAKE_AGENT: "1",
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (process.env.CI === "true") process.stdout.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (process.env.CI === "true") process.stderr.write(text);
  });

  try {
    const ws = await connectCdp(child, port);
    const client = await createClient(ws);
    // The renderer boots before the embedded server; wait for the API.
    await client.waitFor(
      "window.catamorphicDesktop && window.catamorphicDesktop.getServerState().then(s=>!!s.url)",
      { timeoutMs: 60_000, label: "embedded server ready" },
    );
    // App iframes with an opaque origin render out of process; their CDP
    // targets appear on the same /json endpoint as the page. Attach a
    // dedicated WebSocket so tests can evaluate inside the frame.
    const connectToFrame = async (
      urlSubstring: string,
      frameOpts: { timeoutMs?: number } = {},
    ): Promise<FrameHandle> => {
      const deadline = Date.now() + (frameOpts.timeoutMs ?? 30_000);
      let seen = "";
      while (Date.now() < deadline) {
        try {
          const targets = (await fetch(`http://127.0.0.1:${port}/json`).then(
            (response) => response.json(),
          )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
          seen = targets
            .map((target) => `${target.type} ${target.url}`)
            .join("\n");
          const frame = targets.find((target) =>
            target.url.includes(urlSubstring),
          );
          if (frame) {
            const frameWs = new WebSocket(frame.webSocketDebuggerUrl);
            await new Promise<void>((resolve, reject) => {
              frameWs.addEventListener("open", () => resolve(), {
                once: true,
              });
              frameWs.addEventListener("error", (event) => reject(event), {
                once: true,
              });
            });
            const frameClient = await createClient(frameWs, { page: false });
            return {
              eval: frameClient.eval,
              waitFor: frameClient.waitFor,
              close: () => frameWs.close(),
            };
          }
        } catch {
          // /json can 404 transiently while targets churn; keep polling.
        }
        await sleep(500);
      }
      throw new Error(
        `No CDP target matching "${urlSubstring}" within ${
          frameOpts.timeoutMs ?? 30_000
        }ms.\n--- targets ---\n${seen}`,
      );
    };

    return {
      ...client,
      connectToFrame,
      getOutput: () => output,
      userDataDir,
      stop: async () => {
        ws.close();
        await terminate(child);
        fs.rmSync(userDataDir, { recursive: true, force: true });
      },
      kill: async () => {
        ws.close();
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
          });
        }
      },
    };
  } catch (error) {
    await terminate(child);
    throw new Error(
      `Failed to launch the app for e2e: ${String(error)}\n--- app output ---\n${output.slice(-4000)}`,
    );
  }
}

async function connectCdp(
  child: ChildProcess,
  port: number,
): Promise<WebSocket> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited early with code ${child.exitCode}`);
    }
    try {
      const targets = (await fetch(`http://127.0.0.1:${port}/json`).then(
        (response) => response.json(),
      )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      // The app window is the only "page" target that isn't a webview guest.
      const page = targets.find((target) => target.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", (event) => reject(event), {
            once: true,
          });
        });
        return ws;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`CDP never became reachable: ${String(lastError)}`);
}

async function createClient(ws: WebSocket, opts: { page?: boolean } = {}) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const send = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  await send("Runtime.enable");
  // Frame targets only need Runtime; Page powers the window screenshot.
  if (opts.page !== false) await send("Page.enable");

  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = (await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result: { value?: T };
      exceptionDetails?: { exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          "Evaluation threw in the page",
      );
    }
    return result.result.value as T;
  };

  const waitFor = async <T>(
    expression: string,
    opts?: { timeoutMs?: number; label?: string },
  ): Promise<T> => {
    const timeoutMs = opts?.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last as T;
      await sleep(200);
    }
    throw new Error(
      `Timed out (${timeoutMs}ms) waiting for ${opts?.label ?? expression}; last value: ${JSON.stringify(last)}`,
    );
  };

  const screenshot = async (filePath: string): Promise<void> => {
    const result = (await send("Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  };

  const press = async (key: KeyName, modifiers = 0): Promise<void> => {
    const params = { key, modifiers, ...KEY_CODES[key] };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  };

  return { eval: evaluate, waitFor, screenshot, press };
}

export type KeyName = keyof typeof KEY_CODES;

const KEY_CODES = {
  Enter: { windowsVirtualKeyCode: 13, code: "Enter", text: "\r" },
  Backspace: { windowsVirtualKeyCode: 8, code: "Backspace" },
  Delete: { windowsVirtualKeyCode: 46, code: "Delete" },
  Escape: { windowsVirtualKeyCode: 27, code: "Escape" },
  Tab: { windowsVirtualKeyCode: 9, code: "Tab" },
  ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp" },
  ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown" },
  ArrowLeft: { windowsVirtualKeyCode: 37, code: "ArrowLeft" },
  ArrowRight: { windowsVirtualKeyCode: 39, code: "ArrowRight" },
} as const;

/**
 * Page-side helper source for suite `helpers` strings: set a field's value
 * through the setter React instruments. The chat composer is a
 * contenteditable (inline pills), so that branch keeps [data-pill-id]
 * children, sets the text, and lets the input handler read the DOM back.
 */
export const setReactValueJs = `const setReactValue = (el, value) => {
    if (el.isContentEditable) {
      const pills = [...el.querySelectorAll('[data-pill-id]')];
      el.replaceChildren(...pills, document.createTextNode(value));
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return;
    }
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(
      el instanceof HTMLSelectElement ? 'change' : 'input',
      { bubbles: true },
    ));
  };`;

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const timeout = sleep(5000).then(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await Promise.race([exited, timeout]);
  await exited;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
