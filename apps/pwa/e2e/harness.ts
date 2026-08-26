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

export function chromeLaunchArgs({
  ci,
  platform,
}: {
  ci: string | undefined;
  platform: NodeJS.Platform;
}): string[] {
  return [
    "--remote-debugging-address=127.0.0.1",
    ...(ci === "true" && platform === "linux" ? ["--no-sandbox"] : []),
  ];
}

export function chromeCdpStartupTimeoutMs(ci: string | undefined): number {
  return ci === "true" ? 30_000 : 15_000;
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

interface WatchedChild {
  process: ChildProcess;
  failure: Promise<never>;
}

class ChildProcessFailure extends Error {}

export function watchChild(
  child: ChildProcess,
  label: string,
  onOutput: (chunk: string) => void,
): WatchedChild {
  child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => onOutput(chunk.toString()));
  const failure = new Promise<never>((_resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new ChildProcessFailure(`${label} failed to start: ${error.message}`),
      );
    });
    child.once("exit", (code, signal) => {
      reject(
        new ChildProcessFailure(
          `${label} exited early${code === null ? "" : ` with code ${code}`}${signal ? ` from ${signal}` : ""}`,
        ),
      );
    });
  });
  // A child can exit during normal teardown after no startup operation is
  // awaiting it. Keep that expected rejection observed.
  void failure.catch(() => {});
  return { process: child, failure };
}

export async function waitForHttp(
  url: string,
  options: {
    timeoutMs: number;
    requestTimeoutMs?: number;
    childFailure: Promise<never>;
    fetchRequest?: typeof fetch;
  },
): Promise<void> {
  const {
    timeoutMs,
    requestTimeoutMs = 1_000,
    childFailure,
    fetchRequest = fetch,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      await Promise.race([
        fetchRequest(url, {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(requestTimeoutMs, remaining)),
          ),
        }),
        childFailure,
      ]);
      return;
    } catch (error) {
      if (error instanceof ChildProcessFailure) throw error;
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
  installabilityErrors: () => Promise<
    Array<{ errorId: string; errorArguments: unknown[] }>
  >;
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
    /** Loopback is trustworthy in Chrome; false exercises phone-like LAN HTTP. */
    secureContext?: boolean;
    /** Keep this below the caller's beforeAll timeout so cleanup always runs. */
    backendTimeoutMs?: number;
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
  let output = "";
  const children: WatchedChild[] = [];
  let profileDir: string | null = null;
  let browserDiagnostics = "";
  const stopAll = async () => {
    await Promise.all(children.map((child) => stopChild(child.process)));
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  };

  try {
    const server = watchChild(
      spawn(backend.command, backend.args, {
        cwd: backend.cwd,
        env: { ...process.env, ...backend.env },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      "Backend",
      (chunk) => {
        output += chunk;
      },
    );
    children.push(server);
    const previewPort = await freePort();
    const preview = watchChild(
      spawn(
        "bun",
        [
          "--bun",
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
      ),
      "Vite preview",
      (chunk) => {
        output += chunk;
      },
    );
    children.push(preview);
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwa-e2e-chrome-"));
    const appHost = opts.secureContext ? "127.0.0.1" : "catamorphic-pwa.test";
    const appUrl = `http://${appHost}:${previewPort}/`;
    const previewHealthUrl = `http://127.0.0.1:${previewPort}/`;
    const apiBase = `http://127.0.0.1:${apiPort}/api`;
    // Slow backends (the stock server boots PGlite + migrations) get a
    // generous window; the poll accepts any HTTP answer, 401 included.
    await waitForHttp(`${apiBase}/me`, {
      timeoutMs: opts.backendTimeoutMs ?? 30_000,
      childFailure: server.failure,
    });
    const connectLink =
      (await opts.mintLink?.(apiBase)) ??
      `catamorphic://connect?server=${encodeURIComponent(apiBase)}&project=11111111-1111-4111-8111-111111111111&name=Acme%20Brain`;
    // Do not give Chrome a one-shot navigation before Vite is listening.
    // Chrome keeps its network error page open instead of retrying, which
    // used to make a healthy built PWA look like a blank-screen regression.
    await waitForHttp(previewHealthUrl, {
      timeoutMs: 10_000,
      childFailure: preview.failure,
    });
    // Allocate CDP only after the backend and preview have bound their ports.
    // Otherwise either still-starting child can race this probe, claim the
    // same port, and make Chrome fall back to an IPv6-only DevTools listener.
    const cdpPort = await freePort();
    const chromeChild = watchChild(
      spawn(
        chrome,
        [
          "--headless=new",
          `--remote-debugging-port=${cdpPort}`,
          `--user-data-dir=${profileDir}`,
          ...chromeLaunchArgs({
            ci: process.env.CI,
            platform: process.platform,
          }),
          "--no-first-run",
          "--no-default-browser-check",
          "--window-size=390,844",
          ...(opts.secureContext
            ? []
            : ["--host-resolver-rules=MAP catamorphic-pwa.test 127.0.0.1"]),
          appUrl,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
      "Chrome",
      (chunk) => {
        output += chunk;
      },
    );
    children.push(chromeChild);
    const ws = await connectCdp(
      chromeChild,
      cdpPort,
      appUrl,
      chromeCdpStartupTimeoutMs(process.env.CI),
    );
    const client = await createClient(ws, (diagnostic) => {
      browserDiagnostics += `${diagnostic}\n`;
    });
    // Phone-ish metrics so layout and touch affordances match the target.
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await client.waitFor("!!document.querySelector('[data-testid=screen]')", {
      timeoutMs: 10_000,
      label: "app shell rendered",
    });
    return {
      eval: client.eval,
      waitFor: client.waitFor,
      screenshot: client.screenshot,
      installabilityErrors: async () => {
        const result = (await client.send("Page.getInstallabilityErrors")) as {
          installabilityErrors: Array<{
            errorId: string;
            errorArguments: unknown[];
          }>;
        };
        return result.installabilityErrors;
      },
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
      `Failed to launch pwa e2e: ${String(error)}\n--- browser ---\n${browserDiagnostics.slice(-4000)}\n--- output ---\n${output.slice(-4000)}`,
    );
  }
}

async function connectCdp(
  child: WatchedChild,
  port: number,
  urlSubstring: string,
  timeoutMs: number,
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const targets = (await Promise.race([
        fetch(`http://127.0.0.1:${port}/json`, {
          signal: AbortSignal.timeout(1_000),
        }).then((response) => response.json()),
        child.failure,
      ])) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      const page = targets.find(
        (target) =>
          target.type === "page" && target.url.startsWith(urlSubstring),
      );
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", (event) => reject(event), {
              once: true,
            });
          }),
          5_000,
          "CDP WebSocket open",
        );
        return ws;
      }
    } catch (error) {
      if (error instanceof ChildProcessFailure) throw error;
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`CDP never became reachable: ${String(lastError)}`);
}

async function createClient(
  ws: WebSocket,
  onDiagnostic: (message: string) => void,
) {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message: string };
      params?: {
        exceptionDetails?: {
          text: string;
          exception?: { description?: string };
        };
        type?: string;
        args?: Array<{ value?: unknown; description?: string }>;
      };
    };
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      onDiagnostic(details?.exception?.description ?? details?.text ?? "Error");
    }
    if (message.method === "Runtime.consoleAPICalled") {
      const args = message.params?.args
        ?.map((arg) => arg.description ?? String(arg.value ?? ""))
        .join(" ");
      onDiagnostic(`${message.params?.type ?? "console"}: ${args ?? ""}`);
    }
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
    return withTimeout(
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      }),
      10_000,
      `CDP ${method}`,
    );
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

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([stopped, sleep(300)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([stopped, sleep(2_000)]);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
