import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export interface AppHandle {
  /** Evaluate JS in the app window; resolves the JSON-serialized result. */
  eval: <T = unknown>(expression: string) => Promise<T>;
  /** Wait until `expression` evaluates truthy (500ms poll, throws on timeout). */
  waitFor: <T = unknown>(
    expression: string,
    opts?: { timeoutMs?: number; label?: string },
  ) => Promise<T>;
  screenshot: (filePath: string) => Promise<void>;
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
  const port = cdpPort();
  const child = spawn(
    electronBinary,
    [".", `--remote-debugging-port=${port}`],
    {
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CATAMORPHIC_E2E_DATA_DIR: userDataDir,
        CATAMORPHIC_E2E_FAKE_AGENT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  try {
    const ws = await connectCdp(child, port);
    const client = await createClient(ws);
    // The renderer boots before the embedded server; wait for the API.
    await client.waitFor(
      "window.catamorphicDesktop && window.catamorphicDesktop.getServerState().then(s=>!!s.url)",
      { timeoutMs: 60_000, label: "embedded server ready" },
    );
    return {
      ...client,
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

  return { eval: evaluate, waitFor, screenshot };
}

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
