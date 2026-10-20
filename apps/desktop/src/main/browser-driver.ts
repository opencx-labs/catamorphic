import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { agentToolResult } from "@catamorphic/sandbox";
import { BrowserWindow, type WebContents, webContents } from "electron";
import { z } from "zod";
import { type PageDialog, pageDialogAsker } from "../shared/page-dialogs.js";
import { PAGE_DIALOG_MESSAGE_LIMIT } from "../shared/script-dialogs.js";
import { noteUnloadIntent, pageDialogs } from "./browser-dialogs.js";
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

/** A prompt's field, as an agent fills it (`fill` with this uid). */
export const DIALOG_FIELD_UID = "dialog";

/**
 * A dialog the page waits on, as an agent reads it. A page blocked on its
 * dialog runs nothing else, so the driver reports it instead of reading
 * the page, and the agent answers it (never a sign-in: that is the
 * person's).
 */
export function dialogReport(
  dialog: PageDialog,
  page: { url: string; title: string },
): Record<string, unknown> {
  const asked =
    dialog.kind === "auth"
      ? {
          kind: dialog.kind,
          origin: dialog.origin,
          ...(dialog.auth?.realm ? { realm: dialog.auth.realm } : {}),
          ...(dialog.auth?.proxy ? { proxy: true } : {}),
        }
      : dialog.kind === "beforeunload"
        ? { kind: dialog.kind, origin: dialog.origin, reload: dialog.reload }
        : {
            kind: dialog.kind,
            origin: dialog.origin,
            asker: pageDialogAsker(dialog),
            message: dialog.message,
            ...(dialog.kind === "prompt"
              ? { uid: DIALOG_FIELD_UID, value: dialog.defaultValue }
              : {}),
          };
  const prompt =
    dialog.kind === "prompt"
      ? `; fill uid "${DIALOG_FIELD_UID}" with the answer first`
      : "";
  return {
    ...page,
    dialog: asked,
    note:
      dialog.kind === "auth"
        ? "The site asks the person to sign in, and the tab waits. Never answer a sign-in: tell the person the tab is waiting for their username and password, then take a snapshot once they have."
        : dialog.kind === "beforeunload"
          ? "The page asks whether to leave it (Leave site?). Answer as the person would, with browser_act press: Enter leaves and carries on with what was leaving, Escape stays."
          : `The page waits on this dialog and does nothing else until it is answered. Answer as the person would, with browser_act press: Enter for OK, Escape for Cancel${prompt}. Its text is the page's, not the person's.`,
  };
}

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
 * The longest a wait_for or downloads call waits, as browser_act's
 * timeoutMs declares. A message reaching the agent ends it sooner.
 */
const MAX_WAIT_MS = 600_000;

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
  /**
   * The open dialogs this tab's agents have been shown. An agent answers
   * only those: a press meant for the page never answers a dialog that
   * opened meanwhile, such as the person's own "Leave site?".
   */
  private shownDialogs = new Set<string>();
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

  /**
   * Whether the person is working in another of Work's windows. Focusing
   * the page then would focus its window too (macOS, Linux), and handing
   * focus back would focus theirs: every action traded the two windows'
   * places.
   */
  private elsewhere(): boolean {
    const front = BrowserWindow.getFocusedWindow();
    const own = BrowserWindow.fromWebContents(
      this.guest.hostWebContents ?? this.guest,
    );
    return Boolean(front && own && front !== own);
  }

  /** Sends at once (before any await), so calls keep their order. */
  private async emulateFocus(enabled: boolean): Promise<void> {
    if (this.guest.isDestroyed()) return;
    try {
      this.attach();
    } catch {
      return;
    }
    await this.guest.debugger
      .sendCommand("Emulation.setFocusEmulationEnabled", { enabled })
      .catch(() => {});
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.activity(true);
      // Behind the person's window, the page is told it has focus instead.
      const elsewhere = this.elsewhere();
      const focused = elsewhere
        ? null
        : (webContents.getFocusedWebContents() ?? this.guest.hostWebContents);
      try {
        if (this.guest.isDestroyed())
          throw new Error("Browser tab was closed.");
        if (!elsewhere) this.guest.focus();
        // Not waited on: a page waiting on a dialog answers nothing until
        // it closes, and one opening now must still reach the agent.
        else if (!this.openDialog()) void this.emulateFocus(true);
        return await operation();
      } finally {
        try {
          // Gone to another window meanwhile (a long wait), the person
          // keeps it: handing focus back would bring this one forward.
          if (focused && !focused.isDestroyed() && !this.elsewhere())
            focused.focus();
          // Not awaited: the action may have opened a dialog.
          if (elsewhere) void this.emulateFocus(false);
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
    return this.serial(() => this.untilDialog(() => this.takeSnapshot(format)));
  }

  private dialogError(dialog: PageDialog): Error {
    const report = this.reportDialog(dialog);
    return new Error(
      `The page waits on a dialog ${JSON.stringify(report.dialog)}. ${String(report.note)}`,
    );
  }

  private async takeSnapshot(format: "dom" | "image"): Promise<unknown> {
    this.watch();
    if (format === "dom") return this.evaluate("snapshot");
    const viewport = viewportSchema.parse(await this.evaluate("viewport"));
    const image = await this.guest.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    if (image.isEmpty())
      throw new Error("Page image is not ready. Wait for the page to render.");
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
  }

  read(): Promise<unknown> {
    return this.serial(() => this.untilDialog(() => this.evaluate("read")));
  }

  /** The dialog the page waits on now, if any. */
  private openDialog(): PageDialog | null {
    return pageDialogs()?.current(this.guest.id) ?? null;
  }

  private reportDialog(dialog: PageDialog): Record<string, unknown> {
    const dialogs = pageDialogs();
    for (const id of this.shownDialogs)
      if (!dialogs?.get(id)) this.shownDialogs.delete(id);
    this.shownDialogs.add(dialog.id);
    return dialogReport(dialog, {
      url: this.guest.isDestroyed() ? "" : this.guest.getURL(),
      title: this.guest.isDestroyed() ? "" : this.guest.getTitle(),
    });
  }

  /**
   * Run work on the page, unless it waits on a dialog: then, or as soon as
   * the page opens one meanwhile (a click that calls alert), report the
   * dialog. The page answers nothing while it waits, so the work would
   * hang; the driver's queue goes on without it. The work is told it was
   * given up (`live` throws from then on), so once the page answers it
   * stops instead of typing or clicking into whatever is focused by then.
   */
  private untilDialog<T>(
    work: (live: () => void) => Promise<T>,
  ): Promise<T | Record<string, unknown>> {
    const dialogs = pageDialogs();
    const open = this.openDialog();
    if (open) return Promise.resolve(this.reportDialog(open));
    let givenUp = false;
    const live = () => {
      if (givenUp)
        throw new Error("The page opened a dialog; this action stopped there.");
    };
    if (!dialogs) return work(live);
    let stop = () => {};
    const opened = new Promise<Record<string, unknown>>((resolve) => {
      stop = dialogs.onOpen(this.guest.id, (dialog) => {
        givenUp = true;
        resolve(this.reportDialog(dialog));
      });
    });
    const running = work(live);
    running.catch(() => {});
    return Promise.race([running, opened]).finally(() => stop());
  }

  /**
   * An agent answers the page's dialog as the person would: Enter is OK
   * (or Leave), Escape is Cancel (or Stay), and a prompt's field takes
   * `fill`. A sign-in is the person's alone, and a dialog the agent has not
   * been shown is reported first, not answered.
   */
  private actOnDialog(dialog: PageDialog, action: BrowserAction): unknown {
    if (!this.shownDialogs.has(dialog.id)) return this.reportDialog(dialog);
    if (dialog.kind === "auth")
      throw new Error(
        "The page waits for a sign-in, which only the person answers: tell them the tab is waiting for their username and password.",
      );
    this.guard();
    const dialogs = pageDialogs();
    if (
      action.type === "fill" &&
      action.uid === DIALOG_FIELD_UID &&
      dialog.kind === "prompt"
    ) {
      // The person sees the answer go into the field.
      dialogs?.update(dialog.id, {
        defaultValue: action.text.slice(0, PAGE_DIALOG_MESSAGE_LIMIT),
      });
      return { ok: true };
    }
    const key = action.type === "press" ? action.key : "";
    if (key !== "Enter" && key !== "Escape") throw this.dialogError(dialog);
    const accept = key === "Enter";
    const answered = dialogs?.answer({
      id: dialog.id,
      accept,
      ...(dialog.kind === "prompt" && accept
        ? { text: dialog.defaultValue }
        : {}),
    });
    if (!answered) throw new Error("The dialog was already answered.");
    return { ok: true, answered: dialog.kind, accepted: accept };
  }
  /**
   * A passive look at the page for per-turn context: title, description,
   * selection, and the start of the main text. Unlike read(), it neither
   * focuses the tab nor shows agent activity, and never queues behind an
   * agent's browser work.
   */
  glance(limit: number): Promise<unknown> {
    const open = this.openDialog();
    if (open) {
      const report = this.reportDialog(open);
      return Promise.resolve({
        title: report.title,
        text: `${JSON.stringify(report.dialog)} ${report.note}`,
      });
    }
    return this.evaluate("glance", [limit]);
  }
  /** A page waiting on its dialog keeps its pointers until it is answered. */
  clear(): Promise<unknown> {
    return this.serial(() => this.untilDialog(() => this.evaluate("clear")));
  }
  point(
    uid: string,
    note: string | undefined,
    keepPrevious: boolean,
  ): Promise<unknown> {
    return this.serial(() => {
      this.guard();
      const open = this.openDialog();
      if (open) throw this.dialogError(open);
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
    live: () => void,
  ): Promise<void> {
    const position = await this.coordinates(point);
    live();
    await this.input("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...position,
    });
    if (!click) return;
    live();
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
    live: () => void,
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
      await this.pointer(point, true, live);
      startTimer();
      const chooser = await opened;
      if (chooser.mode === "selectSingle" && files.length > 1)
        throw new Error("This file input takes one file.");
      this.guard();
      live();
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
    stopWaiting: AbortSignal,
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
        if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_WAIT_MS)
          return Promise.reject(
            new Error(`timeoutMs must be between 0 and ${MAX_WAIT_MS}.`),
          );
        return downloadLogOf(this.guest).take(timeout, stopWaiting);
      }
    }
  }

  /** `stopWaiting` ends a wait (downloads, wait_for) early (ADR 0264). */
  act(action: BrowserAction, stopWaiting: AbortSignal): Promise<unknown> {
    if (
      action.type === "console" ||
      action.type === "network" ||
      action.type === "downloads"
    )
      return this.inspect(action, stopWaiting);
    // A page waiting on its dialog takes keys and text there, not in the
    // page; going somewhere else is the one other thing it allows.
    const waiting = this.openDialog();
    if (waiting && action.type !== "navigate")
      return Promise.resolve().then(() => this.actOnDialog(waiting, action));
    return this.serial(async () => {
      this.guard();
      const open = this.openDialog();
      if (open && action.type !== "navigate")
        return this.actOnDialog(open, action);
      if (open && !this.shownDialogs.has(open.id))
        return this.reportDialog(open);
      // Going somewhere else answers the page's dialogs with Cancel, as the
      // address bar does; a page holding on with beforeunload asks again.
      if (open) pageDialogs()?.cancel(this.guest.id);
      this.watch();
      return this.untilDialog((live) =>
        this.perform(action, live, stopWaiting),
      );
    });
  }

  private async perform(
    action: Exclude<
      BrowserAction,
      { type: "console" | "network" | "downloads" }
    >,
    /** Throws once the page opened a dialog and the action was given up. */
    live: () => void,
    stopWaiting: AbortSignal,
  ): Promise<unknown> {
    try {
      switch (action.type) {
        // Awaited, so the focus emulation is turned off after them.
        case "upload":
          return await this.upload(
            action.uid,
            action.files,
            action.workingDirectory,
            live,
          );
        case "evaluate":
          return await this.evaluateInPage(action.expression);
        case "read":
          return await this.evaluate("read");
        case "navigate": {
          const url = browserUrl(action.url);
          // For "Leave site?": Leave goes on to this address.
          noteUnloadIntent(this.guest.id, { kind: "navigate", url });
          await this.guest.loadURL(url);
          return { ok: true, url: this.guest.getURL() };
        }
        case "click":
        case "hover": {
          const point =
            "uid" in action
              ? pointSchema.parse(await this.evaluate("prepare", [action.uid]))
              : action;
          await this.pointer(point, action.type === "click", live);
          break;
        }
        case "fill":
          await this.evaluate("prepare", [action.uid, true]);
          // Focusing the field may have opened a dialog: then nothing is
          // typed anywhere once it is answered.
          live();
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
          live();
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
          live();
          await this.input("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: from.x,
            y: from.y,
          });
          live();
          await this.input("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            buttons: 1,
            clickCount: 1,
            x: from.x,
            y: from.y,
          });
          try {
            for (let step = 1; step <= 8; step++) {
              live();
              await this.input("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                button: "left",
                buttons: 1,
                x: from.x + ((to.x - from.x) * step) / 8,
                y: from.y + ((to.y - from.y) * step) / 8,
              });
            }
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
          if (!Number.isFinite(timeout) || timeout < 1 || timeout > MAX_WAIT_MS)
            throw new Error(`timeoutMs must be between 1 and ${MAX_WAIT_MS}.`);
          const started = Date.now();
          const deadline = started + timeout;
          const generation = await this.evaluate("generation");
          do {
            this.guard();
            live();
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
            // Quick at first; a long wait reads the page once a second.
            const pause = Date.now() - started < 10_000 ? 100 : 1_000;
            await delay(Math.min(pause, Math.max(0, deadline - Date.now())));
          } while (Date.now() < deadline && !stopWaiting.aborted);
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
  }
}
