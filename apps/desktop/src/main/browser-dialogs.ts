import { EventEmitter } from "node:events";
import { app, ipcMain, type WebContents, webContents } from "electron";
import {
  PAGE_DIALOG_MESSAGE_LIMIT,
  type PageDialog,
  type PageDialogAnswer,
  pageDialogAnswerSchema,
  scriptDialogRequestSchema,
  type UnloadIntent,
  unloadIntentSchema,
} from "../shared/page-dialogs.js";
import { PageDialogs } from "./page-dialogs.js";

/**
 * Pages in browser tabs ask through Work's dialogs (ADR 0226). Electron
 * shows `alert` and `confirm` as native message boxes over the whole
 * window, refuses `prompt`, cancels every HTTP sign-in and silently keeps a
 * page whose `beforeunload` holds a navigation. Here:
 *  - The tab preload replaces the page's `alert`, `confirm` and `prompt` in
 *    every frame with a synchronous IPC: the page waits, as in Chrome, and
 *    main answers once the person (or an agent) does in the tab's window.
 *  - `will-prevent-unload` keeps the page, asks "Leave site?", and on Leave
 *    redoes what was leaving it (a reload, an address, back or forward, the
 *    page's own navigation, or closing the tab).
 *  - `login` asks for a sign-in in the tab, offering the profile's saved
 *    sign-ins for the site, and offers to save one typed that worked.
 * Dialogs belong to their tab's page; a navigation or a closed tab cancels
 * them.
 */

/** A browser tab's page: what the tab preload runs in. */
export interface BrowserDialogsHost {
  /** A webview guest that is a tab's page (not an extension's view). */
  isTab: (guest: WebContents) => boolean;
  profileFor: (host: WebContents) => string;
  vault: {
    list: (
      profileId: string,
      origin: string,
    ) => Promise<{ id: string; username: string; origin: string }[]>;
    reveal: (
      profileId: string,
      id: string,
    ) => Promise<{ username: string; password: string } | null>;
  };
  /** A typed sign-in landed: offer to save it on the tab's password card. */
  offerToSave: (input: {
    guest: WebContents;
    host: WebContents;
    profileId: string;
    origin: string;
    username: string;
    password: string;
  }) => void;
}

/** What closing a tab finds: go now, or wait while the page is asked. */
export type CloseAsk = "close" | "asking";

/** A Leave answered this long ago still lets the redone unload through. */
const LEAVE_WINDOW_MS = 5_000;
/** What led to "Leave site?" was asked at most this long before it. */
const INTENT_WINDOW_MS = 3_000;
/** A sign-in that takes longer than this to land is not offered for saving. */
const SAVE_WINDOW_MS = 60_000;
/** An isolated world for reading the page's activation, apart from the driver's. */
const PROBE_WORLD = 1006;
/** How long a page may take to say whether the person touched it. */
const PROBE_MS = 400;

let current: PageDialogs | null = null;
let noteIntent: ((guestId: number, intent: UnloadIntent) => void) | null = null;

/** The open dialogs of every tab's page, for the browser driver. */
export function pageDialogs(): PageDialogs | null {
  return current;
}

/** What the agent is about to do to a page, so "Leave site?" can redo it. */
export function noteUnloadIntent(guestId: number, intent: UnloadIntent): void {
  noteIntent?.(guestId, intent);
}

function httpOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function loopback(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "[::1]" ||
      /^127\./.test(host)
    );
  } catch {
    return false;
  }
}

/** The answer a script dialog returns to the page. */
export function scriptAnswer(
  kind: "alert" | "confirm" | "prompt",
  answer: PageDialogAnswer | null,
): boolean | string | null {
  if (kind === "confirm") return answer?.accept === true;
  if (kind === "prompt") return answer?.accept ? (answer.text ?? "") : null;
  return null;
}

/** The frame's origin, or empty for one without (sandboxed, data:, about:). */
function frameOrigin(origin: string | undefined): string {
  return origin && origin !== "null" ? origin : "";
}

export function registerBrowserDialogs(host: BrowserDialogsHost): () => void {
  // The window each page's dialogs show in, kept so a page that went away
  // still has its (now empty) list delivered.
  const hosts = new Map<number, WebContents>();
  const dialogs = new PageDialogs((guestId, list) => {
    const owner = hosts.get(guestId);
    if (owner && !owner.isDestroyed())
      owner.send("catamorphic:page-dialogs-changed", {
        guestId,
        dialogs: list,
      });
  });
  current = dialogs;

  const hostOf = (guest: WebContents): WebContents | null => {
    if (guest.isDestroyed() || guest.getType() !== "webview") return null;
    const owner = guest.hostWebContents;
    if (!owner || owner.isDestroyed() || !host.isTab(guest)) return null;
    hosts.set(guest.id, owner);
    return owner;
  };
  /** The guest with this id, if the asking window shows it. */
  const hostedGuest = (
    owner: WebContents,
    guestId: unknown,
  ): WebContents | null => {
    if (typeof guestId !== "number") return null;
    const guest = webContents.fromId(guestId);
    return guest && !guest.isDestroyed() && guest.hostWebContents === owner
      ? guest
      : null;
  };

  // --- what was leaving the page, for "Leave site?" ---
  const intents = new Map<number, { intent: UnloadIntent; at: number }>();
  /** The page's own navigation (a link, a form, a script), as it started. */
  const pageNavigations = new Map<number, number>();
  /** Leave was chosen: the redone unload goes without asking again. */
  const leaving = new Map<number, number>();
  /** Tabs being closed, waiting on the page's beforeunload. */
  const closing = new Set<number>();
  noteIntent = (guestId, intent) =>
    intents.set(guestId, { intent, at: Date.now() });

  const onUnloadIntent = (
    event: Electron.IpcMainEvent,
    input: { guestId?: unknown; intent?: unknown },
  ) => {
    const guest = hostedGuest(event.sender, input?.guestId);
    const intent = unloadIntentSchema.safeParse(input?.intent);
    if (guest && intent.success) noteIntent?.(guest.id, intent.data);
  };
  const onPageNavigating = (event: Electron.IpcMainEvent) => {
    if (event.senderFrame?.parent === null && hostOf(event.sender))
      pageNavigations.set(event.sender.id, Date.now());
  };

  /** Do again what "Leave site?" held, now that the person chose to leave. */
  const leave = (guest: WebContents, askedAt: number) => {
    leaving.set(guest.id, Date.now() + LEAVE_WINDOW_MS);
    const recent = (at: number | undefined) =>
      at !== undefined &&
      at <= askedAt + 100 &&
      askedAt - at < INTENT_WINDOW_MS;
    const browser = intents.get(guest.id);
    const page = pageNavigations.get(guest.id);
    const fromBrowser = browser && recent(browser.at) ? browser : null;
    const fromPage = recent(page) ? page : undefined;
    intents.delete(guest.id);
    pageNavigations.delete(guest.id);
    if (fromPage !== undefined && (!fromBrowser || fromPage > fromBrowser.at)) {
      guest.send("catamorphic:page-proceed");
      return;
    }
    if (!fromBrowser) return;
    const { intent } = fromBrowser;
    if (intent.kind === "navigate")
      void guest.loadURL(intent.url).catch(() => {});
    else if (intent.kind === "reload") guest.reload();
    else if (intent.kind === "reload-hard") guest.reloadIgnoringCache();
    else if (intent.kind === "back") guest.navigationHistory.goBack();
    else guest.navigationHistory.goForward();
  };

  // --- the page's alert, confirm and prompt ---
  const onScriptDialog = (event: Electron.IpcMainEvent, payload: unknown) => {
    const request = scriptDialogRequestSchema.safeParse(payload);
    const kind = request.success ? request.data.kind : "alert";
    const reply = (answer: PageDialogAnswer | null) => {
      event.returnValue = scriptAnswer(kind, answer);
    };
    const guest = event.sender;
    const frame = event.senderFrame;
    if (!request.success || !frame || !hostOf(guest)) {
      reply(null);
      return;
    }
    const origin = frameOrigin(frame.origin);
    const page = frameOrigin(guest.mainFrame.origin);
    void dialogs
      .ask(
        {
          guestId: guest.id,
          kind,
          origin,
          embedded: frame.parent !== null && origin !== page,
          message: request.data.message.slice(0, PAGE_DIALOG_MESSAGE_LIMIT),
          defaultValue: (request.data.defaultValue ?? "").slice(
            0,
            PAGE_DIALOG_MESSAGE_LIMIT,
          ),
          reload: false,
        },
        { frame: frame.frameTreeNodeId },
      )
      .then(reply, () => reply(null));
  };

  ipcMain.on("catamorphic:page-dialog", onScriptDialog);
  ipcMain.on("catamorphic:browser-unload-intent", onUnloadIntent);
  ipcMain.on("catamorphic:page-navigating", onPageNavigating);
  ipcMain.handle(
    "catamorphic:page-dialogs",
    (event, input: { guestId?: unknown }): PageDialog[] => {
      const guest = hostedGuest(event.sender, input?.guestId);
      if (!guest) return [];
      hosts.set(guest.id, event.sender);
      return dialogs.list(guest.id);
    },
  );
  ipcMain.handle(
    "catamorphic:page-dialog-answer",
    (event, input: unknown): boolean => {
      const answer = pageDialogAnswerSchema.parse(input);
      const dialog = dialogs.get(answer.id);
      if (!dialog || !hostedGuest(event.sender, dialog.guestId)) return false;
      return dialogs.answer(answer) !== null;
    },
  );
  // Closing a tab asks its page first, as Chrome does: a page the person
  // never touched, or one waiting on its own dialog, just goes.
  ipcMain.handle(
    "catamorphic:browser-close-ask",
    async (event, input: { guestId?: unknown }): Promise<CloseAsk> => {
      const guest = hostedGuest(event.sender, input?.guestId);
      if (!guest || guest.isCrashed() || !hostOf(guest)) return "close";
      if (dialogs.has(guest.id)) return "close";
      const touched = await Promise.race([
        guest
          .executeJavaScriptInIsolatedWorld(PROBE_WORLD, [
            { code: "navigator.userActivation.hasBeenActive" },
          ])
          .then(
            (value) => value === true,
            () => false,
          ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), PROBE_MS),
        ),
      ]);
      if (!touched || guest.isDestroyed()) return "close";
      closing.add(guest.id);
      // The page's beforeunload runs; a page that lets go closes (the
      // webview's `close`), one that holds on asks "Leave site?".
      guest.close({ waitForBeforeUnload: true });
      return "asking";
    },
  );

  // --- sign-ins (HTTP authentication) ---
  const pendingSaves = new Map<
    number,
    {
      url: string;
      origin: string;
      profileId: string;
      username: string;
      password: string;
      at: number;
    }
  >();
  /** The username a page's last sign-in tried, offered again on a retry. */
  const triedUsernames = new Map<number, { key: string; username: string }>();

  const signIn = async (
    guest: WebContents,
    owner: WebContents,
    details: Electron.AuthenticationResponseDetails & { isMainFrame?: boolean },
    authInfo: Electron.AuthInfo,
  ): Promise<{ username: string; password: string } | null> => {
    pendingSaves.delete(guest.id);
    const target = authInfo.isProxy
      ? httpOrigin(`http://${authInfo.host}:${authInfo.port}`)
      : httpOrigin(details.url);
    if (!target) return null;
    // Chrome asks only for the page's own requests and navigations: another
    // site's image or script just fails, without a dialog.
    const page = httpOrigin(guest.getURL());
    if (
      !authInfo.isProxy &&
      !details.isRequestForNavigation &&
      page !== null &&
      target !== page
    )
      return null;
    const profileId = host.profileFor(owner);
    const saved = authInfo.isProxy
      ? []
      : await host.vault.list(profileId, target).then(
          (logins) => logins.map(({ id, username }) => ({ id, username })),
          () => [],
        );
    if (guest.isDestroyed()) return null;
    const key = `${target}\n${authInfo.realm}`;
    const tried = triedUsernames.get(guest.id);
    const answer = await dialogs.ask({
      guestId: guest.id,
      kind: "auth",
      origin: target,
      embedded: false,
      message: "",
      defaultValue: "",
      reload: false,
      auth: {
        realm: authInfo.realm.slice(0, 512),
        scheme: authInfo.scheme,
        proxy: authInfo.isProxy,
        insecure:
          !authInfo.isProxy && target.startsWith("http:") && !loopback(target),
        retry: !details.firstAuthAttempt,
        username:
          !details.firstAuthAttempt && tried?.key === key ? tried.username : "",
        saved,
      },
    });
    if (!answer?.accept || guest.isDestroyed()) return null;
    if (answer.credentialId) {
      // Only a sign-in offered for this site goes to it.
      const offered = saved.some((login) => login.id === answer.credentialId);
      const login = offered
        ? await host.vault
            .reveal(profileId, answer.credentialId)
            .catch(() => null)
        : null;
      if (!login) return null;
      triedUsernames.set(guest.id, { key, username: login.username });
      return { username: login.username, password: login.password };
    }
    const username = answer.username ?? "";
    const password = answer.password ?? "";
    triedUsernames.set(guest.id, { key, username });
    if (
      !authInfo.isProxy &&
      details.isRequestForNavigation &&
      details.isMainFrame !== false &&
      password
    )
      pendingSaves.set(guest.id, {
        url: details.url,
        origin: target,
        profileId,
        username,
        password,
        at: Date.now(),
      });
    return { username, password };
  };

  const wire = (_event: Electron.Event, contents: WebContents) => {
    if (contents.getType() !== "webview") return;
    const id = contents.id;
    contents.on("will-prevent-unload", (event) => {
      const owner = hostOf(contents);
      if (!owner) return;
      const leaveUntil = leaving.get(id);
      if (leaveUntil !== undefined && leaveUntil > Date.now()) {
        leaving.delete(id);
        event.preventDefault();
        return;
      }
      // The page stays for now. One "Leave site?" per page: asking again
      // (a second reload) changes what it asks about.
      const askedAt = Date.now();
      const intent = intents.get(id);
      const reload =
        !closing.has(id) &&
        intent !== undefined &&
        askedAt - intent.at < INTENT_WINDOW_MS &&
        (intent.intent.kind === "reload" ||
          intent.intent.kind === "reload-hard");
      const open = dialogs.find(id, "beforeunload");
      if (open) {
        dialogs.update(open.id, { reload });
        return;
      }
      const origin = frameOrigin(contents.mainFrame.origin);
      void dialogs
        .ask({
          guestId: id,
          kind: "beforeunload",
          origin,
          embedded: false,
          message: "",
          defaultValue: "",
          reload,
        })
        .then((answer) => {
          if (contents.isDestroyed()) return;
          if (closing.delete(id)) {
            if (!owner.isDestroyed())
              owner.send("catamorphic:browser-close-answer", {
                guestId: id,
                leave: answer?.accept === true,
              });
            return;
          }
          if (answer?.accept) leave(contents, askedAt);
        });
    });
    // Electron closes a webview's page even when its beforeunload holds it:
    // its own "-before-unload-fired" handler keeps the page only for
    // windows. A held close of a tab is kept here, and "Leave site?"
    // decides. Without the event (a later Electron), the tab closes as
    // before; e2e/page-dialogs.e2e.ts notices.
    // Electron's internal event is not in its typings.
    EventEmitter.prototype.on.call(
      contents,
      "-before-unload-fired",
      (event: Electron.Event, proceed: boolean) => {
        if (!proceed && closing.has(id)) event.preventDefault();
      },
    );
    contents.on("login", (event, details, authInfo, callback) => {
      const owner = hostOf(contents);
      // Sign-in popups and extension views keep Electron's answer (none).
      if (!owner) return;
      event.preventDefault();
      void signIn(contents, owner, details, authInfo).then(
        (credentials) =>
          credentials
            ? callback(credentials.username, credentials.password)
            : callback(),
        () => callback(),
      );
    });
    // Another page starting takes back what this one asked, as in Chrome;
    // an embedded frame's own navigation takes back what that frame asked.
    contents.on("did-start-navigation", (details) => {
      if (details.isSameDocument) return;
      if (details.isMainFrame) {
        dialogs.cancel(id);
        return;
      }
      const frame = details.frame?.frameTreeNodeId;
      if (frame !== undefined)
        dialogs.cancel(id, (_dialog, asker) => asker === frame);
    });
    contents.on("did-navigate", (_event, url, httpResponseCode) => {
      dialogs.navigated(id);
      leaving.delete(id);
      closing.delete(id);
      const save = pendingSaves.get(id);
      pendingSaves.delete(id);
      const owner = contents.hostWebContents;
      if (
        save &&
        owner &&
        !owner.isDestroyed() &&
        Date.now() - save.at < SAVE_WINDOW_MS &&
        httpOrigin(url) === save.origin &&
        httpResponseCode !== 401 &&
        httpResponseCode !== 407
      )
        host.offerToSave({
          guest: contents,
          host: owner,
          profileId: save.profileId,
          origin: save.origin,
          username: save.username,
          password: save.password,
        });
    });
    contents.once("destroyed", () => {
      dialogs.forget(id);
      hosts.delete(id);
      intents.delete(id);
      pageNavigations.delete(id);
      leaving.delete(id);
      closing.delete(id);
      pendingSaves.delete(id);
      triedUsernames.delete(id);
    });
  };
  app.on("web-contents-created", wire);

  return () => {
    app.off("web-contents-created", wire);
    ipcMain.off("catamorphic:page-dialog", onScriptDialog);
    ipcMain.off("catamorphic:browser-unload-intent", onUnloadIntent);
    ipcMain.off("catamorphic:page-navigating", onPageNavigating);
    ipcMain.removeHandler("catamorphic:page-dialogs");
    ipcMain.removeHandler("catamorphic:page-dialog-answer");
    ipcMain.removeHandler("catamorphic:browser-close-ask");
    for (const guestId of [...hosts.keys()]) dialogs.forget(guestId);
    if (current === dialogs) current = null;
    noteIntent = null;
  };
}
