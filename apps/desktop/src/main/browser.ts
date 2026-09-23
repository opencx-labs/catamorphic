import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  Notification,
  type Session,
  screen,
  session,
  shell,
  systemPreferences,
  type WebContents,
  webContents,
} from "electron";
import { z } from "zod";
import { KEYBINDING_ACTIONS, type Keybindings } from "../shared/actions.js";
import type {
  BookmarkMove,
  BookmarkPlacement,
} from "../shared/bookmark-target.js";
import { browserImportRequestSchema } from "../shared/browser-import.js";
import { historyVisitSchema } from "../shared/history.js";
import { matchesShortcut } from "../shared/keybindings.js";
import { OPEN_ACTIONS } from "../shared/open-mode.js";
import {
  type ScreenShareAnswer,
  type ScreenShareRequest,
  type ScreenShareSource,
  type ScreenShareSources,
  type SystemScreenAccess,
  screenShareAnswerSchema,
  tabSourceWebContentsId,
} from "../shared/screen-share.js";
import {
  ALWAYS_GRANTED_PERMISSIONS,
  decideSitePermission,
  permissionKindsFor,
  type SiteDetails,
  type SitePermissionKind,
  type SiteSummary,
  type SystemMediaAccess,
  siteHost,
  siteOrigin,
  sitePermissionAnswerSchema,
  sitePermissionKindSchema,
  sitePermissionStateSchema,
} from "../shared/site-settings.js";
import type { TerminalMacro } from "../shared/terminal-macros.js";
import { BookmarksStore } from "./bookmarks.js";
import { HistoryStore } from "./browser-history.js";
import {
  importBrowserCookies,
  readBrowserCookies,
} from "./browser-import/cookies.js";
import { readBrowserHistory } from "./browser-import/history.js";
import {
  BROWSER_IMPORTERS,
  listImportableBrowsers,
} from "./browser-import/index.js";
import { parsePasswordCsv } from "./browser-import/password-csv.js";
import {
  importBrowserPasswords,
  passwordImportSupport,
  readBrowserKey,
} from "./browser-import/password-native.js";
import { guestWindowOpenAction } from "./browser-popups.js";
import { PasswordVault } from "./browser-vault.js";
import { DownloadsManager, DownloadsStore } from "./downloads.js";
import type { WindowProfileRegistry } from "./index.js";
import { LoginCapture, type LoginSubmission } from "./login-capture.js";
import { generateStrongPassword } from "./password-generator.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { DEFAULT_SIDEBAR_FILE } from "./sidebar-config.js";
import { registerSidebarSources } from "./sidebar-source-ipc.js";
import {
  cookieCoversHost,
  PromptBroker,
  SitePermissionBroker,
  SiteSettingsStore,
} from "./site-settings.js";

/**
 * Browser support for workspace tabs. Pages render in `<webview>` tags in
 * the renderer (they composite into the page, so app overlays like the
 * autocomplete dropdown and chat dock stack correctly); this module owns
 * everything per-profile and main-process-only:
 *  - persistent session partitions (`persist:profile-<id>`) with a clean
 *    Chrome UA so Google sign-in works and survives restarts per profile,
 *  - popup/new-window requests turned into "open new tab" events,
 *  - Cmd+L observed inside page content and forwarded to the address bar,
 *  - browsing history (address-bar autocomplete),
 *  - the KDBX password vault gated by device auth,
 *  - unpacked Chrome extensions loaded per profile.
 */

// Partition → in-flight/settled prepare. A Promise map (not a Set of
// done flags): concurrent callers share one prepare and actually await
// it, and a failed prepare is retried on the next call instead of being
// permanently marked done while half-applied.
const preparedSessions = new Map<string, Promise<void>>();

/**
 * Site permissions (ADR 0150) are decided by the store and prompt broker
 * that `registerBrowserSupport` owns; sessions are prepared lazily and
 * read the policy at request time, so registration order never matters.
 */
interface SitePermissionPolicy {
  request: (
    guest: WebContents,
    profileId: string,
    permission: string,
    details: {
      requestingUrl?: string;
      securityOrigin?: string;
      mediaTypes?: string[];
    },
  ) => Promise<boolean>;
  check: (
    profileId: string,
    permission: string,
    requestingOrigin: string,
    details: { requestingUrl?: string; mediaType?: string },
  ) => boolean;
  /** A page's getDisplayMedia: pick a source in the app's own picker. */
  displayMedia: (
    profileId: string,
    request: Electron.DisplayMediaRequestHandlerHandlerRequest,
    callback: (streams: Electron.Streams) => void,
  ) => void;
}
let sitePermissionPolicy: SitePermissionPolicy | null = null;
/** Downloads (ADR 0153) attach to the manager `registerBrowserSupport` owns. */
let downloadHook:
  | ((
      profileId: string,
      item: Electron.DownloadItem,
      contents: WebContents,
    ) => void)
  | null = null;

/**
 * Chrome's client-hint brand list, derived from the session UA. Google's
 * supported-browser gate reads these; Electron would otherwise advertise
 * only "Chromium". The UA string itself is already Chrome-clean app-wide
 * (see `app.userAgentFallback` in main/index.ts).
 */
function chromeBrands(ua: string): { brands: string; fullVersionList: string } {
  const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? "150";
  const full = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? `${major}.0.0.0`;
  return {
    brands: `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not;A=Brand";v="8"`,
    fullVersionList: `"Google Chrome";v="${full}", "Chromium";v="${full}", "Not;A=Brand";v="8.0.0.0"`,
  };
}

export function partitionFor(profileId: string): string {
  return `persist:profile-${profileId}`;
}

function extensionsDir(profilesDir: string, profileId: string): string {
  return path.join(profilesDir, profileId, "extensions");
}

function prepareProfileSession(
  profilesDir: string,
  profileId: string,
): Promise<void> {
  const partition = partitionFor(profileId);
  const existing = preparedSessions.get(partition);
  if (existing) return existing;
  const prepare = doPrepareProfileSession(profilesDir, partition, profileId);
  preparedSessions.set(partition, prepare);
  prepare.catch(() => preparedSessions.delete(partition));
  return prepare;
}

async function doPrepareProfileSession(
  profilesDir: string,
  partition: string,
  profileId: string,
): Promise<void> {
  const ses = session.fromPartition(partition);
  const { brands, fullVersionList } = chromeBrands(ses.getUserAgent());

  // Header layer: Chromium sends Sec-CH-UA built from its own brand list,
  // which no setUserAgent call covers.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === "sec-ch-ua") headers[name] = brands;
      else if (lower === "sec-ch-ua-full-version-list") {
        headers[name] = fullVersionList;
      }
    }
    callback({ requestHeaders: headers });
  });

  // Chrome-like site permissions: the profile's stored choices answer
  // outright; anything undecided prompts in the site settings modal.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const policy = sitePermissionPolicy;
    if (!policy || !wc) {
      callback(ALWAYS_GRANTED_PERMISSIONS.has(permission));
      return;
    }
    void policy
      .request(wc, profileId, permission, details)
      .then(callback, () => callback(false));
  });
  // Synchronous checks (`Notification.permission`, device labels) only
  // deny what is explicitly blocked; "ask" reads as not-denied so the
  // request handler above gets to prompt.
  ses.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin, details) =>
      sitePermissionPolicy?.check(
        profileId,
        permission,
        requestingOrigin,
        details,
      ) ?? true,
  );
  // Downloads save without a dialog; the manager names the file and
  // keeps the record the dock and the Downloads page show.
  ses.on("will-download", (_event, item, contents) => {
    downloadHook?.(profileId, item, contents);
  });
  // Without a handler getDisplayMedia fails outright; with one, the
  // app's picker chooses a tab, window or screen.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const policy = sitePermissionPolicy;
    if (!policy) {
      callback({});
      return;
    }
    policy.displayMedia(profileId, request, callback);
  });

  // Unpacked Chrome extensions: drop a folder under the profile's
  // extensions dir and it loads on next launch (content scripts, e.g.
  // password-manager extensions' fill logic, work in webviews).
  const dir = extensionsDir(profilesDir, profileId);
  if (fs.existsSync(dir)) {
    // `session.extensions` on modern Electron; fall back to the older
    // session-level API.
    const extensionHost =
      (ses as { extensions?: { loadExtension: Session["loadExtension"] } })
        .extensions ?? ses;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const extPath = path.join(dir, entry.name);
      if (!fs.existsSync(path.join(extPath, "manifest.json"))) continue;
      try {
        await extensionHost.loadExtension(extPath);
        console.log(`[desktop] loaded extension ${entry.name} (${profileId})`);
      } catch (cause) {
        console.warn(
          `[desktop] failed to load extension ${entry.name}:`,
          cause,
        );
      }
    }
  }
}

export interface BrowserSupport {
  history: HistoryStore;
  dispose: () => void;
}

export function registerBrowserSupport(
  profiles: ProfilesStore,
  /** Shared with the config agent so chat edits and IPC hit one store set. */
  profileConfig: ProfileConfigManager,
  windows: WindowProfileRegistry,
  /** Project root lookup for layered sidebar resolution (embedded server). */
  projectRootFor: (projectId: string) => Promise<string | null>,
  sidebarExecutable: () => Promise<string>,
): BrowserSupport {
  const disposeSidebarSources = registerSidebarSources({
    windows,
    profiles,
    config: profileConfig,
    rootFor: projectRootFor,
    executable: sidebarExecutable,
  });
  const userData = app.getPath("userData");
  const profilesDir = path.join(userData, "profiles");
  const history = new HistoryStore(profilesDir);
  const vault = new PasswordVault(profilesDir);
  const siteSettings = new SiteSettingsStore(profilesDir);
  const permissionBroker = new SitePermissionBroker();
  const screenShareBroker = new PromptBroker<
    ScreenShareRequest,
    ScreenShareAnswer
  >();
  const downloads = new DownloadsManager(new DownloadsStore(profilesDir), {
    downloadsDir: () =>
      process.env.CATAMORPHIC_DOWNLOADS_DIR || app.getPath("downloads"),
    broadcast: (profileId, list) => {
      for (const window of windows.windowsFor(profileId))
        if (!window.isDestroyed())
          window.webContents.send("catamorphic:downloads-changed", {
            profileId,
            downloads: list,
          });
    },
  });
  downloadHook = (profileId, item, contents) => {
    const page = contents.isDestroyed() ? "" : contents.getURL();
    const host =
      siteHost(siteOrigin(page) ?? siteOrigin(item.getURL()) ?? "") || null;
    downloads.attach(profileId, item, host);
  };
  const downloadInput = z.object({ id: z.string().min(1) });
  ipcMain.handle("catamorphic:downloads-list", (event) =>
    downloads.list(windows.profileFor(event.sender)),
  );
  ipcMain.handle("catamorphic:downloads-reveal", (event, input: unknown) => {
    const { id } = downloadInput.parse(input);
    const record = downloads.store.get(windows.profileFor(event.sender), id);
    if (!record) return;
    if (fs.existsSync(record.savePath)) shell.showItemInFolder(record.savePath);
    else void shell.openPath(path.dirname(record.savePath));
  });
  ipcMain.handle("catamorphic:downloads-pause", (_event, input: unknown) => {
    downloads.pause(downloadInput.parse(input).id);
  });
  ipcMain.handle("catamorphic:downloads-resume", (_event, input: unknown) => {
    downloads.resume(downloadInput.parse(input).id);
  });
  ipcMain.handle("catamorphic:downloads-cancel", (_event, input: unknown) => {
    downloads.cancel(downloadInput.parse(input).id);
  });
  ipcMain.handle("catamorphic:downloads-remove", (event, input: unknown) => {
    downloads.remove(
      windows.profileFor(event.sender),
      downloadInput.parse(input).id,
    );
  });
  ipcMain.handle("catamorphic:downloads-clear", (event) => {
    downloads.clearFinished(windows.profileFor(event.sender));
  });
  ipcMain.handle("catamorphic:downloads-open-folder", () => {
    const dir =
      process.env.CATAMORPHIC_DOWNLOADS_DIR || app.getPath("downloads");
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  });
  const unsubscribeRemoved = profiles.onRemoved((profileId) => {
    history.releaseProfile(profileId);
    vault.releaseProfile(profileId);
    siteSettings.releaseProfile(profileId);
    preparedSessions.delete(partitionFor(profileId));
  });
  const bookmarks = new BookmarksStore(path.join(userData, "bookmarks.json"));
  const appCommandListeners = new Map<
    BrowserWindow,
    (event: Electron.Event, command: string) => void
  >();

  const attachBrowserCommands = (
    _event: Electron.Event | null,
    window: BrowserWindow,
  ) => {
    const listener = (_commandEvent: Electron.Event, command: string) => {
      const direction =
        command === "browser-backward"
          ? "back"
          : command === "browser-forward"
            ? "forward"
            : null;
      if (!direction) return;
      const focused = webContents.getFocusedWebContents();
      const guestId =
        focused?.getType() === "webview" &&
        focused.hostWebContents === window.webContents
          ? focused.id
          : null;
      window.webContents.send("catamorphic:browser-navigate", {
        webContentsId: guestId,
        direction,
      });
    };
    appCommandListeners.set(window, listener);
    window.on("app-command", listener);
    // macOS three-finger swipe (System Settings → Trackpad → "Swipe between
    // pages"). Two-finger swipes reach the page as wheel events and are
    // handled by the guest preload.
    const onSwipe = (_event: Electron.Event, swipeDirection: string) => {
      const direction =
        swipeDirection === "right"
          ? "back"
          : swipeDirection === "left"
            ? "forward"
            : null;
      if (!direction) return;
      const focused = webContents.getFocusedWebContents();
      const guestId =
        focused?.getType() === "webview" &&
        focused.hostWebContents === window.webContents
          ? focused.id
          : null;
      window.webContents.send("catamorphic:browser-navigate", {
        webContentsId: guestId,
        direction,
      });
    };
    window.on("swipe", onSwipe);
    window.once("closed", () => {
      appCommandListeners.delete(window);
      window.removeListener("swipe", onSwipe);
    });
  };
  app.on("browser-window-created", attachBrowserCommands);
  for (const window of BrowserWindow.getAllWindows()) {
    attachBrowserCommands(null, window);
  }

  interface PendingCredential {
    id: string;
    guestId: number;
    hostId: number;
    profileId: string;
    origin: string;
    username: string;
    password: string;
    /** "update" replaces the password of `credentialId`. */
    mode: "save" | "update";
    credentialId: string | null;
    expiresAt: number;
  }

  const pendingCredentials = new Map<string, PendingCredential>();
  const pendingLifetimeMs = 5 * 60 * 1000;
  const loginCapture = new LoginCapture();
  // The generated password last suggested to each guest, held here so
  // the renderer only ever names it back ("use the suggestion").
  const suggestedPasswords = new Map<
    number,
    { origin: string; password: string }
  >();

  const httpOrigin = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.origin
        : null;
    } catch {
      return null;
    }
  };

  const guestContext = (
    guest: WebContents,
  ): { host: WebContents; profileId: string; origin: string } | null => {
    if (guest.getType() !== "webview") return null;
    const host = guest.hostWebContents;
    const origin = httpOrigin(guest.getURL());
    if (!host || host.isDestroyed() || !origin) return null;
    return { host, profileId: windows.profileFor(host), origin };
  };

  const rendererOwnsGuest = (
    renderer: WebContents,
    guestId: number,
    profileId: string,
  ): WebContents | null => {
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed() || guest.hostWebContents !== renderer) {
      return null;
    }
    if (windows.profileFor(renderer) !== profileId) return null;
    return guest;
  };

  /** A sign-in worked: offer to save it, or to update a changed password. */
  const offerToSave = async (
    guest: WebContents,
    host: WebContents,
    profileId: string,
    submission: LoginSubmission,
  ) => {
    const never = await vault.neverSaved(profileId);
    if (never.includes(submission.origin)) return;
    const match = await vault.match(profileId, submission);
    if (match.status === "same" || guest.isDestroyed() || host.isDestroyed())
      return;
    const id = randomUUID();
    pendingCredentials.set(id, {
      id,
      guestId: guest.id,
      hostId: host.id,
      profileId,
      origin: submission.origin,
      username: submission.username,
      password: submission.password,
      mode: match.status === "changed" ? "update" : "save",
      credentialId: match.status === "changed" ? match.id : null,
      expiresAt: Date.now() + pendingLifetimeMs,
    });
    host.send("catamorphic:browser-credential-save-offer", {
      pendingId: id,
      guestId: guest.id,
      origin: submission.origin,
      username: submission.username,
      mode: match.status === "changed" ? "update" : "save",
    });
    setTimeout(() => pendingCredentials.delete(id), pendingLifetimeMs).unref();
  };

  /** Generated passwords save the moment the form goes out. */
  const saveGenerated = async (
    guest: WebContents,
    host: WebContents,
    profileId: string,
    submission: LoginSubmission,
  ) => {
    const credential = await vault.save(profileId, submission);
    vaultChanged(profileId);
    if (host.isDestroyed()) return;
    host.send("catamorphic:browser-credential-saved", {
      guestId: guest.id,
      origin: submission.origin,
      credential,
    });
  };

  const onLoginForms = (
    event: Electron.IpcMainEvent,
    payload: { origin?: unknown; passwordForms?: unknown; load?: unknown },
  ) => {
    const context = guestContext(event.sender);
    if (
      !context ||
      payload.origin !== context.origin ||
      typeof payload.passwordForms !== "number"
    )
      return;
    const succeeded = loginCapture.formsReported(event.sender.id, {
      origin: context.origin,
      passwordForms: payload.passwordForms,
      load: payload.load === true,
    });
    if (succeeded)
      void offerToSave(
        event.sender,
        context.host,
        context.profileId,
        succeeded,
      ).catch((error: unknown) =>
        console.warn("[browser] Password offer failed:", error),
      );
  };

  const onSubmittedCredentials = (
    event: Electron.IpcMainEvent,
    payload: {
      origin?: unknown;
      username?: unknown;
      password?: unknown;
    },
  ) => {
    const context = guestContext(event.sender);
    if (
      !context ||
      payload.origin !== context.origin ||
      typeof payload.username !== "string" ||
      typeof payload.password !== "string" ||
      payload.password.length === 0
    ) {
      return;
    }
    const submission = loginCapture.submit(event.sender.id, {
      origin: context.origin,
      username: payload.username,
      password: payload.password,
    });
    if (submission?.generated)
      void saveGenerated(
        event.sender,
        context.host,
        context.profileId,
        submission,
      ).catch((error: unknown) =>
        console.warn("[browser] Saving a generated password failed:", error),
      );
  };

  const onSubmittedUsername = (
    event: Electron.IpcMainEvent,
    payload: { origin?: unknown; username?: unknown },
  ) => {
    const context = guestContext(event.sender);
    if (
      !context ||
      payload.origin !== context.origin ||
      typeof payload.username !== "string"
    )
      return;
    loginCapture.rememberUsername(
      event.sender.id,
      context.origin,
      payload.username,
    );
  };

  /** Fill a generated password and remember it for auto-save. */
  const fillGenerated = (
    guest: WebContents,
    origin: string,
    password: string,
    fieldId?: string,
  ) => {
    loginCapture.markGenerated(guest.id, origin, password);
    guest.send("catamorphic:fill-generated", { fieldId, password });
  };

  // --- page notifications (site settings: notifications) ---
  // Chrome shows the site under a notification's title; Electron's own
  // presenter would show only the app. Pages therefore ask the main
  // process (guest preload wraps `Notification`), which also makes the
  // site's stored choice the one that counts.
  const guestNotifications = new Map<
    number,
    { notification: Notification; guest: WebContents; tag: string }
  >();
  let nextGuestNotificationId = 1;
  const notificationPermission = (
    guest: WebContents,
  ): "default" | "granted" | "denied" => {
    const context = guestContext(guest);
    if (!context) return "denied";
    const state = decideSitePermission(
      siteSettings.get(context.profileId, context.origin),
      "notifications",
    );
    return state.outcome === "allow"
      ? "granted"
      : state.outcome === "block"
        ? "denied"
        : "default";
  };
  const onGuestNotificationPermission = (event: Electron.IpcMainEvent) => {
    event.returnValue = notificationPermission(event.sender);
  };
  const onGuestNotificationClose = (
    event: Electron.IpcMainEvent,
    id: unknown,
  ) => {
    const entry =
      typeof id === "number" ? guestNotifications.get(id) : undefined;
    if (entry && entry.guest === event.sender) entry.notification.close();
  };
  ipcMain.on(
    "catamorphic:guest-notification-permission",
    onGuestNotificationPermission,
  );
  ipcMain.on("catamorphic:guest-notification-close", onGuestNotificationClose);
  ipcMain.handle(
    "catamorphic:guest-notification-show",
    (event, input: unknown): number | null => {
      const guest = event.sender;
      const context = guestContext(guest);
      if (
        !context ||
        notificationPermission(guest) !== "granted" ||
        !Notification.isSupported()
      )
        return null;
      const options = z
        .object({
          title: z.string().max(1024),
          body: z.string().max(4096),
          tag: z.string().max(256),
          silent: z.boolean(),
        })
        .parse(input);
      // Chrome replaces an earlier notification carrying the same tag.
      if (options.tag)
        for (const [priorId, entry] of guestNotifications)
          if (entry.guest === guest && entry.tag === options.tag) {
            guestNotifications.delete(priorId);
            entry.notification.close();
          }
      const id = nextGuestNotificationId++;
      const notification = new Notification({
        title: options.title,
        subtitle: siteHost(context.origin),
        body: options.body,
        silent: options.silent,
      });
      const guestId = guest.id;
      const send = (type: "show" | "click" | "close" | "error") => {
        if (!guest.isDestroyed())
          guest.send("catamorphic:guest-notification-event", { id, type });
      };
      notification.on("show", () => send("show"));
      notification.on("click", () => {
        // Chrome brings the tab forward; the window first, then its tab.
        const host = guest.isDestroyed() ? null : guest.hostWebContents;
        const window = host ? BrowserWindow.fromWebContents(host) : null;
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          host?.send("catamorphic:browser-reveal-guest", { guestId });
        }
        send("click");
      });
      notification.on("close", () => {
        guestNotifications.delete(id);
        send("close");
      });
      // macOS refuses posts from an app it has not authorized (or, in
      // development, one that is not signed): the page gets its error.
      notification.on("failed", (_event, error) => {
        console.warn("[browser] Page notification failed:", error);
        guestNotifications.delete(id);
        send("error");
      });
      guestNotifications.set(id, { notification, guest, tag: options.tag });
      notification.show();
      return id;
    },
  );

  ipcMain.on("catamorphic:browser-login-forms", onLoginForms);
  ipcMain.on(
    "catamorphic:browser-credentials-submitted",
    onSubmittedCredentials,
  );
  ipcMain.on("catamorphic:browser-username-submitted", onSubmittedUsername);

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };

  const vaultChanged = (profileId: string) => {
    for (const window of windows.windowsFor(profileId)) {
      window.webContents.send("catamorphic:vault-changed", { profileId });
    }
  };

  const guestBindings = new Map<string, Keybindings>();
  const guestMacros = new Map<string, TerminalMacro[]>();
  profileConfig.onPrefsChanged((profileId, prefs) =>
    guestMacros.set(profileId, prefs.terminalMacros),
  );
  profileConfig.onKeybindingsChanged((profileId, bindings) =>
    guestBindings.set(profileId, bindings),
  );
  // Guests send actions only to their owning window. Match the same configured
  // bindings as the renderer, including Ctrl/Option combinations inside pages.
  app.on("web-contents-created", (_event, contents: WebContents) => {
    if (contents.getType() !== "webview") return;
    // Pages that set no background render on white, as in Chrome. The
    // guest is otherwise transparent, which a tab share captures as black.
    // User-origin CSS: any rule of the page's own wins over it.
    contents.on("dom-ready", () => {
      if (contents.isDestroyed()) return;
      void contents
        // color-scheme too: Chromium's plain-text and image viewers
        // otherwise pick dark text colors from the app's dark scheme and
        // paint them on the white canvas.
        .insertCSS("html{background-color:#fff;color-scheme:light}", {
          cssOrigin: "user",
        })
        .catch(() => {});
    });
    contents.on("preload-error", (_event, preloadPath, error) => {
      console.error("[browser] Guest preload failed", preloadPath, error);
    });
    const openAsTab = (url: string) => {
      const host = contents.hostWebContents;
      if (host && !host.isDestroyed())
        host.send("catamorphic:browser-open-url", { url });
    };
    contents.setWindowOpenHandler(({ url, disposition }) => {
      const action = guestWindowOpenAction({ url, disposition });
      if (action === "popup") {
        const host = contents.hostWebContents;
        const parent = host ? BrowserWindow.fromWebContents(host) : null;
        // A real child window in the opener's session: cookies carry over
        // and `window.opener` works, which sign-in popups depend on.
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            ...(parent ? { parent } : {}),
            autoHideMenuBar: true,
            minimizable: false,
            fullscreenable: false,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webviewTag: false,
            },
          },
        };
      }
      if (action === "tab") openAsTab(url);
      return { action: "deny" };
    });
    // The popup is a plain window, not a guest: anything it opens in turn
    // lands as a workspace tab rather than a window tree.
    contents.on("did-create-window", (popup) => {
      popup.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) openAsTab(url);
        return { action: "deny" };
      });
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const browserDirection =
        input.key === "BrowserBack"
          ? "back"
          : input.key === "BrowserForward"
            ? "forward"
            : null;
      if (
        browserDirection &&
        !input.meta &&
        !input.control &&
        !input.alt &&
        !input.shift
      ) {
        event.preventDefault();
        contents.hostWebContents?.send("catamorphic:browser-navigate", {
          webContentsId: contents.id,
          direction: browserDirection,
        });
        return;
      }
      const host = contents.hostWebContents;
      if (!host || host.isDestroyed()) return;
      const profileId = windows.profileFor(host);
      const bindings =
        guestBindings.get(profileId) ??
        profileConfig.forProfile(profileId).keybindings.load();
      guestBindings.set(profileId, bindings);
      const macros =
        guestMacros.get(profileId) ??
        profileConfig.forProfile(profileId).prefs.load().terminalMacros;
      guestMacros.set(profileId, macros);
      const key = {
        key: input.key,
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
      };
      if (
        !macros.some((macro) =>
          matchesShortcut({
            event: key,
            binding: macro.shortcut,
            mac: process.platform === "darwin",
          }),
        ) &&
        !KEYBINDING_ACTIONS.some(
          (action) =>
            action !== "dismiss-floating" &&
            matchesShortcut({
              event: key,
              binding: bindings[action],
              mac: process.platform === "darwin",
            }),
        )
      )
        return;
      event.preventDefault();
      host.send("catamorphic:browser-guest-key", {
        webContentsId: contents.id,
        key: input.key,
        code: input.code,
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
      });
    });

    contents.on("context-menu", (_event, params) => {
      if (/^https?:\/\//i.test(params.linkURL)) {
        const url = params.linkURL;
        Menu.buildFromTemplate(
          OPEN_ACTIONS.map(({ label, mode }) => ({
            label,
            click: () => {
              if (contents.isDestroyed()) return;
              if (mode === "replace") void contents.loadURL(url);
              else {
                const host = contents.hostWebContents;
                if (host && !host.isDestroyed())
                  host.send("catamorphic:browser-open-url", { url, mode });
              }
            },
          })),
        ).popup();
        return;
      }
      if (params.formControlType !== "input-password") return;
      const context = guestContext(contents);
      if (!context) return;
      void vault.list(context.profileId, context.origin).then((credentials) => {
        if (contents.isDestroyed()) return;
        const stillHere = () =>
          !contents.isDestroyed() &&
          httpOrigin(contents.getURL()) === context.origin;
        const template: Electron.MenuItemConstructorOptions[] = credentials.map(
          (credential) => ({
            label: credential.username || "Saved password",
            click: () => {
              void vault
                .reveal(context.profileId, credential.id)
                .then((revealed) => {
                  if (!revealed || !stillHere()) return;
                  contents.send("catamorphic:fill-credentials", {
                    username: revealed.username,
                    password: revealed.password,
                  });
                });
            },
          }),
        );
        if (template.length > 0) template.push({ type: "separator" });
        template.push({
          label: "Suggest strong password",
          click: () => {
            if (stillHere())
              fillGenerated(contents, context.origin, generateStrongPassword());
          },
        });
        Menu.buildFromTemplate(template).popup();
      });
    });
    // A prompt for a guest that closed would ask about nothing; the
    // window it was sent to takes it back.
    const hostForWithdrawal = contents.hostWebContents;
    contents.once("destroyed", () => {
      loginCapture.forget(contents.id);
      suggestedPasswords.delete(contents.id);
      // Posted notifications stay in Notification Center as in Chrome; the
      // bookkeeping for them goes with the tab.
      for (const [id, entry] of guestNotifications)
        if (entry.guest === contents) guestNotifications.delete(id);
      const ids = permissionBroker.withdrawGuest(contents.id);
      const shareIds = screenShareBroker.withdrawGuest(contents.id);
      if (hostForWithdrawal && !hostForWithdrawal.isDestroyed()) {
        if (ids.length > 0)
          hostForWithdrawal.send("catamorphic:site-permission-withdrawn", {
            ids,
          });
        if (shareIds.length > 0)
          hostForWithdrawal.send("catamorphic:screen-share-withdrawn", {
            ids: shareIds,
          });
      }
    });
  });

  // --- site settings (ADR 0150) ---
  const siteSettingsChanged = (profileId: string, origin: string | null) => {
    for (const window of windows.windowsFor(profileId)) {
      if (!window.isDestroyed())
        window.webContents.send("catamorphic:site-settings-changed", {
          profileId,
          origin,
        });
    }
  };

  const systemMediaAccess = (
    kind: "camera" | "microphone",
  ): SystemMediaAccess => {
    if (process.platform !== "darwin") return null;
    const status = systemPreferences.getMediaAccessStatus(kind);
    if (status === "granted" || status === "not-determined") return status;
    return status === "unknown" ? null : "denied";
  };

  /**
   * macOS gates the camera and microphone per app on top of the site's
   * choice. Prompt the OS the first time, and let the site fail cleanly
   * (rather than hang) when the app itself has been denied.
   */
  const ensureSystemMediaAccess = async (
    kinds: readonly SitePermissionKind[],
  ): Promise<boolean> => {
    if (process.platform !== "darwin") return true;
    for (const kind of kinds) {
      if (kind !== "camera" && kind !== "microphone") continue;
      const status = systemPreferences.getMediaAccessStatus(kind);
      if (status === "granted") continue;
      if (status !== "not-determined") return false;
      if (!(await systemPreferences.askForMediaAccess(kind))) return false;
    }
    return true;
  };

  /**
   * The app's picker for a page's getDisplayMedia. Chromium asks the
   * permission handler first (a `media` request with no media types) and
   * the display-media handler second; picking at the first stage lets a
   * cancel deny the permission, which the page sees as NotAllowedError
   * (Chrome's answer), and the second stage hands over the pick.
   */
  const pendingShares = new Map<number, Electron.Streams>();
  const pickShare = async (input: {
    guest: WebContents;
    host: WebContents;
    profileId: string;
    origin: string;
  }): Promise<Electron.Streams | null> => {
    const { guest, host } = input;
    const answer = await screenShareBroker.ask(
      input.profileId,
      { id: randomUUID(), guestId: guest.id, origin: input.origin },
      (prompt) => host.send("catamorphic:screen-share-request", prompt),
    );
    const choice = answer?.choice;
    if (!choice) return null;
    const tabId = tabSourceWebContentsId(choice.id);
    if (choice.kind === "tab" && tabId !== null) {
      const tab = webContents.fromId(tabId);
      // Only a tab of the same window: the picker listed exactly those.
      if (!tab || tab.isDestroyed() || tab.hostWebContents !== host)
        return null;
      return { video: tab.mainFrame };
    }
    return { video: { id: choice.id, name: choice.name } };
  };

  sitePermissionPolicy = {
    request: async (guest, profileId, permission, details) => {
      const origin = siteOrigin(details.requestingUrl ?? guest.getURL());
      if (!origin) return ALWAYS_GRANTED_PERMISSIONS.has(permission);
      const decision = decideSitePermission(
        siteSettings.get(profileId, origin),
        permission,
        details,
      );
      if (decision.outcome === "block") return false;
      if (
        permission === "media" &&
        permissionKindsFor(permission, details).every(
          (kind) => kind === "screenShare",
        )
      ) {
        const host = guest.hostWebContents;
        if (!host || host.isDestroyed()) return false;
        const streams = await pickShare({ guest, host, profileId, origin });
        if (!streams) return false;
        pendingShares.set(guest.id, streams);
        return true;
      }
      if (decision.outcome === "allow") {
        return ensureSystemMediaAccess(
          permission === "media"
            ? (details.mediaTypes ?? []).flatMap((type) =>
                type === "audio"
                  ? ["microphone" as const]
                  : type === "video"
                    ? ["camera" as const]
                    : [],
              )
            : [],
        );
      }
      const host = guest.hostWebContents;
      if (!host || host.isDestroyed()) return false;
      const answer = await permissionBroker.askPermission(
        { profileId, origin, guestId: guest.id, kinds: decision.kinds },
        (request) => host.send("catamorphic:site-permission-request", request),
      );
      if (!answer) return false;
      if (answer.remember) {
        for (const kind of decision.kinds)
          siteSettings.set(profileId, origin, kind, answer.decision);
        siteSettingsChanged(profileId, origin);
      }
      if (answer.decision === "block") return false;
      return ensureSystemMediaAccess(decision.kinds);
    },
    check: (profileId, permission, requestingOrigin, details) => {
      const origin = siteOrigin(details.requestingUrl ?? requestingOrigin);
      if (!origin) return ALWAYS_GRANTED_PERMISSIONS.has(permission);
      const decision = decideSitePermission(
        siteSettings.get(profileId, origin),
        permission,
        { mediaTypes: details.mediaType ? [details.mediaType] : undefined },
      );
      // Notifications need a granted state to post (Chrome refuses at
      // "default" too); frames and workers outside the main-world wrapper
      // would otherwise post from an undecided site without a prompt.
      // requestPermission still reaches the request handler regardless.
      if (permission === "notifications") return decision.outcome === "allow";
      return decision.outcome !== "block";
    },
    displayMedia: (profileId, request, callback) => {
      const guest = request.frame ? webContents.fromFrame(request.frame) : null;
      const origin = siteOrigin(request.securityOrigin);
      const host = guest?.hostWebContents;
      if (
        guest?.getType() !== "webview" ||
        !origin ||
        !host ||
        host.isDestroyed() ||
        decideSitePermission(
          siteSettings.get(profileId, origin),
          "display-capture",
        ).outcome === "block"
      ) {
        callback({});
        return;
      }
      const stashed = pendingShares.get(guest.id);
      pendingShares.delete(guest.id);
      const deliver = (streams: Electron.Streams | null) => {
        if (!streams) {
          callback({});
          return;
        }
        // A shared tab carries its audio when the page asked for audio
        // (Chrome's default); windows and screens have none to give.
        const frame =
          streams.video && !("id" in streams.video) ? streams.video : null;
        callback(
          request.audioRequested && frame
            ? { video: frame, audio: frame, enableLocalEcho: true }
            : { video: streams.video },
        );
      };
      if (stashed) {
        deliver(stashed);
        return;
      }
      void pickShare({ guest, host, profileId, origin }).then(deliver);
    },
  };

  const systemScreenAccess = (): SystemScreenAccess => {
    if (process.platform !== "darwin") return null;
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status === "granted" || status === "not-determined") return status;
    return status === "unknown" ? null : "denied";
  };

  ipcMain.handle(
    "catamorphic:screen-share-sources",
    async (event, input: unknown): Promise<ScreenShareSources> => {
      const { guestId, kinds } = z
        .object({
          guestId: z.number().int().optional(),
          kinds: z.array(z.enum(["tab", "window", "screen"])).optional(),
        })
        .parse(input ?? {});
      const wanted = new Set(kinds ?? ["tab", "window", "screen"]);
      const thumbnailSize = { width: 360, height: 225 };
      const profileId = windows.profileFor(event.sender);
      const visits = wanted.has("tab") ? history.siteVisits(profileId) : null;
      const tabs = wanted.has("tab")
        ? await Promise.all(
            webContents
              .getAllWebContents()
              .filter(
                (contents) =>
                  contents.getType() === "webview" &&
                  contents.hostWebContents === event.sender &&
                  /^https?:/i.test(contents.getURL()),
              )
              .map(async (contents): Promise<ScreenShareSource> => {
                const thumbnail = await contents
                  .capturePage()
                  .then((image) =>
                    image.isEmpty()
                      ? null
                      : image
                          .resize({ width: thumbnailSize.width })
                          .toDataURL(),
                  )
                  .catch(() => null);
                const url = contents.getURL();
                return {
                  id: `tab:${contents.id}`,
                  kind: "tab",
                  name: contents.getTitle() || url,
                  thumbnail,
                  icon: visits?.get(siteOrigin(url) ?? "")?.faviconUrl ?? null,
                  url,
                  current: contents.id === guestId,
                };
              }),
          )
        : [];
      const captureKinds = (["screen", "window"] as const).filter((kind) =>
        wanted.has(kind),
      );
      const captured =
        captureKinds.length > 0
          ? await desktopCapturer
              .getSources({
                types: [...captureKinds],
                thumbnailSize,
                fetchWindowIcons: true,
              })
              .catch(() => [])
          : [];
      const toSource = (
        source: Electron.DesktopCapturerSource,
        kind: "screen" | "window",
      ): ScreenShareSource => ({
        id: source.id,
        kind,
        name: source.name,
        thumbnail: source.thumbnail.isEmpty()
          ? null
          : source.thumbnail.toDataURL(),
        icon:
          source.appIcon && !source.appIcon.isEmpty()
            ? source.appIcon.resize({ width: 32 }).toDataURL()
            : null,
      });
      let screens = captured
        .filter((source) => source.id.startsWith("screen:"))
        .map((source) => toSource(source, "screen"));
      // macOS lists no screens when Screen Recording access is stale or
      // missing; the displays still exist and their ids are what the
      // capturer would have used, so sharing can still be attempted.
      if (wanted.has("screen") && screens.length === 0) {
        const displays = screen.getAllDisplays();
        screens = displays.map((display, index) => ({
          id: `screen:${display.id}:0`,
          kind: "screen",
          name: displays.length === 1 ? "Entire screen" : `Screen ${index + 1}`,
          thumbnail: null,
          icon: null,
        }));
      }
      return {
        tabs,
        windows: captured
          .filter((source) => source.id.startsWith("window:"))
          .map((source) => toSource(source, "window")),
        screens,
        system: systemScreenAccess(),
      };
    },
  );

  ipcMain.handle("catamorphic:screen-share-answer", (event, input: unknown) => {
    const answer = screenShareAnswerSchema.parse(input);
    return (
      screenShareBroker.answer(
        answer.requestId,
        answer,
        windows.profileFor(event.sender),
      ) !== null
    );
  });

  const siteCookies = async (profileId: string, host: string) => {
    await prepareProfileSession(profilesDir, profileId);
    const jar = session.fromPartition(partitionFor(profileId)).cookies;
    return (await jar.get({})).filter((cookie) =>
      cookieCoversHost(cookie.domain ?? "", host),
    );
  };

  const siteSummary = async (
    profileId: string,
    origin: string,
  ): Promise<SiteSummary> => {
    const host = siteHost(origin);
    const visit = history.siteVisits(profileId).get(origin);
    return {
      origin,
      host,
      permissions: siteSettings.get(profileId, origin),
      cookies: (await siteCookies(profileId, host)).length,
      lastVisitAt: visit?.lastVisitAt ?? null,
      faviconUrl: visit?.faviconUrl ?? null,
    };
  };

  const originInput = z.object({ origin: z.string().url() });

  ipcMain.handle(
    "catamorphic:site-settings-get",
    async (event, input: unknown): Promise<SiteDetails> => {
      const { origin } = originInput.parse(input);
      const profileId = windows.profileFor(event.sender);
      return {
        ...(await siteSummary(profileId, origin)),
        system: {
          camera: systemMediaAccess("camera"),
          microphone: systemMediaAccess("microphone"),
        },
      };
    },
  );

  ipcMain.handle("catamorphic:site-settings-set", (event, input: unknown) => {
    const { origin, kind, state } = z
      .object({
        origin: z.string().url(),
        kind: sitePermissionKindSchema,
        state: sitePermissionStateSchema,
      })
      .parse(input);
    const profileId = windows.profileFor(event.sender);
    const permissions = siteSettings.set(profileId, origin, kind, state);
    siteSettingsChanged(profileId, origin);
    return permissions;
  });

  ipcMain.handle("catamorphic:site-settings-reset", (event, input: unknown) => {
    const { origin } = originInput.parse(input);
    const profileId = windows.profileFor(event.sender);
    siteSettings.reset(profileId, origin);
    siteSettingsChanged(profileId, origin);
  });

  ipcMain.handle(
    "catamorphic:site-settings-clear-data",
    async (event, input: unknown) => {
      const { origin } = originInput.parse(input);
      const profileId = windows.profileFor(event.sender);
      const ses = session.fromPartition(partitionFor(profileId));
      const host = siteHost(origin);
      // Per-origin storage first; then every cookie the site can read,
      // which includes parent-domain cookies clearStorageData's origin
      // filter leaves alone.
      await ses.clearStorageData({
        origin,
        storages: [
          "cookies",
          "filesystem",
          "indexdb",
          "localstorage",
          "shadercache",
          "serviceworkers",
          "cachestorage",
        ],
      });
      for (const cookie of await siteCookies(profileId, host)) {
        const domain = (cookie.domain ?? host).replace(/^\./, "");
        await ses.cookies
          .remove(
            `${cookie.secure ? "https" : "http"}://${domain}${cookie.path ?? "/"}`,
            cookie.name,
          )
          .catch(() => {});
      }
      await ses.cookies.flushStore();
      await ses.clearCodeCaches({ urls: [origin] }).catch(() => {});
      siteSettingsChanged(profileId, origin);
    },
  );

  ipcMain.handle(
    "catamorphic:site-settings-list",
    async (event): Promise<SiteSummary[]> => {
      const profileId = windows.profileFor(event.sender);
      const origins = new Set<string>(siteSettings.origins(profileId));
      const visits = history.siteVisits(profileId);
      for (const origin of visits.keys()) origins.add(origin);
      await prepareProfileSession(profilesDir, profileId);
      const cookies = await session
        .fromPartition(partitionFor(profileId))
        .cookies.get({});
      const hosts = [...origins].map(siteHost);
      for (const cookie of cookies) {
        const domain = (cookie.domain ?? "").replace(/^\./, "");
        if (!domain || hosts.some((host) => cookieCoversHost(domain, host)))
          continue;
        const origin = `${cookie.secure ? "https" : "http"}://${domain}`;
        origins.add(origin);
        hosts.push(domain);
      }
      const sites = [...origins].map((origin): SiteSummary => {
        const host = siteHost(origin);
        const visit = visits.get(origin);
        return {
          origin,
          host,
          permissions: siteSettings.get(profileId, origin),
          cookies: cookies.filter((cookie) =>
            cookieCoversHost(cookie.domain ?? "", host),
          ).length,
          lastVisitAt: visit?.lastVisitAt ?? null,
          faviconUrl: visit?.faviconUrl ?? null,
        };
      });
      return sites
        .sort(
          (a, b) =>
            Number(Object.keys(b.permissions).length > 0) -
              Number(Object.keys(a.permissions).length > 0) ||
            (b.lastVisitAt ?? 0) - (a.lastVisitAt ?? 0) ||
            b.cookies - a.cookies ||
            a.host.localeCompare(b.host),
        )
        .slice(0, 500);
    },
  );

  ipcMain.handle(
    "catamorphic:site-permission-answer",
    (event, input: unknown) => {
      const answer = sitePermissionAnswerSchema.parse(input);
      // Only a window of the profile the prompt was sent to may answer it.
      return (
        permissionBroker.answer(
          answer.id,
          answer,
          windows.profileFor(event.sender),
        ) !== null
      );
    },
  );

  ipcMain.handle(
    "catamorphic:site-settings-open-system-privacy",
    async (_event, input: unknown) => {
      const { kind } = z
        .object({ kind: z.enum(["camera", "microphone", "screen"]) })
        .parse(input);
      if (process.platform !== "darwin") return;
      const pane =
        kind === "camera"
          ? "Camera"
          : kind === "microphone"
            ? "Microphone"
            : "ScreenCapture";
      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`,
      );
    },
  );

  ipcMain.handle(
    "catamorphic:browser-prepare-profile",
    async (_event, profileId: string) => {
      await prepareProfileSession(profilesDir, profileId);
      return partitionFor(profileId);
    },
  );

  const historyChanged = (profileId: string) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed() &&
        windows.profileFor(window.webContents) === profileId
      )
        window.webContents.send("catamorphic:history-changed");
    }
  };
  ipcMain.handle("catamorphic:history-query", (event, input: unknown) => {
    const query = z
      .object({
        query: z.string().max(4096).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200).optional(),
      })
      .parse(input);
    return history.query({
      profileId: windows.profileFor(event.sender),
      ...query,
    });
  });
  ipcMain.handle("catamorphic:history-record", (event, input: unknown) => {
    const { visit, revisit } = z
      .object({ visit: historyVisitSchema, revisit: z.boolean() })
      .parse(input);
    const profileId = windows.profileFor(event.sender);
    if (
      visit.target.kind !== "web" &&
      !profiles.get(profileId)?.projectIds.includes(visit.target.projectId)
    )
      return;
    history.recordVisit({ profileId, visit, revisit });
    historyChanged(profileId);
  });
  ipcMain.handle("catamorphic:history-remove", (event, id: unknown) => {
    const profileId = windows.profileFor(event.sender);
    history.remove({ profileId, id: z.string().parse(id) });
    historyChanged(profileId);
  });
  ipcMain.handle("catamorphic:history-clear", (event) => {
    const profileId = windows.profileFor(event.sender);
    history.clear(profileId);
    historyChanged(profileId);
  });

  ipcMain.handle(
    "catamorphic:browser-history-record",
    (event, input: { profileId: string; url: string; title: string }) => {
      history.record(windows.profileFor(event.sender), input.url, input.title);
      historyChanged(windows.profileFor(event.sender));
    },
  );

  ipcMain.handle(
    "catamorphic:browser-history-retitle",
    (event, input: { profileId: string; url: string; title: string }) => {
      history.retitle(windows.profileFor(event.sender), input.url, input.title);
      historyChanged(windows.profileFor(event.sender));
    },
  );
  ipcMain.handle(
    "catamorphic:browser-history-favicon",
    (event, input: { profileId: string; url: string; faviconUrl: string }) => {
      const profileId = windows.profileFor(event.sender);
      history.setFavicon(profileId, input.url, input.faviconUrl);
      // Bookmarks of the page (imported ones have no icon) learn it too.
      const projectIds = profiles.get(profileId)?.projectIds ?? [];
      const changed = bookmarks.observeFavicon({
        profileId,
        projectIds,
        url: input.url,
        faviconUrl: input.faviconUrl,
      });
      // Pinned and library changes ride along with any project's payload.
      for (const projectId of changed.profileChanged
        ? projectIds
        : changed.projectIds)
        bookmarksChanged(projectId, profileId);
    },
  );

  ipcMain.handle(
    "catamorphic:browser-suggest",
    (event, input: { profileId: string; query: string }) => ({
      matches: history.suggest(windows.profileFor(event.sender), input.query),
      inline: history.inlineMatch(
        windows.profileFor(event.sender),
        input.query,
      ),
    }),
  );

  // --- profiles ---
  ipcMain.handle("catamorphic:profiles-list", () => profiles.list());
  ipcMain.handle("catamorphic:profiles-create", (_event, name: string) => {
    const profile = profiles.create(name);
    broadcast("catamorphic:profiles-changed", profiles.list());
    return profile;
  });
  ipcMain.handle(
    "catamorphic:profiles-update",
    (
      _event,
      id: string,
      patch: { name?: string; color?: string; defaultProjectId?: string },
    ) => {
      const profile = profiles.update(id, patch);
      broadcast("catamorphic:profiles-changed", profiles.list());
      return profile;
    },
  );
  ipcMain.handle("catamorphic:profiles-set-default", (_event, id: string) => {
    profiles.setDefaultProfile(id);
    broadcast("catamorphic:profiles-changed", profiles.list());
  });
  ipcMain.handle("catamorphic:profiles-remove", (_event, id: string) => {
    const removed = profiles.remove(id);
    if (removed) broadcast("catamorphic:profiles-changed", profiles.list());
    return removed;
  });
  ipcMain.handle(
    "catamorphic:profiles-claim-project",
    (_event, profileId: string, projectId: string) => {
      profiles.claimProject(profileId, projectId);
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );
  ipcMain.handle(
    "catamorphic:profiles-for-project",
    (_event, projectId: string) => profiles.profileForProject(projectId),
  );
  ipcMain.handle(
    "catamorphic:profiles-release-project",
    (_event, projectId: string) => {
      profiles.releaseProject(projectId);
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );

  // --- passwords ---
  const credentialInput = z.object({
    origin: z.string().max(2048),
    username: z.string().max(1024),
    note: z.string().max(10_000).optional(),
  });
  ipcMain.handle(
    "catamorphic:vault-list",
    (_event, input: { profileId: string; origin?: string }) =>
      vault.list(input.profileId, input.origin),
  );
  ipcMain.handle(
    "catamorphic:vault-reveal",
    (_event, input: { profileId: string; id: string }) =>
      vault.reveal(input.profileId, input.id),
  );
  ipcMain.handle("catamorphic:vault-update", async (_event, raw: unknown) => {
    const input = credentialInput
      .extend({
        profileId: z.string(),
        id: z.string(),
        password: z.string().min(1).max(4096).optional(),
      })
      .parse(raw);
    const updated = await vault.update(input.profileId, input.id, {
      origin: input.origin,
      username: input.username,
      password: input.password,
      note: input.note,
    });
    if (updated) vaultChanged(input.profileId);
    return updated;
  });
  ipcMain.handle("catamorphic:vault-save", async (_event, raw: unknown) => {
    const input = credentialInput
      .extend({ profileId: z.string(), password: z.string().min(1).max(4096) })
      .parse(raw);
    const saved = await vault.save(input.profileId, {
      origin: input.origin,
      username: input.username,
      password: input.password,
      note: input.note,
    });
    vaultChanged(input.profileId);
    return saved;
  });
  ipcMain.handle("catamorphic:vault-generate-password", () =>
    generateStrongPassword(),
  );
  ipcMain.handle(
    "catamorphic:vault-never-saved",
    (_event, input: { profileId: string }) => vault.neverSaved(input.profileId),
  );
  ipcMain.handle(
    "catamorphic:vault-allow-saving",
    async (_event, input: { profileId: string; origin: string }) => {
      await vault.setNeverSave(input.profileId, input.origin, false);
      vaultChanged(input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:vault-copy-password",
    async (_event, input: { profileId: string; id: string }) => {
      const credential = await vault.reveal(input.profileId, input.id);
      if (!credential) return false;
      await clipboard.writeText(credential.password);
      // Electron 44: clipboard reads are asynchronous.
      setTimeout(() => {
        void Promise.resolve(clipboard.readText()).then((text) => {
          if (text === credential.password) return clipboard.clear();
        });
      }, 30_000).unref();
      return true;
    },
  );
  /** A save offer the calling window may still answer, or null. */
  const takePending = (
    renderer: WebContents,
    profileId: string,
    pendingId: string,
  ): PendingCredential | null => {
    const pending = pendingCredentials.get(pendingId);
    if (
      !pending ||
      pending.expiresAt < Date.now() ||
      pending.profileId !== profileId ||
      pending.hostId !== renderer.id ||
      windows.profileFor(renderer) !== profileId
    )
      return null;
    pendingCredentials.delete(pendingId);
    return pending;
  };
  ipcMain.handle(
    "catamorphic:browser-credential-accept",
    async (event, input: { profileId: string; pendingId: string }) => {
      const pending = takePending(
        event.sender,
        input.profileId,
        input.pendingId,
      );
      if (!pending) return null;
      const saved =
        pending.mode === "update" && pending.credentialId
          ? await vault.update(input.profileId, pending.credentialId, {
              origin: pending.origin,
              username: pending.username,
              password: pending.password,
            })
          : await vault.save(input.profileId, pending);
      vaultChanged(input.profileId);
      return saved;
    },
  );
  ipcMain.handle(
    "catamorphic:browser-credential-never",
    async (event, input: { profileId: string; pendingId: string }) => {
      const pending = takePending(
        event.sender,
        input.profileId,
        input.pendingId,
      );
      if (!pending) return false;
      await vault.setNeverSave(input.profileId, pending.origin, true);
      vaultChanged(input.profileId);
      return true;
    },
  );
  ipcMain.handle(
    "catamorphic:browser-credential-dismiss",
    (event, input: { pendingId: string }) => {
      const pending = pendingCredentials.get(input.pendingId);
      if (pending?.hostId === event.sender.id) {
        pendingCredentials.delete(input.pendingId);
      }
    },
  );
  ipcMain.handle(
    "catamorphic:browser-password-suggest",
    (event, input: { profileId: string; guestId: number }) => {
      const guest = rendererOwnsGuest(
        event.sender,
        input.guestId,
        input.profileId,
      );
      const origin = guest ? httpOrigin(guest.getURL()) : null;
      if (!guest || !origin) return null;
      // One suggestion per page visit, as Chrome keeps it while the
      // field stays the same.
      const current = suggestedPasswords.get(guest.id);
      const password =
        current?.origin === origin
          ? current.password
          : generateStrongPassword();
      suggestedPasswords.set(guest.id, { origin, password });
      return { password };
    },
  );
  ipcMain.handle(
    "catamorphic:browser-password-use-suggested",
    (
      event,
      input: { profileId: string; guestId: number; fieldId?: string },
    ) => {
      const guest = rendererOwnsGuest(
        event.sender,
        input.guestId,
        input.profileId,
      );
      const suggestion = guest ? suggestedPasswords.get(guest.id) : undefined;
      if (
        !guest ||
        !suggestion ||
        httpOrigin(guest.getURL()) !== suggestion.origin
      )
        return false;
      suggestedPasswords.delete(guest.id);
      fillGenerated(
        guest,
        suggestion.origin,
        suggestion.password,
        input.fieldId,
      );
      return true;
    },
  );
  ipcMain.handle(
    "catamorphic:browser-credential-fill",
    async (
      event,
      input: {
        profileId: string;
        guestId: number;
        credentialId: string;
        fieldId?: string;
        origin: string;
      },
    ) => {
      const guest = rendererOwnsGuest(
        event.sender,
        input.guestId,
        input.profileId,
      );
      if (!guest || httpOrigin(guest.getURL()) !== input.origin) {
        return "origin-changed" as const;
      }
      const credential = await vault.reveal(
        input.profileId,
        input.credentialId,
      );
      if (!credential || credential.origin !== input.origin) {
        return "cancelled" as const;
      }
      if (
        guest.isDestroyed() ||
        guest.hostWebContents !== event.sender ||
        windows.profileFor(event.sender) !== input.profileId ||
        httpOrigin(guest.getURL()) !== input.origin
      ) {
        return "origin-changed" as const;
      }
      guest.send("catamorphic:fill-credentials", {
        fieldId: input.fieldId,
        username: credential.username,
        password: credential.password,
      });
      return "filled" as const;
    },
  );
  ipcMain.handle(
    "catamorphic:vault-remove",
    async (_event, input: { profileId: string; id: string }) => {
      await vault.remove(input.profileId, input.id);
      vaultChanged(input.profileId);
    },
  );
  ipcMain.handle("catamorphic:device-auth-available", () =>
    process.platform === "darwin"
      ? systemPreferences.canPromptTouchID()
      : false,
  );

  // --- bookmarks ---
  const bookmarksChanged = (projectId: string, profileId: string) =>
    broadcast("catamorphic:bookmarks-changed", {
      projectId,
      project: bookmarks.forProject(projectId),
      profileId,
      pinned: bookmarks.pinned(profileId),
      library: bookmarks.library(profileId),
    });

  ipcMain.handle(
    "catamorphic:bookmarks-get",
    (_event, input: { projectId: string; profileId: string }) => ({
      project: bookmarks.forProject(input.projectId),
      pinned: bookmarks.pinned(input.profileId),
      library: bookmarks.library(input.profileId),
    }),
  );
  ipcMain.handle(
    "catamorphic:bookmarks-add",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        label: string;
        url: string;
        folderId?: string;
        faviconUrl?: string;
      },
    ) => {
      const bookmark = bookmarks.addBookmark(input.projectId, input);
      bookmarksChanged(input.projectId, input.profileId);
      return bookmark;
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-place",
    (_event, input: BookmarkPlacement) => {
      const bookmark = bookmarks.place(input);
      bookmarksChanged(input.projectId, input.profileId);
      return bookmark;
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-move",
    (_event, input: BookmarkMove) => {
      bookmarks.move(input);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-add-folder",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        label: string;
        parentId?: string;
      },
    ) => {
      const folder = bookmarks.addFolder(
        input.projectId,
        input.label,
        input.parentId,
      );
      bookmarksChanged(input.projectId, input.profileId);
      return folder;
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-update",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        id: string;
        label?: string;
        url?: string;
        folderId?: string | null;
      },
    ) => {
      bookmarks.update(input.projectId, input.id, input);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-remove",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.remove(input.projectId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-pin",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.pin(input.projectId, input.profileId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-unpin",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.unpin(input.profileId, input.projectId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-rename",
    (
      _event,
      input: {
        projectId: string;
        profileId: string;
        id: string;
        label: string;
      },
    ) => {
      bookmarks.rename(input.projectId, input.profileId, input.id, input.label);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  ipcMain.handle(
    "catamorphic:bookmarks-remove-pinned",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.removePinned(input.profileId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );

  ipcMain.handle(
    "catamorphic:bookmarks-remove-library",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.removeLibrary(input.profileId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );

  // --- sidebar config (per sender profile) ---
  const sidebarFor = (event: Electron.IpcMainInvokeEvent) =>
    profileConfig.forProfile(windows.profileFor(event.sender)).sidebar;

  // Layered per project (ADR 0043): project-local override → project
  // `.catamorphic/sidebar.js` → profile `sidebar.js` → built-in default.
  // Without a projectId only the profile layer applies (boot, settings).
  // The `-file`/`-source`/`-reset` handlers below stay profile-scoped:
  // they back the Settings "edit sidebar.js" surface.
  ipcMain.handle(
    "catamorphic:sidebar-config-get",
    async (event, projectId?: string) => {
      const profileId = windows.profileFor(event.sender);
      if (!projectId) return profileConfig.resolveSidebar(profileId);
      return profileConfig.resolveSidebar(profileId, {
        id: projectId,
        rootPath: await projectRootFor(projectId),
      });
    },
  );
  ipcMain.handle(
    "catamorphic:sidebar-config-file",
    (event) => sidebarFor(event).file,
  );
  ipcMain.handle("catamorphic:sidebar-config-source", (event) =>
    sidebarFor(event).read(),
  );
  ipcMain.handle("catamorphic:sidebar-config-reset", (event) => {
    sidebarFor(event).write(DEFAULT_SIDEBAR_FILE);
  });
  // Change fan-out lives in main/index.ts (profileConfig.onSidebarChanged),
  // scoped to the owning profile's windows.

  // --- import from other browsers ---
  // Detection + parsing lives in ./browser-import (pure, per-browser).
  // Imported bookmarks land in a profile's bookmark library; a source profile
  // can also become a brand-new Work profile.
  const passwordHelperPath = app.isPackaged
    ? path.join(process.resourcesPath, "..", "MacOS", "browser-keychain")
    : path.join(
        app.getAppPath(),
        "native",
        "browser-import",
        "bin",
        "browser-keychain",
      );
  const nativeImportSupport = () =>
    passwordImportSupport({ helperPath: passwordHelperPath });
  const importingProfiles = new Set<string>();
  ipcMain.handle("catamorphic:browser-import-list", () => {
    const native = nativeImportSupport().available;
    return listImportableBrowsers().map((browser) => ({
      ...browser,
      profiles: browser.profiles.map((profile) => ({
        ...profile,
        hasPasswords: native && Boolean(profile.hasPasswords),
        hasSessions:
          Boolean(profile.hasSessions) && (browser.id === "firefox" || native),
      })),
    }));
  });
  ipcMain.handle(
    "catamorphic:browser-import-run",
    async (event, raw: unknown) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Open browser import in Work.");
      const input = browserImportRequestSchema.parse(raw);
      const profileId = input.targetProfileId;
      if (!profiles.get(profileId))
        throw new Error("Choose a Work profile again.");
      if (importingProfiles.has(profileId))
        throw new Error("An import is already running.");
      const importer = BROWSER_IMPORTERS.find(
        ({ id }) => id === input.browserId,
      );
      if (
        !importer
          ?.detect()
          ?.profiles.some(({ id }) => id === input.sourceProfileId)
      )
        throw new Error(
          "The browser profile is no longer available. Scan again.",
        );
      const selected = new Set(input.categories);
      const passwords =
        selected.has("passwords") && nativeImportSupport().available
          ? importer.passwordSource?.(input.sourceProfileId)
          : null;
      const cookies = selected.has("sessions")
        ? importer.cookieSource?.(input.sourceProfileId)
        : null;
      const sourceKey =
        passwords ??
        (nativeImportSupport().available ? cookies?.keychain : null);
      const controller = new AbortController();
      const abort = () => controller.abort();
      event.sender.once("destroyed", abort);
      importingProfiles.add(profileId);
      let key: Buffer | null = null;
      let completed = 0;
      try {
        if (sourceKey) {
          key = await readBrowserKey({
            helperPath: passwordHelperPath,
            source: sourceKey,
            signal: controller.signal,
          });
          if (!key) return { cancelled: true };
        }
        const checkActive = () => {
          if (controller.signal.aborted || !profiles.get(profileId))
            throw new Error("Import cancelled.");
        };
        checkActive();
        const attempt = async (operation: () => void | Promise<void>) => {
          checkActive();
          try {
            await operation();
            completed++;
          } catch {
            /* No per-category failure reports or sensitive source data in logs. */
          }
        };
        if (selected.has("bookmarks"))
          await attempt(() => {
            bookmarks.importBookmarks(
              profileId,
              importer.readBookmarks(input.sourceProfileId),
            );
            broadcast("catamorphic:bookmarks-changed", {
              projectId: null,
              project: null,
              profileId,
              pinned: bookmarks.pinned(profileId),
              library: bookmarks.library(profileId),
            });
          });
        if (selected.has("history"))
          await attempt(() => {
            const file = importer.historyFile?.(input.sourceProfileId);
            if (!file) throw new Error("History unavailable");
            history.import({
              profileId,
              entries: readBrowserHistory({
                file,
                firefox: importer.id === "firefox",
              }),
            });
            historyChanged(profileId);
          });
        if (passwords)
          await attempt(async () => {
            await importBrowserPasswords({
              source: passwords,
              existing: await vault.list(profileId),
              readKey: async () => (key ? Buffer.from(key) : null),
              save: async (credentials) => {
                checkActive();
                return vault.importMissing({ profileId, credentials });
              },
            });
            vaultChanged(profileId);
          });
        if (cookies)
          await attempt(async () => {
            await prepareProfileSession(profilesDir, profileId);
            const jar = session.fromPartition(partitionFor(profileId)).cookies;
            await importBrowserCookies({
              cookies: readBrowserCookies({ source: cookies, key }),
              existing: await jar.get({}),
              save: async (cookie) => {
                checkActive();
                const current = await jar.get({
                  name: cookie.name,
                  url: cookie.url,
                });
                if (
                  !current.some(
                    (entry) =>
                      entry.domain ===
                        (cookie.domain ?? new URL(cookie.url).hostname) &&
                      entry.path === cookie.path,
                  )
                )
                  await jar.set(cookie);
              },
            });
            await jar.flushStore();
          });
        checkActive();
        if (!completed)
          throw new Error(
            "Import could not finish. Close the source browser and try again.",
          );
        profiles.markBrowserImported(profileId);
        broadcast("catamorphic:profiles-changed", profiles.list());
        return { cancelled: false };
      } catch (error) {
        return {
          cancelled: controller.signal.aborted,
          error:
            error instanceof Error
              ? error.message
              : "Import could not finish. Try again.",
        };
      } finally {
        key?.fill(0);
        importingProfiles.delete(profileId);
        if (!event.sender.isDestroyed())
          event.sender.removeListener("destroyed", abort);
      }
    },
  );

  ipcMain.handle(
    "catamorphic:browser-import-passwords",
    async (event, input: unknown) => {
      const { profileId } = z.object({ profileId: z.string() }).parse(input);
      if (!profiles.get(profileId)) throw new Error("Choose a profile again.");
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return { imported: 0, cancelled: true };
      const picked = await dialog.showOpenDialog(window, {
        title: "Import passwords from Chrome or Firefox",
        properties: ["openFile"],
        filters: [{ name: "Password CSV", extensions: ["csv"] }],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return { imported: 0, cancelled: true };
      const imported = parsePasswordCsv(fs.readFileSync(file, "utf-8"));
      const result = await vault.importMissing({
        profileId,
        credentials: imported,
      });
      if (result.imported > 0) vaultChanged(profileId);
      return { imported: result.imported, cancelled: false };
    },
  );

  return {
    history,
    dispose: () => {
      disposeSidebarSources();
      app.removeListener("browser-window-created", attachBrowserCommands);
      for (const [window, listener] of appCommandListeners) {
        if (!window.isDestroyed())
          window.removeListener("app-command", listener);
      }
      appCommandListeners.clear();
      ipcMain.removeListener("catamorphic:browser-login-forms", onLoginForms);
      ipcMain.removeListener(
        "catamorphic:guest-notification-permission",
        onGuestNotificationPermission,
      );
      ipcMain.removeListener(
        "catamorphic:guest-notification-close",
        onGuestNotificationClose,
      );
      ipcMain.removeHandler("catamorphic:guest-notification-show");
      for (const { notification } of guestNotifications.values())
        notification.close();
      guestNotifications.clear();
      ipcMain.removeListener(
        "catamorphic:browser-credentials-submitted",
        onSubmittedCredentials,
      );
      ipcMain.removeListener(
        "catamorphic:browser-username-submitted",
        onSubmittedUsername,
      );
      pendingCredentials.clear();
      suggestedPasswords.clear();
      unsubscribeRemoved();
      history.dispose();
      vault.dispose();
      sitePermissionPolicy = null;
      downloadHook = null;
      downloads.dispose();
      for (const channel of [
        "catamorphic:downloads-list",
        "catamorphic:downloads-reveal",
        "catamorphic:downloads-pause",
        "catamorphic:downloads-resume",
        "catamorphic:downloads-cancel",
        "catamorphic:downloads-remove",
        "catamorphic:downloads-clear",
        "catamorphic:downloads-open-folder",
      ])
        ipcMain.removeHandler(channel);
      preparedSessions.clear();
    },
  };
}
