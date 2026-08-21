import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Pwa e2e harness: starts the fake Catamorphic server
 * (scripts/dev-server.mjs), serves the built app (vite preview), launches
 * headless Chrome with phone-ish metrics, and exposes the same minimal CDP
 * client as the desktop harness (eval/waitFor/screenshot). Node built-ins
 * only.
 */

const APP_DIR = path.resolve(import.meta.dirname, "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((candidate): candidate is string => Boolean(candidate));

export function chromeBinary(): string | null {
  return (
    CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("No port")));
      }
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`Never reachable: ${url} (${String(lastError)})`);
}

export interface PwaHandle {
  eval: <T = unknown>(expression: string) => Promise<T>;
  waitFor: <T = unknown>(
    expression: string,
    opts?: { timeoutMs?: number; label?: string },
  ) => Promise<T>;
  screenshot: (filePath: string) => Promise<void>;
  /** The fake server's API base ("http://127.0.0.1:<port>/api"). */
  apiBase: string;
  /** A redeemable connect link against the fake server. */
  connectLink: string;
  stop: () => Promise<void>;
}

export async function launchPwa(
  opts: {
    env?: Record<string, string>;
    /**
     * Backend to spawn (given the API port). Default: the scripted fake
     * (scripts/dev-server.mjs). The stock-server suite passes the real
     * apps/server here.
     */
    backend?: (apiPort: number) => {
      command: string;
      args: string[];
      cwd: string;
      env?: Record<string, string | undefined>;
    };
    /** Redeemable connect link for the suite; default: the fake's invite. */
    mintLink?: (apiBase: string) => Promise<string>;
  } = {},
): Promise<PwaHandle> {
  const chrome = chromeBinary();
  if (!chrome) throw new Error("No Chrome/Chromium binary found for e2e.");

  const apiPort = await freePort();
  const backend = opts.backend?.(apiPort) ?? {
    command: "node",
    args: ["scripts/dev-server.mjs"],
    cwd: APP_DIR,
    env: { PORT: String(apiPort), ...opts.env },
  };
  const server = spawn(backend.command, backend.args, {
    cwd: backend.cwd,
    env: { ...process.env, ...backend.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const previewPort = await freePort();
  const preview = spawn(
    "bun",
    [
      "x",
      "vite",
      "preview",
      // Explicit v4 loopback: the default binds ::1 only, and Chrome is
      // pointed at 127.0.0.1.
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  for (const child of [server, preview]) {
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  }

  const cdpPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwa-e2e-chrome-"));
  const appUrl = `http://127.0.0.1:${previewPort}/`;
  const chromeChild = spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=390,844",
      appUrl,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  chromeChild.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const children = [server, preview, chromeChild];
  const stopAll = async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    await sleep(300);
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  };

  try {
    const apiBase = `http://127.0.0.1:${apiPort}/api`;
    // Slow backends (the stock server boots PGlite + migrations) get a
    // generous window; the poll accepts any HTTP answer, 401 included.
    await waitForHttp(`${apiBase}/me`, 90_000);
    const connectLink =
      (await opts.mintLink?.(apiBase)) ??
      `catamorphic://connect?server=${encodeURIComponent(apiBase)}&token=invite-token&project=11111111-1111-4111-8111-111111111111&name=Acme%20Brain`;
    const ws = await connectCdp(chromeChild, cdpPort, appUrl);
    const client = await createClient(ws);
    // Phone-ish metrics so layout and touch affordances match the target.
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await client.waitFor("!!document.querySelector('[data-testid=screen]')", {
      timeoutMs: 20_000,
      label: "app shell rendered",
    });
    return {
      eval: client.eval,
      waitFor: client.waitFor,
      screenshot: client.screenshot,
      apiBase,
      connectLink,
      stop: async () => {
        ws.close();
        await stopAll();
      },
    };
  } catch (error) {
    await stopAll();
    throw new Error(
      `Failed to launch pwa e2e: ${String(error)}\n--- output ---\n${output.slice(-4000)}`,
    );
  }
}

async function connectCdp(
  child: ChildProcess,
  port: number,
  urlSubstring: string,
): Promise<WebSocket> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited early with code ${child.exitCode}`);
    }
    try {
      const targets = (await fetch(`http://127.0.0.1:${port}/json`).then(
        (response) => response.json(),
      )) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      const page = targets.find(
        (target) =>
          target.type === "page" && target.url.startsWith(urlSubstring),
      );
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

async function createClient(ws: WebSocket) {
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
  await send("Page.enable");

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

  return { eval: evaluate, waitFor, screenshot, send };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
