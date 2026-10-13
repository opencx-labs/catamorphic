import { contextBridge, ipcRenderer } from "electron";

/**
 * Page dialogs in a browser tab (ADR 0226), for the tab preload.
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
 *
 * The top frame also remembers the navigation it starts itself (a link, a
 * form, a script), which comes before its `beforeunload`: when that holds
 * the page and the person chooses Leave, main asks the page to go again.
 */
export function installPageDialogs({ top }: { top: boolean }): void {
  // From pagehide on, the page is being left (or stored for back and
  // forward): its visibilitychange and unload ask nothing either.
  let leaving = false;
  window.addEventListener("pagehide", () => {
    leaving = true;
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
  const bridge = (
    kind: unknown,
    message: unknown,
    defaultValue: unknown,
  ): unknown => {
    if (leaving) return null;
    try {
      return ipcRenderer.sendSync("catamorphic:page-dialog", {
        kind,
        message,
        defaultValue,
      });
    } catch {
      return null;
    }
  };
  contextBridge.executeInMainWorld({
    func: (
      bridge: (
        kind: "alert" | "confirm" | "prompt",
        message: string,
        defaultValue?: string,
      ) => unknown,
    ) => {
      type Ask = typeof bridge;
      if (typeof bridge !== "function") return;
      // The event the page is handling, read through the getter as the
      // page found it: a page replacing `window.event` changes nothing.
      const currentEvent = (
        Object.getOwnPropertyDescriptor(window, "event") ??
        Object.getOwnPropertyDescriptor(Window.prototype, "event")
      )?.get;
      // Chrome refuses dialogs from beforeunload, pagehide and unload
      // handlers.
      const ask: Ask = (kind, message, defaultValue) => {
        const handling = currentEvent?.call(window);
        const type = handling instanceof Event ? handling.type : "";
        if (type === "beforeunload" || type === "pagehide" || type === "unload")
          return null;
        return bridge(kind, message, defaultValue);
      };
      // The page's own conversions (WebIDL): alert() shows nothing, while
      // alert(undefined) shows "undefined"; confirm and prompt default to "".
      const options = { writable: true, enumerable: true, configurable: true };
      Object.defineProperty(window, "alert", {
        ...options,
        value: function alert(...args: unknown[]): void {
          ask("alert", args.length === 0 ? "" : String(args[0]));
        },
      });
      Object.defineProperty(window, "confirm", {
        ...options,
        value: function confirm(message?: unknown): boolean {
          return (
            ask("confirm", message === undefined ? "" : String(message)) ===
            true
          );
        },
      });
      Object.defineProperty(window, "prompt", {
        ...options,
        value: function prompt(
          message?: unknown,
          defaultValue?: unknown,
        ): string | null {
          const answer = ask(
            "prompt",
            message === undefined ? "" : String(message),
            defaultValue === undefined ? "" : String(defaultValue),
          );
          return typeof answer === "string" ? answer : null;
        },
      });
    },
    args: [bridge],
  });
  if (top) rememberLeaving();
}

/** What the Navigation API tells of a navigation the page starts. */
interface NavigateEventLike extends Event {
  navigationType: "push" | "replace" | "reload" | "traverse";
  destination: { url: string; key: string | null; sameDocument: boolean };
  formData: FormData | null;
  downloadRequest: string | null;
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
  navigation.addEventListener("navigate", (raw) => {
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
    // and whether it reloads ("Reload site?").
    ipcRenderer.send("catamorphic:page-navigating", {
      reload: event.navigationType === "reload",
    });
  });
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
