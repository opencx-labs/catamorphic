import { EventEmitter } from "node:events";
import { app, ipcMain, type WebContents, webContents } from "electron";
import {
  type PageDialog,
  type PageDialogAnswer,
  pageDialogAnswerSchema,
  scriptDialogRequestSchema,
  type UnloadIntent,
  unloadIntentSchema,
} from "../shared/page-dialogs.js";
import type { ScriptDialogReply } from "../shared/script-dialogs.js";
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

/** What Leave does: the browser's attempt again, or the page's own. */
type HeldAction = { kind: "browser"; intent: UnloadIntent } | { kind: "page" };

/** For this long after Leave, the page is let go without asking again. */
const LEAVE_WINDOW_MS = 5_000;
/** What led to "Leave site?" was asked at most this long before it. */
const INTENT_WINDOW_MS = 3_000;
/** A sign-in that takes longer than this to land is not offered for saving. */
const SAVE_WINDOW_MS = 60_000;
/** An isolated world for reading the page's activation, apart from the driver's. */
const PROBE_WORLD = 1006;
/** How long a page may take to say whether the person touched it. */
const PROBE_MS = 400;
/** How often a frame that asked is checked for having gone (removed, crashed). */
const FRAME_CHECK_MS = 500;
/** How long Chromium's transient user activation lasts (kActivationLifespan). */
const ACTIVATION_MS = 5_000;

let current: PageDialogs | null = null;
let noteIntent: ((guestId: number, intent: UnloadIntent) => void) | null = null;
let closeGuard: (guestId: number) => boolean = () => false;

/** The open dialogs of every tab's page, for the browser driver. */
export function pageDialogs(): PageDialogs | null {
  return current;
}

/** What the agent is about to do to a page, so "Leave site?" can redo it. */
export function noteUnloadIntent(guestId: number, intent: UnloadIntent): void {
  noteIntent?.(guestId, intent);
}

/**
 * The page's tab is being closed and its beforeunload asked. Electron
 * grants the page a user activation as it asks, so it opens no windows,
 * asks for no permission and shares no screen with it: while asked, for as
 * long as the activation lasts after, and once it is leaving, until it is
 * gone.
 */
export function pageClosing(guestId: number): boolean {
  return closeGuard(guestId);
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
  /** What the person or an agent last did to leave each page. */
  const intents = new Map<number, { intent: UnloadIntent; at: number }>();
  /**
   * The page's own navigation (a link, a form, a script), as it started;
   * `user` when the person's own press in the page started it.
   */
  const pageNavigations = new Map<
    number,
    { reload: boolean; user: boolean; at: number }
  >();
  /** Leave was chosen: until then, the page is let go without asking. */
  const leaving = new Map<number, number>();
  /**
   * What an open "Leave site?" would do on Leave, which also names it
   * ("Reload site?").
   */
  const held = new Map<number, HeldAction | null>();
  /** Tabs being closed, waiting on the page's beforeunload. */
  const closing = new Set<number>();
  /**
   * Each tab's goings (the person's or an agent's, and every top-frame
   * navigation), counted: a sign-in asked before one never shows after it.
   */
  const goings = new Map<number, number>();
  const went = (guestId: number) =>
    goings.set(guestId, (goings.get(guestId) ?? 0) + 1);
  /**
   * Until when a page whose tab was closed holds the activation the close
   * granted it: the activation's own lifespan, or for good once it leaves.
   */
  const activated = new Map<number, number>();
  closeGuard = (guestId) =>
    closing.has(guestId) || (activated.get(guestId) ?? 0) > Date.now();
  noteIntent = (guestId, intent) => {
    intents.set(guestId, { intent, at: Date.now() });
    went(guestId);
    // Going somewhere else answers the page's own dialogs and sign-ins
    // with Cancel, as Chrome's address bar does, before Chromium's
    // beforeunload wait. "Leave site?" stays: it asks about this going.
    dialogs.cancel(guestId, (dialog) => dialog.kind !== "beforeunload");
  };
  const forgetIntents = (guestId: number) => {
    intents.delete(guestId);
    pageNavigations.delete(guestId);
  };

  const onUnloadIntent = (
    event: Electron.IpcMainEvent,
    input: { guestId?: unknown; intent?: unknown },
  ) => {
    const guest = hostedGuest(event.sender, input?.guestId);
    const intent = unloadIntentSchema.safeParse(input?.intent);
    if (guest && intent.success) noteIntent?.(guest.id, intent.data);
  };
  const onPageNavigating = (
    event: Electron.IpcMainEvent,
    payload: { reload?: unknown; user?: unknown },
  ) => {
    if (event.senderFrame?.parent === null && hostOf(event.sender))
      pageNavigations.set(event.sender.id, {
        reload: payload?.reload === true,
        user: payload?.user === true,
        at: Date.now(),
      });
  };

  /**
   * What is leaving the page now. The person's or an agent's attempt comes
   * first: the page's script cannot pass a navigation of its own off as
   * theirs, however often it starts one. Only the person's own press in
   * the page (a link, a form) after it is what leaves instead.
   */
  const heldAttempt = (
    guestId: number,
    now: number,
  ): { action: HeldAction | null; reload: boolean } => {
    const fresh = (at: number) => now - at < INTENT_WINDOW_MS;
    const browser = intents.get(guestId);
    const page = pageNavigations.get(guestId);
    const fromBrowser = browser && fresh(browser.at) ? browser : null;
    const fromPage = page && fresh(page.at) ? page : null;
    if (
      fromPage &&
      (!fromBrowser || (fromPage.user && fromPage.at > fromBrowser.at))
    )
      return { action: { kind: "page" }, reload: fromPage.reload };
    if (fromBrowser)
      return {
        action: { kind: "browser", intent: fromBrowser.intent },
        reload:
          fromBrowser.intent.kind === "reload" ||
          fromBrowser.intent.kind === "reload-hard",
      };
    return { action: null, reload: false };
  };

  /** Do again what "Leave site?" held, now that the person chose to leave. */
  const leave = (guest: WebContents) => {
    leaving.set(guest.id, Date.now() + LEAVE_WINDOW_MS);
    const action = held.get(guest.id) ?? null;
    held.delete(guest.id);
    forgetIntents(guest.id);
    if (!action) return;
    if (action.kind === "page") {
      guest.send("catamorphic:page-proceed");
      return;
    }
    const { intent } = action;
    if (intent.kind === "navigate")
      void guest.loadURL(intent.url).catch(() => {});
    else if (intent.kind === "reload") guest.reload();
    else if (intent.kind === "reload-hard") guest.reloadIgnoringCache();
    else if (intent.kind === "back") guest.navigationHistory.goBack();
    else guest.navigationHistory.goForward();
  };

  // --- the page's alert, confirm and prompt ---
  /** The frame each open script dialog came from, to notice it going. */
  const askers = new Map<string, Electron.WebFrameMain>();
  let frameCheck: ReturnType<typeof setInterval> | undefined;
  const checkFrames = () => {
    for (const [id, frame] of askers) {
      const dialog = dialogs.get(id);
      if (!dialog) {
        askers.delete(id);
        continue;
      }
      // A frame removed from its page, or one whose process went, asks
      // nothing any more (Chrome closes its dialog too).
      if (frame.isDestroyed() || frame.detached)
        dialogs.cancel(dialog.guestId, (open) => open.id === id);
    }
    if (askers.size === 0) {
      clearInterval(frameCheck);
      frameCheck = undefined;
    }
  };
  /** A frame of the page the tab shows now, not one it is leaving. */
  const inPage = (guest: WebContents, frame: Electron.WebFrameMain) =>
    !frame.isDestroyed() &&
    !frame.detached &&
    guest.mainFrame.framesInSubtree.some(
      (candidate) =>
        candidate.frameToken === frame.frameToken &&
        candidate.processId === frame.processId,
    );
  const onScriptDialog = (event: Electron.IpcMainEvent, payload: unknown) => {
    const reply = (value: ScriptDialogReply) => {
      event.returnValue = value;
    };
    // Refused without asking anyone; the frame stops asking (preload).
    const refuse = (why: "document" | "busy") => reply({ refused: why });
    const request = scriptDialogRequestSchema.safeParse(payload);
    const guest = event.sender;
    const frame = event.senderFrame;
    if (!request.success || !frame) return refuse("document");
    // No window shows the tab's page just now (one closing).
    if (!hostOf(guest)) return refuse("busy");
    // A page that has gone (unloading after the next one committed) asks
    // nothing over its successor.
    if (!inPage(guest, frame)) return refuse("document");
    const origin = frameOrigin(frame.origin);
    const page = frameOrigin(guest.mainFrame.origin);
    const embedded = frame.parent !== null && origin !== page;
    // A sandboxed or opaque frame has no origin to name: as Chrome does for
    // a sandbox without allow-modals, it shows nothing.
    if (frame.parent !== null && origin === "") return refuse("document");
    const { kind } = request.data;
    const refusal = dialogs.refusal(guest.id, kind);
    // Told to show no more dialogs, the page stays so until another loads;
    // one waiting on too many may ask again once some are answered.
    if (refusal) return refuse(refusal === "suppressed" ? "document" : "busy");
    void dialogs
      .ask(
        {
          guestId: guest.id,
          kind,
          origin,
          embedded,
          message: request.data.message,
          defaultValue: request.data.defaultValue,
          reload: false,
        },
        {
          frame: frame.frameTreeNodeId,
          queued: (dialog) => {
            askers.set(dialog.id, frame);
            frameCheck ??= setInterval(checkFrames, FRAME_CHECK_MS);
          },
        },
      )
      .then(
        (answer) => reply({ answer: scriptAnswer(kind, answer) }),
        () => reply({ answer: scriptAnswer(kind, null) }),
      );
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
      const answer = pageDialogAnswerSchema.safeParse(input);
      if (!answer.success) return false;
      const dialog = dialogs.get(answer.data.id);
      if (!dialog || !hostedGuest(event.sender, dialog.guestId)) return false;
      return dialogs.answer(answer.data) !== null;
    },
  );
  // Closing a tab that disposes its page asks the page first, as Chrome
  // does: a page the person never touched, or one waiting on its own
  // dialog, just goes.
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
      activated.set(guest.id, Date.now() + ACTIVATION_MS);
      // The page's beforeunload runs; "-before-unload-fired" keeps the page
      // either way: one that let go leaves with its tab's own exit, one
      // that holds on asks "Leave site?". A page with no handler closes at
      // once (the webview's `close`), still showing.
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
  /** Where each tab's top frame is navigating, to tell its sign-ins apart. */
  const mainNavigations = new Map<number, string>();
  /**
   * Sign-ins being asked, by page, proxy, site and realm: requests for the
   * same one wait on its dialog and get its answer, as in Chrome.
   */
  const signIns = new Map<
    string,
    Promise<{ username: string; password: string } | null>
  >();

  const askSignIn = async (input: {
    guest: WebContents;
    owner: WebContents;
    target: string;
    embedded: boolean;
    mainFrame: boolean;
    details: Electron.AuthenticationResponseDetails;
    authInfo: Electron.AuthInfo;
  }): Promise<{ username: string; password: string } | null> => {
    const { guest, owner, target, details, authInfo } = input;
    const profileId = host.profileFor(owner);
    const going = goings.get(guest.id) ?? 0;
    const saved = authInfo.isProxy
      ? []
      : await host.vault.list(profileId, target).then(
          (logins) => logins.map(({ id, username }) => ({ id, username })),
          () => [],
        );
    // The tab went elsewhere while the vault was read: as for a sign-in
    // already asked, the request it was for goes unanswered.
    if (guest.isDestroyed() || (goings.get(guest.id) ?? 0) !== going)
      return null;
    const key = `${target}\n${authInfo.realm}`;
    const tried = triedUsernames.get(guest.id);
    const answer = await dialogs.ask({
      guestId: guest.id,
      kind: "auth",
      origin: target,
      embedded: input.embedded,
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
    if (!authInfo.isProxy && input.mainFrame && password)
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

  const signIn = (
    guest: WebContents,
    owner: WebContents,
    details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
  ): Promise<{ username: string; password: string } | null> => {
    const target = authInfo.isProxy
      ? httpOrigin(`http://${authInfo.host}:${authInfo.port}`)
      : httpOrigin(details.url);
    if (!target) return Promise.resolve(null);
    const page = frameOrigin(guest.mainFrame.origin);
    // The top frame's own navigation, as opposed to an embedded frame's.
    const mainFrame =
      details.isRequestForNavigation &&
      mainNavigations.get(guest.id) === details.url;
    // Chrome asks only for the page's own requests and navigations: another
    // site's image or script just fails, without a dialog.
    if (!authInfo.isProxy && !details.isRequestForNavigation && target !== page)
      return Promise.resolve(null);
    const key = [guest.id, authInfo.isProxy, target, authInfo.realm].join("\n");
    const open = signIns.get(key);
    if (open) return open;
    pendingSaves.delete(guest.id);
    const asking = askSignIn({
      guest,
      owner,
      target,
      // Another site's frame asks over this page: the dialog says so.
      embedded: !authInfo.isProxy && !mainFrame && target !== page,
      mainFrame,
      details,
      authInfo,
    });
    signIns.set(key, asking);
    const settled = () => {
      if (signIns.get(key) === asking) signIns.delete(key);
    };
    asking.then(settled, settled);
    return asking;
  };

  const wire = (_event: Electron.Event, contents: WebContents) => {
    if (contents.getType() !== "webview") return;
    const id = contents.id;
    contents.on("will-prevent-unload", (event) => {
      const owner = hostOf(contents);
      if (!owner) return;
      // Leave was chosen: what it redid goes, and so does whatever else
      // the page tries before it does.
      if ((leaving.get(id) ?? 0) > Date.now()) {
        event.preventDefault();
        return;
      }
      // The page stays for now. One "Leave site?" per page: asking again
      // (a second reload) changes it to what was tried last, except that
      // once the person or an agent tried, only they change it.
      const attempt = closing.has(id)
        ? { action: null, reload: false }
        : heldAttempt(id, Date.now());
      const open = dialogs.find(id, "beforeunload");
      if (open) {
        if (
          held.get(id)?.kind === "browser" &&
          attempt.action?.kind !== "browser"
        )
          return;
        held.set(id, attempt.action);
        dialogs.update(open.id, { reload: attempt.reload });
        return;
      }
      held.set(id, attempt.action);
      // A tab being closed in the background comes forward to ask.
      if (closing.has(id))
        owner.send("catamorphic:browser-reveal-guest", { guestId: id });
      const origin = frameOrigin(contents.mainFrame.origin);
      void dialogs
        .ask({
          guestId: id,
          kind: "beforeunload",
          origin,
          embedded: false,
          message: "",
          defaultValue: "",
          reload: attempt.reload,
        })
        .then((answer) => {
          if (contents.isDestroyed()) return;
          if (closing.delete(id)) {
            held.delete(id);
            // Leaving with its tab: no window or permission until it goes.
            if (answer?.accept) activated.set(id, Number.POSITIVE_INFINITY);
            if (!owner.isDestroyed())
              owner.send("catamorphic:browser-close-answer", {
                guestId: id,
                leave: answer?.accept === true,
              });
            return;
          }
          if (answer?.accept) leave(contents);
          else {
            // Stayed: what was tried is done with.
            held.delete(id);
            forgetIntents(id);
          }
        });
    });
    // Closing a tab runs the page's beforeunload through Electron's close,
    // whose own "-before-unload-fired" handler unloads a webview's page
    // whatever the page answers. The page stays loaded here either way: a
    // page that let go tells the window, whose tab then leaves with its own
    // exit; one that held on waits on "Leave site?". Without the event (a
    // later Electron), the tab closes as before; e2e/page-dialogs.e2e.ts
    // notices. Electron's internal event is not in its typings.
    EventEmitter.prototype.on.call(
      contents,
      "-before-unload-fired",
      (event: Electron.Event, proceed: boolean) => {
        if (!closing.has(id)) return;
        event.preventDefault();
        if (!proceed) return;
        closing.delete(id);
        activated.set(id, Number.POSITIVE_INFINITY);
        const owner = contents.hostWebContents;
        if (owner && !owner.isDestroyed())
          owner.send("catamorphic:browser-close-answer", {
            guestId: id,
            leave: true,
          });
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
        mainNavigations.set(id, details.url);
        went(id);
        forgetIntents(id);
        dialogs.cancel(id);
        return;
      }
      const frame = details.frame?.frameTreeNodeId;
      if (frame !== undefined)
        dialogs.cancel(id, (_dialog, asker) => asker === frame);
    });
    contents.on("did-redirect-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument)
        mainNavigations.set(id, details.url);
    });
    contents.on("did-navigate", (_event, url, httpResponseCode) => {
      went(id);
      dialogs.navigated(id);
      forgetIntents(id);
      held.delete(id);
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
      forgetIntents(id);
      held.delete(id);
      leaving.delete(id);
      closing.delete(id);
      activated.delete(id);
      pendingSaves.delete(id);
      triedUsernames.delete(id);
      mainNavigations.delete(id);
      goings.delete(id);
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
    clearInterval(frameCheck);
    for (const guestId of [...hosts.keys()]) dialogs.forget(guestId);
    if (current === dialogs) current = null;
    noteIntent = null;
    closeGuard = () => false;
  };
}
