import { contextBridge, ipcRenderer } from "electron";
import {
  PAGE_DIALOG_MESSAGE_LIMIT,
  SCRIPT_DIALOG_QUIET_MS,
  type ScriptDialogReply,
  type ScriptDialogRequest,
} from "../shared/script-dialogs.js";

/**
 * Page dialogs in a browser tab (ADR 0227), for the tab preload.
 *
 * Every frame's `alert`, `confirm` and `prompt` are replaced, in the page's
 * own world, by functions that wait on a synchronous IPC until the person
 * (or an agent) answers Work's dialog in the tab. The frame stays blocked
 * meanwhile, as in Chrome; Work, the chat and other tabs do not, since
 * main answers asynchronously. Chrome shows no dialog from a page that is
 * being left: a beforeunload handler (the page's current event tells; a
 * beforeunload listener of the preload's own would make every page one
 * with a handler, and every navigation from it wait on the page), or
 * anything from pagehide on, the visibilitychange and unload of leaving
 * included. Main refuses a frame that is no longer the tab's page.
 *
 * The bridge reaches the page's world only as an argument of the code that
 * replaces the three functions, never as a global the page could call.
 * What the page passes is checked and cut on this side, out of its reach,
 * and a frame main refused stops asking (FrameDialogs), so a page calling
 * `alert` in a loop costs main nothing.
 *
 * The top frame also remembers the navigation it starts itself (a link, a
 * form, a script), which comes before its `beforeunload`: when that holds
 * the page and the person chooses Leave, main asks the page to go again.
 */
export function installPageDialogs({ top }: { top: boolean }): void {
  const frame = new FrameDialogs({
    // An embedded frame with an opaque origin (a sandbox, a data: URL)
    // never asks: main refuses it, since the sandbox may forbid modals.
    never: !top && window.origin === "null",
    send: (request) => ipcRenderer.sendSync("catamorphic:page-dialog", request),
    now: () => Date.now(),
  });
  // Capturing, and before the page's own listeners: none can stop these.
  window.addEventListener("pagehide", () => frame.hidden(), { capture: true });
  window.addEventListener("pageshow", (event) => frame.shown(event.persisted), {
    capture: true,
  });
  contextBridge.executeInMainWorld({
    func: replaceScriptDialogs,
    args: [
      (kind: unknown, message: unknown, defaultValue: unknown) =>
        frame.ask(kind, message, defaultValue),
    ],
  });
  if (top) rememberLeaving();
}

/** The page's text, as main takes it: a string, cut to what a dialog shows. */
function dialogText(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, PAGE_DIALOG_MESSAGE_LIMIT)
    : "";
}

/** What main answered, read without trusting its shape. */
function readReply(reply: unknown): ScriptDialogReply | null {
  if (typeof reply !== "object" || reply === null) return null;
  if ("refused" in reply)
    return { refused: reply.refused === "busy" ? "busy" : "document" };
  if (!("answer" in reply)) return null;
  const { answer } = reply;
  return {
    answer:
      typeof answer === "boolean" || typeof answer === "string" ? answer : null,
  };
}

/**
 * A frame's side of its dialogs, in the preload's world. A frame main
 * refused for good (an opaque frame, a page told to show no more dialogs,
 * a page that has gone) asks nothing more until the document comes back
 * from the back/forward cache; one refused for now (its page waits on too
 * many, or no window shows it) waits `SCRIPT_DIALOG_QUIET_MS` first.
 */
export class FrameDialogs {
  /** From pagehide on, the page is being left (or stored for back and forward). */
  private leaving = false;
  /** Main refused this document: it asks nothing more. */
  private refused = false;
  /** Refused for now: nothing is asked before then. */
  private quietUntil = 0;

  constructor(
    private readonly options: {
      /** This frame never asks (an opaque embedded frame). */
      never: boolean;
      /** The synchronous trip to main, returning its reply. */
      send: (request: ScriptDialogRequest) => unknown;
      now: () => number;
    },
  ) {}

  /** What the page's call returns: the answer, or null when nobody is asked. */
  ask(
    kind: unknown,
    message: unknown,
    defaultValue: unknown,
  ): boolean | string | null {
    if (kind !== "alert" && kind !== "confirm" && kind !== "prompt")
      return null;
    if (this.options.never || this.leaving || this.refused) return null;
    if (this.options.now() < this.quietUntil) return null;
    const reply = this.send({
      kind,
      message: dialogText(message),
      defaultValue: dialogText(defaultValue),
    });
    if (!reply) return null;
    if ("answer" in reply) return reply.answer;
    if (reply.refused === "document") this.refused = true;
    else this.quietUntil = this.options.now() + SCRIPT_DIALOG_QUIET_MS;
    return null;
  }

  private send(request: ScriptDialogRequest): ScriptDialogReply | null {
    try {
      return readReply(this.options.send(request));
    } catch {
      return null;
    }
  }

  /** pagehide: the page is being left; it asks nothing from now on. */
  hidden(): void {
    this.leaving = true;
  }

  /**
   * pageshow. A document back from the back/forward cache is the tab's
   * page again, in a new page load: main may admit it once more.
   */
  shown(restored: boolean): void {
    this.leaving = false;
    if (!restored) return;
    this.refused = false;
    this.quietUntil = 0;
  }
}

/**
 * Replaces `alert`, `confirm` and `prompt` with calls to `ask`. Runs in the
 * page's own world, serialized there, so it uses nothing from this module.
 * It runs before any of the page's scripts: everything the replacements
 * rely on is taken now, so a page replacing `Reflect`, `String`, `Event` or
 * their prototypes later changes nothing.
 */
export function replaceScriptDialogs(
  ask: (
    kind: "alert" | "confirm" | "prompt",
    message: string,
    defaultValue?: string,
  ) => unknown,
): void {
  if (typeof ask !== "function") return;
  const apply = Reflect.apply;
  const toText = String;
  const describe = Object.getOwnPropertyDescriptor;
  const page = window;
  const currentEvent = (
    describe(window, "event") ?? describe(Window.prototype, "event")
  )?.get;
  const eventType = describe(Event.prototype, "type")?.get;
  // Chrome refuses dialogs from beforeunload, pagehide and unload handlers.
  // The event the page is handling is read through the getters as the
  // page found them: replacing `window.event` or `Event.prototype.type`
  // changes nothing, and anything unexpected counts as such a handler.
  const leaving = (): boolean => {
    if (!currentEvent || !eventType) return false;
    try {
      const handling: unknown = apply(currentEvent, page, []);
      if (handling === undefined) return false;
      const type: unknown = apply(eventType, handling, []);
      return (
        type === "beforeunload" || type === "pagehide" || type === "unload"
      );
    } catch {
      return true;
    }
  };
  // The page's own conversions (WebIDL): alert() shows nothing, while
  // alert(undefined) shows "undefined"; confirm and prompt default to "".
  const options = { writable: true, enumerable: true, configurable: true };
  Object.defineProperty(window, "alert", {
    ...options,
    value: function alert(...args: unknown[]): void {
      const message = args.length === 0 ? "" : toText(args[0]);
      if (!leaving()) ask("alert", message);
    },
  });
  Object.defineProperty(window, "confirm", {
    ...options,
    value: function confirm(message?: unknown): boolean {
      const text = message === undefined ? "" : toText(message);
      return !leaving() && ask("confirm", text) === true;
    },
  });
  Object.defineProperty(window, "prompt", {
    ...options,
    value: function prompt(
      message?: unknown,
      defaultValue?: unknown,
    ): string | null {
      const text = message === undefined ? "" : toText(message);
      const suggested = defaultValue === undefined ? "" : toText(defaultValue);
      if (leaving()) return null;
      const answer = ask("prompt", text, suggested);
      return typeof answer === "string" ? answer : null;
    },
  });
}

/** What the Navigation API tells of a navigation the page starts. */
interface NavigateEventLike extends Event {
  navigationType: "push" | "replace" | "reload" | "traverse";
  destination: { url: string; key: string | null; sameDocument: boolean };
  formData: FormData | null;
  downloadRequest: string | null;
  /** The person's own link or form, not the page's script. */
  userInitiated: boolean;
  sourceElement?: Element | null;
}
interface NavigationLike extends EventTarget {
  traverseTo: (key: string) => { finished: Promise<unknown> };
}

interface Leaving {
  url: string;
  type: NavigateEventLike["navigationType"];
  key: string | null;
  /** A form's POST: sent again from its form, which still holds its data. */
  form: HTMLFormElement | null;
  submitter: HTMLElement | null;
  post: boolean;
}

function rememberLeaving(): void {
  const found = (window as Window & { navigation?: NavigationLike }).navigation;
  if (!found) return;
  const navigation: NavigationLike = found;
  let leaving: Leaving | null = null;
  navigation.addEventListener(
    "navigate",
    (raw) => {
      // A navigation the browser announces, not an event the page made.
      if (!raw.isTrusted) return;
      const event = raw as NavigateEventLike;
      if (event.destination.sameDocument || event.downloadRequest !== null)
        return;
      const source = event.sourceElement ?? null;
      const form =
        source instanceof HTMLFormElement
          ? source
          : source instanceof HTMLButtonElement ||
              source instanceof HTMLInputElement
            ? source.form
            : null;
      leaving = {
        url: event.destination.url,
        type: event.navigationType,
        key: event.destination.key,
        form,
        submitter:
          source instanceof HTMLElement && source !== form ? source : null,
        post: event.formData !== null,
      };
      // Before the page's beforeunload runs: main learns the page is going,
      // whether it reloads ("Reload site?"), and whether the person's own
      // press in the page started it.
      ipcRenderer.send("catamorphic:page-navigating", {
        reload: event.navigationType === "reload",
        user: event.userInitiated === true,
      });
    },
    { capture: true },
  );
  ipcRenderer.on("catamorphic:page-proceed", () => {
    const next = leaving;
    leaving = null;
    if (!next) return;
    if (next.type === "reload") location.reload();
    else if (next.type === "traverse") {
      if (next.key)
        void navigation.traverseTo(next.key).finished.catch(() => {});
    } else if (next.post) {
      // Its own submit again, with the button that sent it.
      const { form, submitter } = next;
      if (!form?.isConnected) return;
      const button =
        (submitter instanceof HTMLButtonElement ||
          submitter instanceof HTMLInputElement) &&
        submitter.form === form
          ? submitter
          : null;
      try {
        HTMLFormElement.prototype.requestSubmit.call(form, button);
      } catch {
        HTMLFormElement.prototype.submit.call(form);
      }
    } else if (next.type === "replace") location.replace(next.url);
    else location.assign(next.url);
  });
}
