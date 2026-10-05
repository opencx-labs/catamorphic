import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agentToolResult } from "@catamorphic/sandbox";
import { type WebContents, webContents } from "electron";
import { z } from "zod";
import { BROWSER_GUEST } from "./browser-guest.js";
import { consoleLogOf, downloadLogOf } from "./browser-tab-records.js";

export type BrowserAction =
  | { type: "click" | "hover"; uid: string }
  | { type: "click" | "hover"; x: number; y: number }
  | { type: "drag"; x: number; y: number; toX: number; toY: number }
  | { type: "fill" | "select"; uid: string; text: string }
  | { type: "press"; key: string }
  | { type: "navigate"; url: string }
  | { type: "read" }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "wait_for"; text: string; timeoutMs?: number }
  | {
      type: "upload";
      uid: string;
      files: string[];
      /** The agent's own folder, from which any file may go. */
      workingDirectory?: string;
    }
  | { type: "evaluate"; expression: string }
  | { type: "console" }
  | { type: "network" }
  | { type: "downloads"; timeoutMs?: number };

/** One request the page made, as an agent reads it. */
interface NetworkEntry {
  method: string;
  url: string;
  type: string;
  status: number | null;
  failure?: string;
}

const NETWORK_KEPT = 300;
const EVALUATE_RESULT_LIMIT = 20_000;
const EVALUATE_MS = 30_000;
const FILE_CHOOSER_MS = 6000;

/**
 * A file an agent may hand a page: anything in its own folder, otherwise
 * what a person sees in Finder, never a hidden file or folder or anything
 * in ~/Library, where keys, tokens and keychains live (.ssh, .aws, .env).
 * Page text is untrusted; it must not talk an agent into uploading those.
 */
export async function uploadable(
  file: string,
  workingDirectory: string | undefined,
): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error(`Give an absolute path: ${file}`);
  const real = await realpath(file).catch(() => null);
  if (!real || !(await stat(real)).isFile())
    throw new Error(`Not a file: ${file}`);
  const inside = (root: string) => {
    const relative = path.relative(root, real);
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  };
  if (workingDirectory) {
    const root = await realpath(workingDirectory).catch(() => workingDirectory);
    if (inside(root)) return real;
  }
  const hidden = real.split(path.sep).some((part) => part.startsWith("."));
  if (hidden || inside(path.join(os.homedir(), "Library")))
    throw new Error(
      `Uploading ${file} is refused: hidden files and folders and ~/Library hold keys and tokens. Ask the person to choose it in the page themselves.`,
    );
  return real;
}

export function browserUrl(url: string): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Browser navigation requires an http(s) URL.");
  return parsed.href;
}

const pointSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
const keyCodes: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Space: 32,
};

/** One serialized driver per guest. Native input never focuses the host window. */
export class BrowserDriver {
  private queue: Promise<unknown> = Promise.resolve();
  /** Requests and downloads, recorded from the agent's first look or action. */
  private watching = false;
  private network: NetworkEntry[] = [];
  private requests = new Map<string, NetworkEntry>();
  /** Finished requests an agent has read; pending ones come again. */
  private networkRead = new WeakSet<NetworkEntry>();
  private networkDropped = 0;
  constructor(
    private guest: WebContents,
    private guard: () => void,
    private activity: (active: boolean) => Promise<void>,
  ) {}

  /**
   * Start recording the page's requests over the driver's debugger. Only
   * for tabs an agent drives: a page the person merely shows in a chat's
   * context is never instrumented. Bodies are never kept.
   */
  private watch(): void {
    if (this.watching || this.guest.isDestroyed()) return;
    const guest = this.guest;
    this.attach();
    this.watching = true;
    const onMessage = (
      _event: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const id = typeof params?.requestId === "string" ? params.requestId : "";
      if (method === "Network.requestWillBeSent") {
        // A redirect reuses the request's id: its hop ends here.
        const hop = this.requests.get(id);
        const redirect = params.redirectResponse as
          | { status?: number }
          | undefined;
        if (hop && redirect) hop.status = Number(redirect.status ?? 0) || null;
        const request = params.request as { method?: string; url?: string };
        const entry: NetworkEntry = {
          method: String(request?.method ?? "GET"),
          url: String(request?.url ?? "").slice(0, 500),
          type: String(params.type ?? "Other"),
          status: null,
        };
        this.requests.set(id, entry);
        this.network.push(entry);
        if (this.network.length > NETWORK_KEPT) {
          const gone = this.network.shift();
          if (gone && !this.networkRead.has(gone)) this.networkDropped += 1;
          for (const [key, value] of this.requests)
            if (value === gone) this.requests.delete(key);
        }
      } else if (method === "Network.responseReceived") {
        const entry = this.requests.get(id);
        const response = params.response as { status?: number };
        if (entry) entry.status = Number(response?.status ?? 0) || null;
      } else if (method === "Network.loadingFailed") {
        const entry = this.requests.get(id);
        if (entry)
          entry.failure = params.canceled
            ? "canceled"
            : String(params.errorText ?? "failed");
        this.requests.delete(id);
      } else if (method === "Network.loadingFinished") {
        this.requests.delete(id);
      }
    };
    guest.debugger.on("message", onMessage);
    // A detached debugger (a crashed page, another client) records nothing
    // more; the next look or action attaches and records again.
    guest.debugger.once("detach", () => {
      guest.debugger.off("message", onMessage);
      this.watching = false;
    });
    void guest.debugger
      .sendCommand("Network.enable", {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
      })
      .catch(() => {});
  }

  private attach(): void {
    if (!this.guest.debugger.isAttached()) this.guest.debugger.attach("1.3");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.activity(true);
      const focused =
        webContents.getFocusedWebContents() ?? this.guest.hostWebContents;
      try {
        if (this.guest.isDestroyed())
          throw new Error("Browser tab was closed.");
        this.guest.focus();
        return await operation();
      } finally {
        try {
          if (focused && !focused.isDestroyed()) focused.focus();
        } finally {
          await this.activity(false);
        }
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  private async evaluate(
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    if (this.guest.isDestroyed()) throw new Error("Browser tab was closed.");
    const result = await this.guest.executeJavaScriptInIsolatedWorld(1004, [
      {
        code: `(() => { try { ${BROWSER_GUEST} return {value:globalThis.catamorphicBrowser[${JSON.stringify(method)}](...${JSON.stringify(args)})}; } catch(error) { return {failure: String(error)}; } })()`,
      },
    ]);
    const parsed = z
      .object({ value: z.unknown().optional(), failure: z.string().optional() })
      .parse(result);
    if (parsed.failure) throw new Error(parsed.failure);
    return parsed.value;
  }

  private async input(
    method: string,
    params: Record<string, unknown>,
    release = false,
  ): Promise<void> {
    if (!release) this.guard();
    this.attach();
    if (method.startsWith("Input."))
      await this.guest.debugger.sendCommand(
        "Emulation.setFocusEmulationEnabled",
        { enabled: true },
      );
    await this.guest.debugger.sendCommand(method, params);
  }

  snapshot(format: "dom" | "image" = "dom"): Promise<unknown> {
    return this.serial(async () => {
      this.watch();
      if (format === "dom") return this.evaluate("snapshot");
      const viewport = viewportSchema.parse(await this.evaluate("viewport"));
      const image = await this.guest.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      if (image.isEmpty())
        throw new Error(
          "Page image is not ready. Wait for the page to render.",
        );
      const width = Math.min(Math.round(viewport.width), 1600);
      const scaled = image.resize({ width });
      const size = scaled.getSize();
      return agentToolResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              url: this.guest.getURL(),
              viewport,
              image: size,
              coordinateSpace:
                "CSS viewport pixels; scale screenshot coordinates by viewport.width / image.width.",
            }),
          },
          {
            type: "image",
            mimeType: "image/png",
            data: scaled.toPNG().toString("base64"),
          },
        ],
      });
    });
  }

  read(): Promise<unknown> {
    return this.serial(() => this.evaluate("read"));
  }
  /**
   * A passive look at the page for per-turn context: title, description,
   * selection, and the start of the main text. Unlike read(), it neither
   * focuses the tab nor shows agent activity, and never queues behind an
   * agent's browser work.
   */
  glance(limit: number): Promise<unknown> {
    return this.evaluate("glance", [limit]);
  }
  clear(): Promise<unknown> {
    return this.serial(() => this.evaluate("clear"));
  }
  point(
    uid: string,
    note: string | undefined,
    keepPrevious: boolean,
  ): Promise<unknown> {
    return this.serial(() => {
      this.guard();
      return this.evaluate("point", [uid, note, keepPrevious]);
    });
  }

  private async coordinates(point: {
    x: number;
    y: number;
  }): Promise<{ x: number; y: number }> {
    const { width, height } = viewportSchema.parse(
      await this.evaluate("viewport"),
    );
    if (
      ![point.x, point.y].every(Number.isFinite) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= width ||
      point.y >= height
    )
      throw new Error(
        "Coordinates are outside the CSS viewport. Take a fresh image snapshot.",
      );
    return { x: point.x, y: point.y };
  }

  private async pointer(
    point: { x: number; y: number },
    click: boolean,
  ): Promise<void> {
    const position = await this.coordinates(point);
    await this.input("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...position,
    });
    if (!click) return;
    await this.input("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...position,
    });
    try {
      this.guard();
    } finally {
      await this.input(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", button: "left", clickCount: 1, ...position },
        true,
      );
    }
  }

  private async press(key: string): Promise<void> {
    const parts = key.split("+");
    const raw = parts.pop() ?? "";
    if (!Object.hasOwn(keyCodes, raw) && !/^[a-z0-9]$/i.test(raw))
      throw new Error(
        `Unsupported key: ${key}. Use ${Object.keys(keyCodes).join(", ")} or one letter or digit, with Alt, Control, Meta or Shift and "+"; use fill to insert text.`,
      );
    this.guard();
    const electronModifiers = parts
      .map(
        (part) =>
          (
            ({
              Alt: "alt",
              Control: "control",
              Ctrl: "control",
              Meta: "meta",
              Command: "meta",
              Shift: "shift",
            }) as const
          )[part],
      )
      .map((part) => {
        if (part === undefined) throw new Error("Unknown key modifier");
        return part;
      });
    this.guest.sendInputEvent({
      type: "keyDown",
      keyCode:
        {
          ArrowLeft: "Left",
          ArrowRight: "Right",
          ArrowUp: "Up",
          ArrowDown: "Down",
        }[raw] ?? raw,
      modifiers: electronModifiers,
    });
    this.guest.sendInputEvent({
      type: "keyUp",
      keyCode:
        {
          ArrowLeft: "Left",
          ArrowRight: "Right",
          ArrowUp: "Up",
          ArrowDown: "Down",
        }[raw] ?? raw,
      modifiers: electronModifiers,
    });
  }

  /**
   * Choose files in the page's own file chooser: click what opens it (a
   * file input or the button a page puts over its hidden one) and answer
   * the chooser instead of showing the person a native dialog.
   */
  private async upload(
    uid: string,
    requested: string[],
    workingDirectory: string | undefined,
  ): Promise<unknown> {
    if (requested.length === 0) throw new Error("upload needs files.");
    const files: string[] = [];
    for (const file of requested)
      files.push(await uploadable(file, workingDirectory));
    this.attach();
    const debug = this.guest.debugger;
    await debug.sendCommand("Page.enable");
    await debug.sendCommand("Page.setInterceptFileChooserDialog", {
      enabled: true,
    });
    let stop = () => {};
    let startTimer = () => {};
    const opened = new Promise<{ backendNodeId: number; mode: string }>(
      (resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const onMessage = (
          _event: unknown,
          method: string,
          params: Record<string, unknown>,
        ) => {
          if (method !== "Page.fileChooserOpened") return;
          stop();
          resolve({
            backendNodeId: Number(params.backendNodeId),
            mode: String(params.mode),
          });
        };
        // The page may open its chooser a moment after the click, within
        // the click's user activation.
        startTimer = () => {
          timer = setTimeout(() => {
            stop();
            reject(
              new Error(
                "No file chooser opened. Use the uid of the file input or of the button that opens it.",
              ),
            );
          }, FILE_CHOOSER_MS);
        };
        stop = () => {
          clearTimeout(timer);
          debug.off("message", onMessage);
        };
        debug.on("message", onMessage);
      },
    );
    opened.catch(() => {});
    try {
      const point = pointSchema.parse(await this.evaluate("prepare", [uid]));
      await this.pointer(point, true);
      startTimer();
      const chooser = await opened;
      if (chooser.mode === "selectSingle" && files.length > 1)
        throw new Error("This file input takes one file.");
      this.guard();
      await debug.sendCommand("DOM.setFileInputFiles", {
        files,
        backendNodeId: chooser.backendNodeId,
      });
      return { ok: true, files: files.map((file) => path.basename(file)) };
    } finally {
      stop();
      await debug
        .sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => {});
    }
  }

  /**
   * Run JavaScript in the page; its value comes back as JSON. It runs
   * without a user gesture, so it cannot open dialogs or popups, and a
   * promise that never settles gives up instead of holding the tab.
   */
  private async evaluateInPage(expression: string): Promise<unknown> {
    this.attach();
    let timer: NodeJS.Timeout | undefined;
    const reply = await Promise.race([
      this.guest.debugger.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
        timeout: 10_000,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `The expression did not finish within ${EVALUATE_MS / 1000} seconds.`,
              ),
            ),
          EVALUATE_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const result = z
      .object({
        result: z
          .object({
            value: z.unknown().optional(),
            unserializableValue: z.string().optional(),
            type: z.string(),
          })
          .optional(),
        exceptionDetails: z
          .object({
            text: z.string().optional(),
            exception: z
              .object({ description: z.string().optional() })
              .optional(),
          })
          .optional(),
      })
      .parse(reply);
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "The expression threw.",
      );
    // NaN, Infinity, -0 and bigints have no JSON form; they come as text.
    if (result.result?.unserializableValue !== undefined)
      return {
        value: result.result.unserializableValue,
        type: result.result.type,
      };
    const value = result.result?.value;
    const text = JSON.stringify(value ?? null);
    return text.length > EVALUATE_RESULT_LIMIT
      ? {
          truncated: true,
          json: `${text.slice(0, EVALUATE_RESULT_LIMIT)}…`,
        }
      : { value: value ?? null, type: result.result?.type ?? "undefined" };
  }

  /**
   * Requests not read yet, oldest first. A finished one is read once; one
   * still pending (status null) comes again until it finishes.
   */
  private takeNetwork(): unknown {
    const requests = this.network.filter(
      (entry) => !this.networkRead.has(entry),
    );
    for (const entry of requests)
      if (entry.status !== null || entry.failure) this.networkRead.add(entry);
    const dropped = this.networkDropped;
    this.networkDropped = 0;
    return {
      requests: requests.map((entry) => ({ ...entry })),
      ...(dropped ? { dropped } : {}),
      note: "Requests since you started driving this tab or last read them; navigate again to see a page load from its start.",
    };
  }

  /**
   * What the page logged, requested and downloaded. Reading neither touches
   * the page nor queues behind (or holds up) the agent's input to it.
   */
  private inspect(
    action: Extract<
      BrowserAction,
      { type: "console" | "network" | "downloads" }
    >,
  ): Promise<unknown> {
    if (this.guest.isDestroyed())
      return Promise.reject(new Error("Browser tab was closed."));
    this.watch();
    switch (action.type) {
      case "console":
        return Promise.resolve(
          consoleLogOf(this.guest)?.takeNew() ?? { messages: [], dropped: 0 },
        );
      case "network":
        return Promise.resolve(this.takeNetwork());
      case "downloads": {
        const timeout = action.timeoutMs ?? 0;
        if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600_000)
          return Promise.reject(
            new Error("timeoutMs must be between 0 and 600000."),
          );
        return downloadLogOf(this.guest).take(timeout);
      }
    }
  }

  act(action: BrowserAction): Promise<unknown> {
    if (
      action.type === "console" ||
      action.type === "network" ||
      action.type === "downloads"
    )
      return this.inspect(action);
    return this.serial(async () => {
      this.guard();
      this.watch();
      try {
        switch (action.type) {
          // Awaited, so the focus emulation is turned off after them.
          case "upload":
            return await this.upload(
              action.uid,
              action.files,
              action.workingDirectory,
            );
          case "evaluate":
            return await this.evaluateInPage(action.expression);
          case "read":
            return await this.evaluate("read");
          case "navigate":
            await this.guest.loadURL(browserUrl(action.url));
            return { ok: true, url: this.guest.getURL() };
          case "click":
          case "hover": {
            const point =
              "uid" in action
                ? pointSchema.parse(
                    await this.evaluate("prepare", [action.uid]),
                  )
                : action;
            await this.pointer(point, action.type === "click");
            break;
          }
          case "fill":
            await this.evaluate("prepare", [action.uid, true]);
            this.guest.selectAll();
            this.guard();
            // Chromium performs replacement and emits genuine editing events.
            if (action.text === "") await this.press("Backspace");
            else await this.guest.insertText(action.text);
            break;
          case "select":
            this.guard();
            return await this.evaluate("select", [action.uid, action.text]);
          case "press":
            await this.press(action.key);
            break;
          case "scroll": {
            const { width, height } = viewportSchema.parse(
              await this.evaluate("viewport"),
            );
            await this.input("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: width / 2,
              y: height / 2,
              deltaX: 0,
              deltaY: height * (action.direction === "up" ? -0.8 : 0.8),
            });
            break;
          }
          case "drag": {
            const from = await this.coordinates(action);
            const to = await this.coordinates({ x: action.toX, y: action.toY });
            await this.input("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: from.x,
              y: from.y,
            });
            await this.input("Input.dispatchMouseEvent", {
              type: "mousePressed",
              button: "left",
              buttons: 1,
              clickCount: 1,
              x: from.x,
              y: from.y,
            });
            try {
              for (let step = 1; step <= 8; step++)
                await this.input("Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  button: "left",
                  buttons: 1,
                  x: from.x + ((to.x - from.x) * step) / 8,
                  y: from.y + ((to.y - from.y) * step) / 8,
                });
            } finally {
              await this.input(
                "Input.dispatchMouseEvent",
                { type: "mouseReleased", button: "left", clickCount: 1, ...to },
                true,
              );
            }
            break;
          }
          case "wait_for": {
            const timeout = action.timeoutMs ?? 5000;
            if (!Number.isFinite(timeout) || timeout < 1 || timeout > 10000)
              throw new Error("timeoutMs must be between 1 and 10000.");
            const deadline = Date.now() + timeout;
            const generation = await this.evaluate("generation");
            do {
              this.guard();
              if (
                this.guest.isDestroyed() ||
                (await this.evaluate("generation")) !== generation
              )
                throw new Error(
                  "Page changed while waiting. Take a fresh snapshot.",
                );
              const page = z
                .object({ text: z.string() })
                .parse(await this.evaluate("read"));
              if (page.text.includes(action.text)) return { found: true };
              await delay(Math.min(100, Math.max(0, deadline - Date.now())));
            } while (Date.now() < deadline);
            return { found: false };
          }
        }
        return { ok: true };
      } finally {
        if (!this.guest.isDestroyed() && this.guest.debugger.isAttached())
          await this.guest.debugger
            .sendCommand("Emulation.setFocusEmulationEnabled", {
              enabled: false,
            })
            .catch(() => {});
      }
    });
  }
}
