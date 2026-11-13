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
  Notification,
  nativeTheme,
  type Session,
  screen,
  session,
  shell,
  systemPreferences,
  type WebContents,
  webContents,
} from "electron";
import { z } from "zod";
import {
  KEYBINDING_ACTIONS,
  type Keybindings,
  PAGE_FIRST_ACTIONS,
} from "../shared/actions.js";
import type {
  BookmarkFolderRename,
  BookmarkMove,
  BookmarkPlacement,
  BookmarkRemoval,
  BookmarkUpdate,
} from "../shared/bookmark-target.js";
import {
  type BrowserHistory,
  boundedBrowserHistory,
  historyFromSource,
  wakeFromSource,
} from "../shared/browser-history.js";
import { browserImportRequestSchema } from "../shared/browser-import.js";
import { chromeBrandHeaders } from "../shared/chrome-brands.js";
import { accessBeyond, isEmptyAccess } from "../shared/code-access.js";
import {
  type HistoryProject,
  historyProjectSchema,
  historyVisitSchema,
} from "../shared/history.js";
import { matchesShortcut } from "../shared/keybindings.js";
import type { PageContextMenu } from "../shared/menu.js";
import { paletteUseSchema } from "../shared/palette.js";
import type { PasswordFileImportResult } from "../shared/password-import.js";
import { PROFILE_SYNC_PARTS } from "../shared/profile-sync.js";
import {
  type ScreenShareAnswer,
  type ScreenShareCaptureSources,
  type ScreenShareChoice,
  type ScreenShareRequest,
  type ScreenShareSource,
  type ScreenShareTabState,
  type SystemScreenAccess,
  screenShareAnswerSchema,
  shareStreams,
  systemAudioSupported,
  tabSourceWebContentsId,
} from "../shared/screen-share.js";
import { type SidebarSectionConfig, sectionModule } from "../shared/sidebar.js";
import {
  ALWAYS_GRANTED_PERMISSIONS,
  decideSitePermission,
  type MediaDeviceKind,
  permissionKindsFor,
  type SiteDetails,
  type SiteSummary,
  type SiteSystemRefusal,
  type SystemMediaAccess,
  siteHost,
  siteOrigin,
  sitePermissionAnswerSchema,
  sitePermissionKindSchema,
  sitePermissionStateSchema,
} from "../shared/site-settings.js";
import { sanitizeSidebarSourceItem } from "../shared/source-rows.js";
import type { TerminalMacro } from "../shared/terminal-macros.js";
import { isCaretKey, TEXT_FIELD_PROBE } from "../shared/text-field.js";
import { isVoiceAction } from "../shared/voice.js";
import { windowImageRequestSchema } from "../shared/window-images.js";
import type { WorkspaceConfig } from "../shared/workspace-config.js";
import { pageClosing, registerBrowserDialogs } from "./browser-dialogs.js";
import { holdCaptureFrames } from "./browser-driver.js";
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
import {
  type ImportedVault,
  PasswordFileError,
  passwordFileKind,
  readKeepassDatabase,
  readPasswordFile,
  WrongDatabaseKey,
} from "./browser-import/password-file.js";
import {
  importBrowserPasswords,
  passwordImportSupport,
  readBrowserKey,
} from "./browser-import/password-native.js";
import { guestWindowOpenAction } from "./browser-popups.js";
import {
  claimSnapshot,
  noteCapture,
  type PageSnapshot,
  registerBrowserSleep,
} from "./browser-sleep.js";
import { recordDownload, trackConsole } from "./browser-tab-records.js";
import { PasswordVault } from "./browser-vault.js";
import { type CodeApprovals, registerCodeApprovals } from "./code-approvals.js";
import { customizationAuthoring } from "./customization-authoring.js";
import {
  checkCustomization,
  previewCustomization,
} from "./customization-check.js";
import { DownloadsManager, DownloadsStore } from "./downloads.js";
import { isLoopback } from "./egress-proxy.js";
import { ExtensionsHost } from "./extensions/host.js";
import { restoreGuestHistory } from "./history-restore.js";
import type { WindowProfileRegistry } from "./index.js";
import { LoginCapture, type LoginSubmission } from "./login-capture.js";
import { moduleAccessSubject, readModuleAccess } from "./module-access.js";
import { popupNativeMenu } from "./native-menu.js";
import {
  menuActions,
  type PageMenuHost,
  pageMenu,
  pageMenuTargetOf,
  runPageMenuAction,
} from "./page-menu.js";
import { PaletteUsageStore } from "./palette-usage.js";
import { registerPasskeys } from "./passkeys.js";
import { generateStrongPassword } from "./password-generator.js";
import { PopupPasskeySheets } from "./popup-passkey-sheets.js";
import type { ProfileConfigManager } from "./profile-config.js";
import type { ProfilesStore } from "./profiles.js";
import { isShellDocument } from "./shell-document.js";
import { isRegisteredShellContents, shellIpcMain } from "./shell-ipc.js";
import {
  parseWorkCall,
  registerSidebarSources,
  type SourceHostCall,
  sourceRequestSchema,
} from "./sidebar-source-ipc.js";
import { SiteIcons } from "./site-icons.js";
import {
  cookieCoversHost,
  PromptBroker,
  SitePermissionBroker,
  SiteSettingsStore,
} from "./site-settings.js";
import { registerTrustedHosts } from "./trusted-hosts.js";
import { WindowImages } from "./window-images.js";
import { DEFAULT_WORKSPACE_FILE } from "./workspace-config.js";

/**
 * Browser support for workspace tabs. Pages render in `<webview>` tags in
 * the renderer (they composite into the page, so app overlays like the
 * autocomplete dropdown and chat dock stack correctly); this module owns
 * everything per-profile and main-process-only:
 *  - persistent session partitions (`persist:profile-<id>`) with Chrome's
 *    identity (a clean Chrome UA here, `window.chrome` from the session
 *    preload) so Google sign-in works and survives restarts per profile,
 *  - popup/new-window requests turned into "open new tab" events,
 *  - Cmd+L observed inside page content and forwarded to the address bar,
 *  - browsing history (address-bar autocomplete),
 *  - the KDBX password vault gated by device auth,
 *  - unpacked Chrome extensions loaded per profile.
 */

/** How long an incognito session outlives its last page (a page remounting). */
const INCOGNITO_END_DELAY_MS = 5_000;

/** How long the share picker waits on a tab's thumbnail before listing it bare. */
const TAB_THUMBNAIL_TIMEOUT_MS = 750;
/** How long the OS gets to list its windows or screens for the picker. */
const CAPTURER_TIMEOUT_MS = 8_000;
const SHARE_THUMBNAIL_SIZE = { width: 360, height: 225 };
/** A pick waits this long for the page's share to start with it. */
const SHARE_PICK_LIFETIME_MS = 30_000;
/** A shared tab's capture is checked this often, to tell its window. */
const SHARE_POLL_MS = 1_000;
/** A tab picked for a share whose capture never starts is let go. */
const SHARE_START_MS = 15_000;

/**
 * The app a link would open, named for the prompt ("wants to open Slack").
 * Only the scheme and the registered app's name leave this function; the
 * link itself can carry tokens.
 */
function externalAppFor(
  externalUrl: string,
): { scheme: string; name?: string } | undefined {
  let scheme: string;
  try {
    scheme = new URL(externalUrl).protocol.replace(/:$/, "");
  } catch {
    return undefined;
  }
  // Linux answers with a desktop-file id through a synchronous xdg-mime
  // call on the main thread; the scheme's links read better than that.
  let name: string | undefined;
  if (process.platform !== "linux") {
    try {
      name = app.getApplicationNameForProtocol(externalUrl) || undefined;
    } catch {
      name = undefined;
    }
  }
  // macOS reports the bundle's display name with its extension.
  return { scheme, ...(name ? { name: name.replace(/\.app$/i, "") } : {}) };
}

/**
 * A prompt asked of a window in the background waits unseen. Bring the
 * requesting tab forward in its window and ask for the person's attention
 * (a critical Dock bounce on macOS, a flashing frame elsewhere) until the
 * prompt settles. Returns the undo.
 */
function requestAttention(
  host: WebContents,
  guestId: number,
): (() => void) | undefined {
  const window = BrowserWindow.fromWebContents(host);
  // While Work is in front, the prompt shows where the person already is;
  // a background tab must not pull them away from what they are doing.
  if (!window || window.isDestroyed() || window.isFocused()) return undefined;
  host.send("catamorphic:browser-reveal-guest", { guestId });
  if (process.platform === "darwin" && app.dock) {
    const bounce = app.dock.bounce("critical");
    return () => app.dock?.cancelBounce(bounce);
  }
  window.flashFrame(true);
  return () => {
    if (!window.isDestroyed()) window.flashFrame(false);
  };
}

// Partition → in-flight/settled prepare. A Promise map (not a Set of
// done flags): concurrent callers share one prepare and actually await
// it, and a failed prepare is retried on the next call instead of being
// permanently marked done while half-applied.
const preparedSessions = new Map<string, Promise<void>>();
const readySessions = new Set<string>();

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
      externalURL?: string;
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
      incognito: boolean,
    ) => void)
  | null = null;

/**
 * Chrome extensions (ADR 0203) load into each profile session as it is
 * prepared, through the host `registerBrowserSupport` owns.
 */
let extensionsHost: ExtensionsHost | null = null;

/**
 * Chrome's client-hint brand lists for the engine's version, as Chrome
 * builds them (shared/chrome-brands.ts). Google's supported-browser gate
 * reads these; Electron would otherwise advertise only "Chromium". The UA
 * string itself is already Chrome-clean app-wide (see
 * `app.userAgentFallback` in main/index.ts), and names only the major
 * version; the full version list names the engine's real one.
 */
function chromeBrands(): { brands: string; fullVersionList: string } {
  return chromeBrandHeaders({ fullVersion: process.versions.chrome });
}

const BRAND_HEADER_REQUESTS: Electron.WebRequestFilter = {
  urls: ["<all_urls>"],
  types: ["mainFrame", "subFrame", "xhr"],
};

export function partitionFor(profileId: string): string {
  return `persist:profile-${profileId}`;
}

/**
 * A profile's incognito session (ADR 0303): in memory only, so nothing it
 * keeps reaches the disk, and shared by all the profile's incognito tabs,
 * as Chrome's incognito windows share theirs. It is cleared when the last
 * of them closes.
 */
export function incognitoPartitionFor(profileId: string): string {
  return `incognito-profile-${profileId}`;
}

/** Each prepared incognito session, by the profile it belongs to. */
const incognitoSessions = new WeakMap<Session, string>();
const isIncognito = (contents: WebContents) =>
  !contents.isDestroyed() && incognitoSessions.has(contents.session);

/**
 * The Sec-CH-UA rewrite as a webRequest listener. A profile whose
 * extensions filter requests turns it off (Electron runs extension
 * webRequest and declarativeNetRequest only without one) and rewrites
 * through the hidden brand extension instead (ADR 0203).
 */
function setBrandHeaderListener(ses: Session, on: boolean): void {
  if (!on) {
    ses.webRequest.onBeforeSendHeaders(null);
    return;
  }
  const { brands, fullVersionList } = chromeBrands();
  // Header layer: Chromium sends Sec-CH-UA built from its own brand list,
  // which no setUserAgent call covers. Only documents and page requests
  // (fetch, XHR) are rewritten, where a site reads the brand. A listener
  // puts every request it matches through this process's event loop,
  // which the embedded server shares: matching subresources too made
  // pages load slower whenever the app was busy, and Meet showed its
  // icon names until its icon font arrived (ADR 0194).
  ses.webRequest.onBeforeSendHeaders(
    BRAND_HEADER_REQUESTS,
    (details, callback) => {
      const headers = details.requestHeaders;
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === "sec-ch-ua") headers[name] = brands;
        else if (lower === "sec-ch-ua-full-version-list") {
          headers[name] = fullVersionList;
        }
      }
      callback({ requestHeaders: headers });
    },
  );
}

function prepareProfileSession(
  profileId: string,
  incognito = false,
): Promise<void> {
  const partition = incognito
    ? incognitoPartitionFor(profileId)
    : partitionFor(profileId);
  const existing = preparedSessions.get(partition);
  if (existing) return existing;
  const prepare = doPrepareProfileSession(partition, profileId, incognito).then(
    () => {
      readySessions.add(partition);
    },
  );
  preparedSessions.set(partition, prepare);
  prepare.catch(() => preparedSessions.delete(partition));
  return prepare;
}

async function doPrepareProfileSession(
  partition: string,
  profileId: string,
  incognito: boolean,
): Promise<void> {
  const ses = session.fromPartition(partition);
  if (incognito) incognitoSessions.set(ses, profileId);
  setBrandHeaderListener(ses, true);

  // Chrome-like site permissions: the profile's stored choices answer
  // outright; anything undecided prompts in the site settings modal.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const policy = sitePermissionPolicy;
    if (!policy || !wc) {
      callback(ALWAYS_GRANTED_PERMISSIONS.has(permission));
      return;
    }
    void policy.request(wc, profileId, permission, details).then(
      (granted) => {
        // A page with a camera, microphone or share open stays awake.
        if (
          granted &&
          (permission === "media" || permission === "display-capture")
        )
          noteCapture(wc);
        callback(granted);
      },
      () => callback(false),
    );
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
    downloadHook?.(profileId, item, contents, incognito);
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

  // Chrome extensions (ADR 0203): the profile's installed extensions load
  // before its first tab does, so their content scripts see every page.
  // Incognito pages run none, as Chrome's do by default.
  if (!incognito) await extensionsHost?.prepare(ses, profileId);
}

export interface BrowserSupport {
  customization: (
    projectId: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  history: HistoryStore;
  /** Read-only ownership of a prepared browsing session, without shell authority. */
  profileOf: (contents: WebContents) => string | undefined;
  /** Every image the window shows from outside it (ADR 0277). */
  images: WindowImages;
  dispose: () => void;
}

export function registerBrowserSupport(
  profiles: ProfilesStore,
  /** Shared with the config agent so chat edits and IPC hit one store set. */
  profileConfig: ProfileConfigManager,
  windows: WindowProfileRegistry,
  /** Project root lookup for layered sidebar resolution (embedded server). */
  projectRootFor: (projectId: string) => Promise<string | null>,
  /**
   * Work's Bun toolchain environment for sidebar modules (PATH,
   * CATAMORPHIC_BUN), as agent terminals get it; never a credential.
   */
  sidebarToolchain: () => Promise<Record<string, string>>,
  /** The detached chat dock is no browser window (ADR 0203 tab reports). */
  isDock: (window: BrowserWindow) => boolean,
  /** How sidebar modules are confined (ADR 0277). */
  moduleSandbox: {
    approvalsFor: (profileId: string) => CodeApprovals;
    approvalsRecovered?: (input: { profileId: string }) => Promise<void>;
    /** A throwaway E2E profile on a platform Work cannot confine. */
    unconfined: boolean;
    /** Ports of Work's own loopback servers, which no module reaches. */
    workPorts: () => number[];
    targetFor?: (projectId: string) => WebContents | undefined;
    hostCall?: (input: SourceHostCall) => Promise<unknown>;
    sourceStopped?: (owner: {
      profileId: string;
      projectId: string;
      modulePath: string;
      viewId?: string;
      viewSignal?: AbortSignal;
    }) => void | Promise<void>;
  },
): BrowserSupport {
  const userData = app.getPath("userData");
  const profilesDir = path.join(userData, "profiles");
  // What the person approved code to reach (ADR 0277), sealed with a key
  // only this app can unseal from the keychain.
  const approvals = registerCodeApprovals({
    approvalsFor: moduleSandbox.approvalsFor,
    profileFor: (sender) => windows.profileFor(sender),
    approvalsRecovered: moduleSandbox.approvalsRecovered,
  });
  // Hosts a chat opens and shows without asking (ADR 0277).
  const disposeTrustedHosts = registerTrustedHosts({
    approvalsFor: approvals.approvalsFor,
    profileFor: (sender) => windows.profileFor(sender),
    rootFor: projectRootFor,
    windowsFor: (profileId) => windows.windowsFor(profileId),
    approvalsRecovered: moduleSandbox.approvalsRecovered,
  });
  const disposeSidebarSources = registerSidebarSources({
    windows,
    profiles,
    config: profileConfig,
    rootFor: projectRootFor,
    toolchain: sidebarToolchain,
    approvals: approvals.approvalsFor,
    approvalsRecovered: moduleSandbox.approvalsRecovered,
    scratchRoot: path.join(userData, "sidebar-runtime", "scratch"),
    unconfined: moduleSandbox.unconfined,
    blocked: (host, port) =>
      isLoopback(host) && moduleSandbox.workPorts().includes(port),
    hostCall: moduleSandbox.hostCall,
    sourceStopped: moduleSandbox.sourceStopped,
  });
  const history = new HistoryStore(profilesDir);
  const paletteUsage = new PaletteUsageStore(profilesDir);
  const vault = new PasswordVault(profilesDir);
  const siteSettings = new SiteSettingsStore(profilesDir);
  // The app's own windows use the default session, which Electron grants
  // every permission without a handler. None of them opens other apps
  // through navigation (links go through shell.openExternal on purpose).
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback) =>
      callback(permission !== "openExternal"),
  );
  const permissionBroker = new SitePermissionBroker();
  // A browsing window that is not a tab (a tab's sign-in popup, a window
  // an extension opened) belongs to the profile whose session it shows,
  // whatever became of the tab that opened it.
  const browsingProfileOf = (contents: WebContents) =>
    extensionsHost?.profileOfSession(contents.session) ?? undefined;
  const profileOf = (contents: WebContents): string | undefined => {
    if (contents.isDestroyed()) return undefined;
    const profileId = browsingProfileOf(contents);
    if (!profileId || !profiles.get(profileId)) return undefined;
    const host = contents.hostWebContents;
    if (host) {
      if (!isRegisteredShellContents(host)) return undefined;
      try {
        if (windows.profileFor(host) !== profileId) return undefined;
      } catch {
        return undefined;
      }
    }
    return profileId;
  };
  const popupSheets = new PopupPasskeySheets({
    attach: (sheet, popup) => {
      const profileId = browsingProfileOf(popup);
      if (profileId) windows.attach(sheet, profileId);
    },
  });
  const disposePasskeys = registerPasskeys({
    vault,
    profileFor: (host) => windows.profileFor(host),
    windows: {
      profileOf: browsingProfileOf,
      sheet: (window) => popupSheets.sheet(window),
      show: (window) => popupSheets.show(window),
      hide: (window) => popupSheets.hide(window),
    },
    onVaultChanged: (profileId) => vaultChanged(profileId),
  });
  const siteIcons = new SiteIcons();
  // Pages pick their icon by the scheme they see, which follows the OS.
  const colorScheme = () =>
    nativeTheme.shouldUseDarkColors ? "dark" : "light";
  const siteIcon = (
    profileId: string,
    origin: string,
    historyIcon?: string | null,
  ) => siteIcons.get(profileId, origin, colorScheme()) ?? historyIcon ?? null;
  // A session of its own, kept in memory: image fetches carry no cookies
  // and leave nothing in the browsing profiles.
  const imageSession = session.fromPartition("work-window-images");
  const images = new WindowImages({
    siteIcons: (profileId, origin) => {
      const seen = siteIcons.get(profileId, origin, colorScheme());
      const visited = history.siteFavicons(profileId, origin);
      return seen
        ? [seen, ...visited.filter((icon) => icon !== seen)]
        : visited;
    },
    seenIcon: (profileId, icon) =>
      siteIcons.has(profileId, icon) || history.seenFavicon(profileId, icon),
    fetch: (url, init) =>
      imageSession.fetch(url, { ...init, credentials: "omit" }),
  });
  shellIpcMain.handle("catamorphic:window-image", (event, raw: unknown) => {
    // Registered Work surfaces, including a passkey sheet's native view.
    // Browsing pages never receive this channel's shell grant.
    const request = windowImageRequestSchema.safeParse(raw);
    return request.success
      ? images.image(windows.profileFor(event.sender), request.data)
      : null;
  });
  // Guest id → OS refusals already explained for the page it shows.
  const mediaRefusalsShown = new Map<number, Set<string>>();
  const screenShareBroker = new PromptBroker<
    ScreenShareRequest,
    ScreenShareAnswer
  >();
  // Downloads an extension started (downloads.download), by profile and
  // the address it asked for (a redirect changes the item's final one).
  const expectedDownloads = new Map<
    string,
    { name: string | null; claimed: (id: string) => void }[]
  >();
  const downloadListeners = new Set<(profileId: string) => void>();
  const downloads = new DownloadsManager(new DownloadsStore(profilesDir), {
    downloadsDir: () =>
      process.env.CATAMORPHIC_DOWNLOADS_DIR || app.getPath("downloads"),
    claim: (profileId, item) => {
      const key = `${profileId}\n${item.getURLChain()[0] ?? item.getURL()}`;
      const waiting = expectedDownloads.get(key);
      const expected = waiting?.shift() ?? null;
      if (waiting?.length === 0) expectedDownloads.delete(key);
      return expected;
    },
    broadcast: (profileId, list) => {
      for (const window of windows.windowsFor(profileId))
        if (!window.isDestroyed())
          window.webContents.send("catamorphic:downloads-changed", {
            profileId,
            downloads: list,
          });
      for (const listener of downloadListeners) listener(profileId);
    },
  });
  downloadHook = (profileId, item, contents, incognito) => {
    // The tab's own record, for an agent driving it.
    recordDownload(contents, item);
    const page = contents.isDestroyed() ? "" : contents.getURL();
    const host =
      siteHost(siteOrigin(page) ?? siteOrigin(item.getURL()) ?? "") || null;
    downloads.attach(profileId, item, host, { incognito });
  };
  const downloadInput = z.object({ id: z.string().min(1) });
  shellIpcMain.handle("catamorphic:downloads-list", (event) =>
    downloads.list(windows.profileFor(event.sender)),
  );
  shellIpcMain.handle(
    "catamorphic:downloads-reveal",
    (event, input: unknown) => {
      const { id } = downloadInput.parse(input);
      const record = downloads.store.get(windows.profileFor(event.sender), id);
      if (!record) return;
      if (fs.existsSync(record.savePath))
        shell.showItemInFolder(record.savePath);
      else void shell.openPath(path.dirname(record.savePath));
    },
  );
  const ownDownload = (event: Electron.IpcMainInvokeEvent, input: unknown) => {
    const { id } = downloadInput.parse(input);
    const record = downloads.store.get(windows.profileFor(event.sender), id);
    if (!record) throw new Error("This download belongs to another profile.");
    return id;
  };
  shellIpcMain.handle(
    "catamorphic:downloads-pause",
    (event, input: unknown) => {
      downloads.pause(ownDownload(event, input));
    },
  );
  shellIpcMain.handle(
    "catamorphic:downloads-resume",
    (event, input: unknown) => {
      downloads.resume(ownDownload(event, input));
    },
  );
  shellIpcMain.handle(
    "catamorphic:downloads-cancel",
    (event, input: unknown) => {
      downloads.cancel(ownDownload(event, input));
    },
  );
  shellIpcMain.handle(
    "catamorphic:downloads-remove",
    (event, input: unknown) => {
      downloads.remove(
        windows.profileFor(event.sender),
        downloadInput.parse(input).id,
      );
    },
  );
  shellIpcMain.handle("catamorphic:downloads-clear", (event) => {
    downloads.clearFinished(windows.profileFor(event.sender));
  });
  shellIpcMain.handle("catamorphic:downloads-open-folder", () => {
    const dir =
      process.env.CATAMORPHIC_DOWNLOADS_DIR || app.getPath("downloads");
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  });
  const unsubscribeRemoved = profiles.onRemoved((profileId) => {
    history.releaseProfile(profileId);
    paletteUsage.releaseProfile(profileId);
    siteIcons.releaseProfile(profileId);
    vault.releaseProfile(profileId);
    siteSettings.releaseProfile(profileId);
    extensions.releaseProfile(profileId);
    for (const partition of [
      partitionFor(profileId),
      incognitoPartitionFor(profileId),
    ]) {
      preparedSessions.delete(partition);
      readySessions.delete(partition);
    }
  });
  const bookmarks = profileConfig.bookmarks;
  // Each profile's keybindings, read once and kept current: pages and
  // extensions match them on every key they see.
  const guestBindings = new Map<string, Keybindings>();
  profileConfig.onKeybindingsChanged((profileId, bindings) =>
    guestBindings.set(profileId, bindings),
  );
  const keybindingsOf = (profileId: string): Keybindings => {
    const cached = guestBindings.get(profileId);
    if (cached) return cached;
    const loaded = profileConfig.forProfile(profileId).keybindings.load();
    guestBindings.set(profileId, loaded);
    return loaded;
  };
  const extensions = new ExtensionsHost({
    profilesDir,
    userData,
    profileFor: (sender) => windows.profileFor(sender),
    windowsFor: (profileId) => windows.windowsFor(profileId),
    isDock,
    brands: chromeBrands,
    setBrandListener: setBrandHeaderListener,
    keybindings: keybindingsOf,
    pickFolder: async (sender) => {
      const scripted = process.env.CATAMORPHIC_E2E_PICK_FILE;
      if (process.env.CATAMORPHIC_E2E_DATA_DIR && scripted) {
        const next = fs.readFileSync(scripted, "utf8").trim();
        return next || null;
      }
      const window = BrowserWindow.fromWebContents(sender);
      if (!window) return null;
      const picked = await dialog.showOpenDialog(window, {
        title: "Load unpacked extension",
        buttonLabel: "Select",
        properties: ["openDirectory"],
      });
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    history: { entries: (profileId) => history.entries(profileId) },
    bookmarks: () => profileConfig.bookmarks,
    downloads: {
      list: (profileId) => downloads.list(profileId),
      pause: (id) => downloads.pause(id),
      resume: (id) => downloads.resume(id),
      cancel: (id) => downloads.cancel(id),
      remove: (profileId, id) => downloads.remove(profileId, id),
      onChange: (listener) => {
        downloadListeners.add(listener);
        return () => downloadListeners.delete(listener);
      },
      expect: (profileId, url, filename) =>
        new Promise<string | null>((resolve) => {
          const key = `${profileId}\n${url}`;
          const entry = {
            name: filename,
            claimed: (id: string) => {
              clearTimeout(timer);
              resolve(id);
            },
          };
          const timer = setTimeout(() => {
            const waiting = expectedDownloads.get(key) ?? [];
            const rest = waiting.filter((other) => other !== entry);
            if (rest.length > 0) expectedDownloads.set(key, rest);
            else expectedDownloads.delete(key);
            resolve(null);
          }, 10_000);
          // Two downloads of one address are claimed in order.
          expectedDownloads.set(key, [
            ...(expectedDownloads.get(key) ?? []),
            entry,
          ]);
        }),
    },
  });
  extensionsHost = extensions;
  const appCommandListeners = new Map<
    BrowserWindow,
    (event: Electron.Event, command: string) => void
  >();

  let historyForNextGuest: BrowserHistory | PageSnapshot | null = null;
  const historyForGuest = new WeakMap<
    WebContents,
    BrowserHistory | PageSnapshot
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
        gesture: "button",
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
        gesture: "swipe",
      });
    };
    // A reopened tab's webview carries its history as its source (see
    // browserHistorySource). The guest must load nothing before the history
    // goes in, since Chromium restores only into an empty guest: the source
    // is cleared as it attaches, and the history goes to the guest created
    // right after, in the same turn.
    const takeHistory = (
      _attach: Electron.Event,
      preferences: Electron.WebPreferences,
      params: Record<string, string>,
    ) => {
      // A sleeping tab wakes into the page state it slept with, or, when
      // main no longer holds it, into what its fallback names.
      const wake = wakeFromSource(params.src ?? "");
      if (wake) {
        const snapshot = claimSnapshot({
          id: wake.snapshotId,
          host: window.webContents,
          session: session.fromPartition(
            preferences.partition ?? params.partition ?? "",
          ),
        });
        if (snapshot) {
          params.src = "";
          historyForNextGuest = snapshot;
          return;
        }
        params.src = wake.fallback;
      }
      const history = historyFromSource(params.src ?? "");
      if (history === undefined) return;
      params.src = "";
      historyForNextGuest = history;
    };
    const restoreHistory = (_attach: Electron.Event, guest: WebContents) => {
      const history = historyForGuest.get(guest);
      if (!history) return;
      historyForGuest.delete(guest);
      void restoreGuestHistory({ guest, history });
    };
    // A tab's page runs its preload in every frame, so an embedded frame
    // asks through Work's dialogs too (ADR 0227) and reports its logins.
    // Suggestions and filling stay in the top frame. Extension views keep theirs.
    const framesPreload = (
      attach: Electron.Event,
      preferences: Electron.WebPreferences,
      params: Record<string, string>,
    ) => {
      if (!isRegisteredShellContents(window.webContents)) {
        attach.preventDefault();
        return;
      }
      // A tab lives in its window's profile session, or in that
      // profile's incognito one.
      const profileId = windows.profileFor(window.webContents);
      const asked = preferences.partition ?? params.partition;
      const partition = [
        partitionFor(profileId),
        incognitoPartitionFor(profileId),
      ].find((candidate) => candidate === asked);
      if (!partition || !readySessions.has(partition)) {
        attach.preventDefault();
        return;
      }
      preferences.partition = partition;
      preferences.session = session.fromPartition(partition);
      preferences.nodeIntegration = false;
      preferences.nodeIntegrationInWorker = false;
      preferences.contextIsolation = true;
      preferences.sandbox = true;
      preferences.webSecurity = true;
      preferences.allowRunningInsecureContent = false;
      preferences.webviewTag = false;
      // Let Chromium paint an opaque canvas in the page's own color scheme.
      // Styling html's background blocks body-to-canvas propagation on sites
      // that color only body, exposing a white canvas while scrolling.
      preferences.transparent = false;
      // Work owns the only guest preload. Extension pages receive their
      // protocol bridge through the prepared session instead.
      if (params.src?.startsWith("chrome-extension://")) {
        delete preferences.preload;
        preferences.nodeIntegrationInSubFrames = false;
      } else {
        preferences.preload = path.join(
          import.meta.dirname,
          "../preload/webview.cjs",
        );
        preferences.nodeIntegrationInSubFrames = true;
      }
    };
    window.webContents.on("will-attach-webview", framesPreload);
    window.webContents.on("will-attach-webview", takeHistory);
    window.webContents.on("did-attach-webview", restoreHistory);
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

  // The IPC sender is authoritative. A child frame cannot claim the top
  // site's origin, and an opaque or detached document cannot submit a login.
  const loginContext = (event: Electron.IpcMainEvent) => {
    const context = guestContext(event.sender);
    const frame = event.senderFrame;
    if (!context || !frame || frame.detached || frame.isDestroyed())
      return null;
    if (
      !event.sender.mainFrame.framesInSubtree.some(
        (candidate) =>
          candidate.frameToken === frame.frameToken &&
          candidate.processId === frame.processId,
      )
    )
      return null;
    const origin = httpOrigin(frame.origin);
    return origin
      ? { ...context, origin, frameId: frame.frameTreeNodeId }
      : null;
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

  // A sign-in may replace its embedding page or remove its iframe. Do
  // not count a sibling's empty page as a landing while its frame remains.
  const reconcileLoginFrames = (guest: WebContents) => {
    const context = guestContext(guest);
    if (!context || guest.isLoading()) return;
    const frames = guest.mainFrame.framesInSubtree.flatMap((frame) => {
      if (frame.detached || frame.isDestroyed()) return [];
      const origin = httpOrigin(frame.url) && httpOrigin(frame.origin);
      return origin ? [{ frameId: frame.frameTreeNodeId, origin }] : [];
    });
    const succeeded = loginCapture.framesChanged(guest.id, frames);
    if (succeeded)
      void offerToSave(guest, context.host, context.profileId, succeeded).catch(
        (error: unknown) =>
          console.warn("[browser] Password offer failed:", error),
      );
  };

  const onLoginForms = (
    event: Electron.IpcMainEvent,
    payload: { origin?: unknown; passwordForms?: unknown; load?: unknown },
  ) => {
    const context = loginContext(event);
    if (
      !context ||
      payload.origin !== context.origin ||
      typeof payload.passwordForms !== "number"
    )
      return;
    const succeeded = loginCapture.formsReported(event.sender.id, {
      origin: context.origin,
      frameId: context.frameId,
      passwordForms: payload.passwordForms,
      load: payload.load === true,
    });
    reconcileLoginFrames(event.sender);
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
    const context = loginContext(event);
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
      frameId: context.frameId,
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
    const context = loginContext(event);
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
      context.frameId,
    );
  };

  /** Fill a generated password and remember it for auto-save. */
  const fillGenerated = (
    guest: WebContents,
    origin: string,
    password: string,
    fieldId?: string,
  ) => {
    loginCapture.markGenerated(
      guest.id,
      origin,
      password,
      guest.mainFrame.frameTreeNodeId,
    );
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

  // --- page dialogs: alert, confirm, prompt, Leave site?, sign-ins (ADR 0227) ---
  const disposeDialogs = registerBrowserDialogs({
    isTab: (guest) =>
      guest.getType() === "webview" && !extensions.isView(guest),
    profileFor: (host) => windows.profileFor(host),
    vault: {
      list: (profileId, origin) => vault.list(profileId, origin),
      reveal: (profileId, id) => vault.reveal(profileId, id),
    },
    // A sign-in the site accepted: the tab's password card offers to save
    // it, as after a form's.
    offerToSave: ({ guest, host, profileId, origin, username, password }) =>
      void offerToSave(guest, host, profileId, {
        origin,
        username,
        password,
        generated: false,
      }).catch((error: unknown) =>
        console.warn("[browser] Password offer failed:", error),
      ),
  });

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

  // --- page context menus (ADR 0221) ---
  /**
   * Each page's open context menu: the window draws it, and the pick (or
   * none) comes back here to run against the page it was built for.
   */
  const pageMenus = new Map<
    string,
    {
      guest: WebContents;
      host: WebContents;
      /** What a pick may name: the menu's enabled entries. */
      actions: Set<string>;
      run: (action: string) => void;
    }
  >();
  /** Each page's latest right-click: an older one still reading the vault yields. */
  const pageMenuRequests = new Map<number, number>();
  /** Where a page's menu sends what it opens and what it asks the OS for. */
  const pageMenuHost = ({
    opener,
    page,
    password,
    runExtension = () => false,
  }: {
    /** The tab whose window opens links as tabs (a popup's opener). */
    opener: WebContents;
    page: WebContents;
    password?: { profileId: string; origin: string };
    runExtension?: (action: string) => boolean;
  }): PageMenuHost => ({
    openUrl: (url, mode, incognito) => {
      const host = opener.isDestroyed() ? null : opener.hostWebContents;
      if (host && !host.isDestroyed())
        host.send("catamorphic:browser-open-url", {
          url,
          mode,
          // An incognito page's links stay incognito.
          ...(incognito || isIncognito(opener) ? { incognito: true } : {}),
        });
    },
    writeText: (text) => clipboard.writeText(text),
    // The person chose this link's app from the menu, as a click on it
    // would have; nothing in the page asked for it.
    openExternal: (url) => void shell.openExternal(url).catch(() => {}),
    showEmojiPanel: () => app.showEmojiPanel(),
    fillCredential: (id) => {
      if (!password) return;
      void vault.reveal(password.profileId, id).then((revealed) => {
        if (
          !revealed ||
          page.isDestroyed() ||
          httpOrigin(page.getURL()) !== password.origin
        )
          return;
        page.send("catamorphic:fill-credentials", {
          username: revealed.username,
          password: revealed.password,
        });
      });
    },
    suggestPassword: () => {
      if (password && httpOrigin(page.getURL()) === password.origin)
        fillGenerated(page, password.origin, generateStrongPassword());
    },
    runExtension,
  });
  /**
   * A page's menu, natively: for windows without a workspace to draw it (a
   * sign-in popup) and extension popups and side panels, which hold focus
   * in ways an in-window menu over them would break.
   */
  const showNativePageMenu = (
    window: BrowserWindow,
    page: WebContents,
    params: Electron.ContextMenuParams,
    opener: WebContents,
  ) => {
    const target = pageMenuTargetOf(params);
    const items = pageMenu(target, {
      canGoBack: page.navigationHistory.canGoToOffset(-1),
      canGoForward: page.navigationHistory.canGoToOffset(1),
      mac: process.platform === "darwin",
      emojiPanel: app.isEmojiPanelSupported(),
      credentials: null,
      extensions: [],
      incognito: isIncognito(opener),
    });
    void popupNativeMenu(window, items).then((action) => {
      if (action)
        runPageMenuAction({
          action,
          target,
          page,
          host: pageMenuHost({ opener, page }),
        });
    });
  };
  const showPageMenu = async (
    guest: WebContents,
    params: Electron.ContextMenuParams,
  ) => {
    const host = guest.hostWebContents;
    if (!host || host.isDestroyed()) return;
    if (extensions.isView(guest)) {
      const window = BrowserWindow.fromWebContents(host);
      if (window) showNativePageMenu(window, guest, params, guest);
      return;
    }
    const request = (pageMenuRequests.get(guest.id) ?? 0) + 1;
    pageMenuRequests.set(guest.id, request);
    const target = pageMenuTargetOf(params);
    // Extensions' own items (chrome.contextMenus) follow Work's entries.
    const extension = extensions.pageMenu(guest, params);
    const password =
      params.formControlType === "input-password" ? guestContext(guest) : null;
    // A vault that cannot open still leaves the field its edit commands.
    const credentials = password
      ? await vault.list(password.profileId, password.origin).catch(() => null)
      : null;
    if (
      guest.isDestroyed() ||
      host.isDestroyed() ||
      pageMenuRequests.get(guest.id) !== request
    )
      return;
    const items = pageMenu(target, {
      canGoBack: guest.navigationHistory.canGoToOffset(-1),
      canGoForward: guest.navigationHistory.canGoToOffset(1),
      mac: process.platform === "darwin",
      emojiPanel: app.isEmojiPanelSupported(),
      credentials:
        credentials?.map(({ id, username }) => ({ id, username })) ?? null,
      extensions: extension.items,
      incognito: isIncognito(guest),
    });
    // One menu per page: a newer right-click replaces the one before it.
    for (const [menuId, menu] of pageMenus)
      if (menu.guest === guest) pageMenus.delete(menuId);
    const menuId = randomUUID();
    const menuHost = pageMenuHost({
      opener: guest,
      page: guest,
      password: password ?? undefined,
      runExtension: extension.run,
    });
    pageMenus.set(menuId, {
      guest,
      host,
      actions: new Set(menuActions(items)),
      run: (action) =>
        runPageMenuAction({ action, target, page: guest, host: menuHost }),
    });
    // Chromium reports a guest's right-click in its window's view, in
    // device-independent pixels: the window's own zoom scales them to CSS.
    const zoom = host.getZoomFactor() || 1;
    host.send("catamorphic:browser-context-menu", {
      guestId: guest.id,
      menuId,
      x: params.x / zoom,
      y: params.y / zoom,
      items,
    } satisfies PageContextMenu);
  };
  shellIpcMain.handle(
    "catamorphic:browser-context-menu-pick",
    (event, input: unknown) => {
      const { menuId, action } = z
        .object({ menuId: z.string(), action: z.string().nullable() })
        .parse(input);
      const menu = pageMenus.get(menuId);
      if (!menu || menu.host !== event.sender) return;
      pageMenus.delete(menuId);
      if (action && menu.actions.has(action)) menu.run(action);
    },
  );

  const guestMacros = new Map<string, TerminalMacro[]>();
  profileConfig.onPrefsChanged((profileId, prefs) =>
    guestMacros.set(profileId, prefs.terminalMacros),
  );
  // A profile's incognito session ends with its last page: cookies,
  // storage, cache and sign-ins go, and its downloads leave the list. A
  // moment later, so a tab that replaces its page (a recovery, a project
  // moving to a window of its own) keeps what it signed into.
  const incognitoEnds = new Map<Session, ReturnType<typeof setTimeout>>();
  const endIncognitoWhenUnused = (ses: Session) => {
    clearTimeout(incognitoEnds.get(ses));
    incognitoEnds.set(
      ses,
      setTimeout(() => {
        incognitoEnds.delete(ses);
        const inUse = webContents
          .getAllWebContents()
          .some((other) => !other.isDestroyed() && other.session === ses);
        if (inUse) return;
        void Promise.all([
          ses.clearStorageData(),
          ses.clearCache(),
          ses.clearAuthCache(),
        ]).catch((error: unknown) =>
          console.warn("[browser] Incognito session not cleared:", error),
        );
        const profileId = incognitoSessions.get(ses);
        if (profileId) downloads.forgetIncognito(profileId);
      }, INCOGNITO_END_DELAY_MS),
    );
  };
  // Guests send actions only to their owning window. Match the same configured
  // bindings as the renderer, including Ctrl/Option combinations inside pages.
  app.on("web-contents-created", (_event, contents: WebContents) => {
    if (contents.getType() !== "webview") return;
    // What a page logs while it loads is there when an agent asks.
    trackConsole(contents);
    if (historyForNextGuest) historyForGuest.set(contents, historyForNextGuest);
    historyForNextGuest = null;
    contents.on("preload-error", (_event, preloadPath, error) => {
      console.error("[browser] Guest preload failed", preloadPath, error);
    });
    const incognito = isIncognito(contents);
    const openAsTab = (url: string) => {
      const host = contents.hostWebContents;
      if (host && !host.isDestroyed())
        host.send("catamorphic:browser-open-url", {
          url,
          ...(incognito ? { incognito: true } : {}),
        });
    };
    if (incognito) {
      const ses = contents.session;
      contents.once("destroyed", () => endIncognitoWhenUnused(ses));
    }
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // Asked whether its tab may close, a page holds a user activation
      // Electron grants for the question; it opens nothing with it.
      if (pageClosing(contents.id)) return { action: "deny" };
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
    // lands as a workspace tab rather than a window tree. Its passkey
    // requests show in a sheet over it (passkeys.ts).
    contents.on("did-create-window", (popup) => {
      if (incognito) {
        const ses = popup.webContents.session;
        popup.webContents.once("destroyed", () => endIncognitoWhenUnused(ses));
      }
      popup.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) openAsTab(url);
        return { action: "deny" };
      });
      // A popup has no workspace to draw a menu in: the same menu, native.
      popup.webContents.on("context-menu", (_event, params) =>
        showNativePageMenu(popup, popup.webContents, params, contents),
      );
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
      // Extension shortcuts never collide with Work's (they are assigned
      // only where Work has none).
      if (extensions.handleKey(contents, input)) {
        event.preventDefault();
        return;
      }
      const profileId = windows.profileFor(host);
      const bindings = keybindingsOf(profileId);
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
      // Page-first keys (find, back, forward) go to the page first, whose
      // preload hands back what the page and its text fields leave
      // (preload/webview.ts). The preload runs only in the main frame, so
      // from an embedded frame (where Google Docs types) find stays the
      // page's, and back and forward go unless the key moves a caret and
      // the frame's focus may be a text field: Work never takes a frame's
      // caret, and a probe that cannot tell keeps the key. Unlike the main
      // frame, a frame's own claim on the key (preventDefault) is not seen.
      const frame = contents.focusedFrame;
      const mac = process.platform === "darwin";
      const direction =
        frame && frame.parent !== null
          ? (["back", "forward"] as const).find((candidate) =>
              matchesShortcut({
                event: key,
                binding: bindings[`browser-${candidate}`],
                mac,
              }),
            )
          : undefined;
      if (frame && direction) {
        const navigate = () => {
          if (host.isDestroyed()) return;
          host.send("catamorphic:browser-navigate", {
            webContentsId: contents.id,
            direction,
          });
        };
        if (!isCaretKey({ event: key, mac })) {
          navigate();
          return;
        }
        frame
          .executeJavaScript(TEXT_FIELD_PROBE)
          .then((field: unknown) => {
            if (field === false) navigate();
          })
          .catch(() => {
            // The frame went away with its key.
          });
        return;
      }
      if (
        !macros.some((macro) =>
          matchesShortcut({
            event: key,
            binding: macro.shortcut,
            mac,
          }),
        ) &&
        !KEYBINDING_ACTIONS.some(
          (action) =>
            // A review form owns this shortcut, never a browser page.
            action !== "submit-pr-comment" &&
            action !== "chat-previous-message" &&
            action !== "chat-next-message" &&
            action !== "dismiss-floating" &&
            // Voice reads its keys in every page itself.
            !isVoiceAction(action) &&
            !PAGE_FIRST_ACTIONS.has(action) &&
            matchesShortcut({
              event: key,
              binding: bindings[action],
              mac,
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
      showPageMenu(contents, params).catch((error: unknown) =>
        console.error("[browser] Page menu failed:", error),
      );
    });
    contents.on(
      "did-frame-navigate",
      (_event, _url, _code, _status, _main, processId, routingId) => {
        const frame = contents.mainFrame.framesInSubtree.find(
          (candidate) =>
            candidate.processId === processId &&
            candidate.routingId === routingId,
        );
        if (frame)
          loginCapture.frameNavigated(contents.id, frame.frameTreeNodeId);
      },
    );
    contents.on("did-stop-loading", () => reconcileLoginFrames(contents));
    // A request to open another app belongs to the page that made it: once
    // the tab commits another page, answering must not launch anything.
    // Only a committed navigation counts (as in Chrome): downloads, 204s and
    // "open the app" fallbacks that never load a page keep the question.
    contents.on("did-navigate", () => {
      mediaRefusalsShown.delete(contents.id);
      const ids = permissionBroker.withdrawExternalApps(contents.id);
      const host = contents.hostWebContents;
      if (ids.length > 0 && host && !host.isDestroyed())
        host.send("catamorphic:site-permission-withdrawn", { ids });
    });
    // A prompt for a guest that closed would ask about nothing; the
    // window it was sent to takes it back.
    const hostForWithdrawal = contents.hostWebContents;
    contents.once("destroyed", () => {
      pageMenuRequests.delete(contents.id);
      for (const [menuId, menu] of pageMenus)
        if (menu.guest === contents) pageMenus.delete(menuId);
      loginCapture.forget(contents.id);
      suggestedPasswords.delete(contents.id);
      mediaRefusalsShown.delete(contents.id);
      // Posted notifications stay in Notification Center as in Chrome; the
      // bookkeeping for them goes with the tab.
      for (const [id, entry] of guestNotifications)
        if (entry.guest === contents) guestNotifications.delete(id);
      const ids = permissionBroker.withdrawGuest(contents.id);
      const shareIds = screenShareBroker.withdrawGuest(contents.id);
      pendingShares.delete(contents.id);
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

  // E2E: CDP cannot answer the macOS access sheet and Linux has no such
  // gate, so a seeded answer stands in for the OS on every platform.
  const seededMediaAccess = (): "granted" | "denied" | null => {
    if (!process.env.CATAMORPHIC_E2E_DATA_DIR) return null;
    return process.env.CATAMORPHIC_E2E_SYSTEM_MEDIA_ACCESS === "denied"
      ? "denied"
      : "granted";
  };

  const systemMediaAccess = (
    kind: "camera" | "microphone",
  ): SystemMediaAccess => {
    const seeded = seededMediaAccess();
    if (seeded) return seeded;
    if (process.platform !== "darwin") return null;
    const status = systemPreferences.getMediaAccessStatus(kind);
    if (status === "granted" || status === "not-determined") return status;
    return status === "unknown" ? null : "denied";
  };

  /**
   * macOS gates the camera and microphone per app on top of the site's
   * choice. Prompt the OS the first time, and let the site fail cleanly
   * (rather than hang) when the app itself has been denied. Returns the
   * devices the OS refused.
   */
  const ensureSystemMediaAccess = async (
    kinds: readonly MediaDeviceKind[],
  ): Promise<MediaDeviceKind[]> => {
    const refused: MediaDeviceKind[] = [];
    for (const kind of kinds) {
      const status = systemMediaAccess(kind);
      if (status === null || status === "granted") continue;
      if (
        status === "not-determined" &&
        (await systemPreferences.askForMediaAccess(kind))
      )
        continue;
      refused.push(kind);
    }
    return refused;
  };

  /**
   * Hand a granted camera or microphone request to the OS gate. A refusal
   * would otherwise read to the person as a site that ignores their Allow,
   * so the window says why, once per page.
   */
  const grantMedia = async (input: {
    guest: WebContents;
    origin: string;
    kinds: readonly MediaDeviceKind[];
  }): Promise<boolean> => {
    const refused = await ensureSystemMediaAccess(input.kinds);
    if (refused.length === 0) return true;
    const { guest, origin } = input;
    const host = guest.isDestroyed() ? null : guest.hostWebContents;
    const told = mediaRefusalsShown.get(guest.id) ?? new Set<string>();
    const key = `${origin} ${refused.join(" ")}`;
    if (host && !host.isDestroyed() && !told.has(key)) {
      told.add(key);
      mediaRefusalsShown.set(guest.id, told);
      const notice: SiteSystemRefusal = {
        origin,
        guestId: guest.id,
        kinds: refused,
      };
      host.send("catamorphic:site-permission-system-refused", notice);
    }
    return false;
  };

  /**
   * The app's picker for a page's getDisplayMedia (ADRs 0150, 0315).
   * Chromium asks the permission handler first (a `display-capture`
   * request, which says whether the page wants audio) and the
   * display-media handler second; picking at the first stage lets a
   * cancel deny the permission, which the page sees as NotAllowedError
   * (Chrome's answer), and the second stage hands over the pick.
   */
  const pendingShares = new Map<
    number,
    { choice: ScreenShareChoice; tab: WebContents | null; at: number }
  >();
  const pickShare = async (input: {
    guest: WebContents;
    host: WebContents;
    profileId: string;
    origin: string;
    audio: boolean;
  }): Promise<{
    choice: ScreenShareChoice;
    tab: WebContents | null;
  } | null> => {
    const { guest, host } = input;
    const requestId = randomUUID();
    const answer = await screenShareBroker.ask(
      input.profileId,
      {
        id: requestId,
        guestId: guest.id,
        origin: input.origin,
        audio: input.audio,
      },
      (prompt) => host.send("catamorphic:screen-share-request", prompt),
    );
    const choice = answer?.choice;
    if (!choice) return null;
    if (choice.kind !== "tab")
      return guest.isDestroyed() ? null : { choice, tab: null };
    const tabId = tabSourceWebContentsId(choice.id);
    const tab = tabId === null ? null : webContents.fromId(tabId);
    // Only a page of the asking tab's window and browsing session: the
    // picker lists exactly those, and an incognito page stays its own.
    if (
      guest.isDestroyed() ||
      !tab ||
      tab.isDestroyed() ||
      tab.getType() !== "webview" ||
      tab.hostWebContents !== host ||
      tab.session !== guest.session
    ) {
      // The window readied that tab for this pick: it goes back to normal.
      if (tabId !== null)
        tellShareState(host, {
          guestId: tabId,
          state: "ended",
          origin: input.origin,
          requestId,
        });
      return null;
    }
    watchSharedTab({ tab, host, origin: input.origin, requestId });
    return { choice, tab };
  };

  /**
   * Browser tabs handed to a share, until their capture ends. The window
   * keeps such a tab laid out and awake while it is shared (Chrome keeps
   * painting a captured tab), so it learns when the share starts and
   * stops. Electron has no event for either: the capture is polled.
   */
  const sharedTabs = new Map<
    number,
    {
      host: WebContents;
      origin: string;
      /** The latest pick of the tab, which its next start or end settles. */
      requestId: string;
      since: number;
      sharing: boolean;
      timer: ReturnType<typeof setInterval>;
      /** Lets the window stop painting while covered, once the share ends. */
      release?: () => void;
    }
  >();
  const tellShareState = (
    host: WebContents,
    update: ScreenShareTabState,
  ): void => {
    if (!host.isDestroyed())
      host.send("catamorphic:screen-share-tab-state", update);
  };
  const watchSharedTab = (input: {
    tab: WebContents;
    host: WebContents;
    origin: string;
    requestId: string;
  }): void => {
    const { tab, host, origin, requestId } = input;
    const guestId = tab.id;
    const known = sharedTabs.get(guestId);
    if (known) {
      // Picked again (a second page, or the same page asking again): the
      // watch starts over, so an earlier share stopping meanwhile does not
      // end the one about to start. A capture still running says so again.
      // An earlier pick whose share never started is settled here.
      if (!known.sharing)
        tellShareState(host, {
          guestId,
          state: "ended",
          origin: known.origin,
          requestId: known.requestId,
        });
      known.since = Date.now();
      known.origin = origin;
      known.requestId = requestId;
      known.sharing = false;
      known.release?.();
      known.release = undefined;
      return;
    }
    const end = () => {
      const entry = sharedTabs.get(guestId);
      if (!entry) return;
      clearInterval(entry.timer);
      sharedTabs.delete(guestId);
      entry.release?.();
      tellShareState(host, {
        guestId,
        state: "ended",
        origin: entry.origin,
        requestId: entry.requestId,
      });
    };
    const timer = setInterval(() => {
      const entry = sharedTabs.get(guestId);
      if (!entry) return;
      if (tab.isDestroyed() || host.isDestroyed()) {
        end();
        return;
      }
      const captured = tab.isBeingCaptured();
      if (captured && !entry.sharing) {
        entry.sharing = true;
        // The window paints on while its tab is shared, even covered or
        // minimized, as Chrome paints a captured tab.
        entry.release = holdCaptureFrames(tab);
        tellShareState(host, {
          guestId,
          state: "sharing",
          origin: entry.origin,
          requestId: entry.requestId,
        });
      } else if (
        !captured &&
        (entry.sharing || Date.now() - entry.since > SHARE_START_MS)
      )
        end();
    }, SHARE_POLL_MS);
    timer.unref?.();
    sharedTabs.set(guestId, {
      host,
      origin,
      requestId,
      since: Date.now(),
      sharing: false,
      timer,
    });
  };

  /** Whether the OS can mix its own sound into an entire screen's share. */
  let declaresAudioCapture: boolean | undefined;
  const screenSystemAudio = (): boolean => {
    if (declaresAudioCapture === undefined) {
      // macOS records system audio only for an app whose bundle says why
      // (NSAudioCaptureUsageDescription); without it the track ends at once.
      try {
        declaresAudioCapture =
          process.platform === "darwin" &&
          fs
            .readFileSync(
              path.join(path.dirname(process.execPath), "..", "Info.plist"),
              "utf8",
            )
            .includes("NSAudioCaptureUsageDescription");
      } catch {
        declaresAudioCapture = false;
      }
    }
    return systemAudioSupported({
      platform: process.platform,
      osVersion: process.getSystemVersion(),
      declaresAudioCapture,
    });
  };

  sitePermissionPolicy = {
    request: async (guest, profileId, permission, details) => {
      // Asked whether its tab may close, a page holds a user activation
      // Electron grants for the question; it asks for nothing with it
      // (fullscreen, devices) while the question is open (ADR 0227).
      if (pageClosing(guest.id)) return false;
      const origin = siteOrigin(details.requestingUrl ?? guest.getURL());
      if (!origin) return ALWAYS_GRANTED_PERMISSIONS.has(permission);
      const decision = decideSitePermission(
        siteSettings.get(profileId, origin),
        permission,
        details,
      );
      if (decision.outcome === "block") return false;
      if (permission === "display-capture") {
        const host = guest.hostWebContents;
        if (!host || host.isDestroyed()) return false;
        // A display-capture request names the picture and, when the page
        // asked for it, its sound.
        const mediaTypes =
          "mediaTypes" in details && Array.isArray(details.mediaTypes)
            ? details.mediaTypes
            : [];
        const pick = await pickShare({
          guest,
          host,
          profileId,
          origin,
          audio: mediaTypes.includes("audio"),
        });
        if (!pick) return false;
        pendingShares.set(guest.id, { ...pick, at: Date.now() });
        return true;
      }
      // Every device the request opens goes past the OS gate, including
      // ones the site was already allowed.
      const devices = permissionKindsFor(permission, details).filter(
        (kind): kind is MediaDeviceKind =>
          kind === "camera" || kind === "microphone",
      );
      if (decision.outcome === "allow")
        return grantMedia({ guest, origin, kinds: devices });
      const host = guest.hostWebContents;
      if (!host || host.isDestroyed()) return false;
      const answer = await permissionBroker.askPermission(
        {
          profileId,
          origin,
          guestId: guest.id,
          kinds: decision.kinds,
          externalApp:
            permission === "openExternal" && details.externalURL
              ? externalAppFor(details.externalURL)
              : undefined,
        },
        (request) => {
          host.send("catamorphic:site-permission-request", request);
          return requestAttention(host, guest.id);
        },
      );
      if (!answer) return false;
      // An incognito tab's choice lasts only for that page's request.
      if (answer.remember && !isIncognito(guest)) {
        for (const kind of decision.kinds)
          siteSettings.set(profileId, origin, kind, answer.decision);
        siteSettingsChanged(profileId, origin);
      }
      if (answer.decision === "block") return false;
      return grantMedia({ guest, origin, kinds: devices });
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
        // The activation a tab's close granted shares no screen (ADR 0227).
        pageClosing(guest.id) ||
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
      const deliver = (
        pick: { choice: ScreenShareChoice; tab: WebContents | null } | null,
      ) => {
        const tab = pick?.tab;
        const streams =
          pick &&
          shareStreams({
            choice: pick.choice,
            tabFrame: tab && !tab.isDestroyed() ? tab.mainFrame : null,
            audioRequested: request.audioRequested,
            systemAudio: screenSystemAudio(),
          });
        if (!streams) {
          callback({});
          return;
        }
        noteCapture(guest);
        callback(streams);
      };
      if (stashed && Date.now() - stashed.at < SHARE_PICK_LIFETIME_MS) {
        deliver(stashed);
        return;
      }
      void pickShare({
        guest,
        host,
        profileId,
        origin,
        audio: request.audioRequested,
      }).then(deliver);
    },
  };

  const systemScreenAccess = (): SystemScreenAccess => {
    if (process.platform !== "darwin") return null;
    // macOS answers only yes or no: "denied" also means never asked, and
    // the first listing asks.
    return systemPreferences.getMediaAccessStatus("screen") === "granted"
      ? "granted"
      : "denied";
  };

  /**
   * The OS's windows and screens. macOS can take seconds to list windows
   * (and, rarely, never answers), so each kind is asked for on its own and
   * given up on after a while: the picker never waits forever.
   */
  const captureSources = async (
    kind: "window" | "screen",
  ): Promise<Electron.DesktopCapturerSource[] | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      desktopCapturer
        .getSources({
          types: [kind],
          thumbnailSize: SHARE_THUMBNAIL_SIZE,
          fetchWindowIcons: kind === "window",
        })
        .catch(() => []),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CAPTURER_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  /**
   * Linux on Wayland captures through the desktop portal (PipeWire): each
   * capturer opens the system's own picker and waits on the person, so
   * windows and screens are asked for once, together, with no time limit.
   * Both listings of one picker share that request.
   */
  const portalCapture =
    process.platform === "linux" &&
    /^wayland/i.test(process.env.XDG_SESSION_TYPE ?? "");
  let portalListing: Promise<Electron.DesktopCapturerSource[]> | null = null;

  shellIpcMain.handle(
    "catamorphic:screen-share-sources",
    async (_event, input: unknown): Promise<ScreenShareCaptureSources> => {
      const { kinds } = z
        .object({ kinds: z.array(z.enum(["window", "screen"])).min(1) })
        .parse(input);
      const wanted = new Set(kinds);
      if (portalCapture) {
        portalListing ??= desktopCapturer
          .getSources({
            types: ["window", "screen"],
            thumbnailSize: SHARE_THUMBNAIL_SIZE,
            fetchWindowIcons: true,
          })
          .catch(() => [])
          .finally(() => {
            portalListing = null;
          });
      }
      const portal = portalListing ? await portalListing : null;
      const [listedScreens, listedWindows] = portal
        ? // What the person chose in the portal, whichever kind it is.
          [portal, portal]
        : await Promise.all([
            wanted.has("screen") ? captureSources("screen") : [],
            wanted.has("window") ? captureSources("window") : [],
          ]);
      // Work's own helper surfaces (the detached dock, the voice bubble,
      // the passkey sheet) are not windows a person shares; its workspace
      // windows and the pages it opened in windows (a site's popup, an
      // extension's window) are.
      const helperWindows = new Set(
        BrowserWindow.getAllWindows()
          .filter((window) => {
            if (window.isDestroyed()) return false;
            const url = window.webContents.getURL();
            try {
              return (
                isShellDocument(url) && !new URL(url).searchParams.has("window")
              );
            } catch {
              return false;
            }
          })
          .map((window) => window.getMediaSourceId()),
      );
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
      let screens = (listedScreens ?? [])
        .filter((source) => portal !== null || source.id.startsWith("screen:"))
        .map((source) => toSource(source, "screen"));
      // macOS lists no screens when Screen Recording access is stale or
      // missing, or when it does not answer; the displays still exist and
      // their ids are what the capturer would have used, so sharing can
      // still be attempted.
      if (wanted.has("screen") && screens.length === 0 && !portal) {
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
        windows: (listedWindows ?? [])
          .filter(
            (source) =>
              (portal !== null || source.id.startsWith("window:")) &&
              !helperWindows.has(source.id),
          )
          .map((source) => toSource(source, "window")),
        screens,
        timedOut: listedScreens === null || listedWindows === null,
        system: systemScreenAccess(),
        systemAudio: screenSystemAudio(),
      };
    },
  );

  // The picker lists the window's tabs itself (sleeping ones too); live
  // pages get a picture here.
  shellIpcMain.handle(
    "catamorphic:screen-share-thumbnails",
    async (event, input: unknown): Promise<Record<number, string | null>> => {
      const { guestIds } = z
        .object({ guestIds: z.array(z.number().int()).max(200) })
        .parse(input);
      const entries = await Promise.all(
        guestIds.map(async (guestId): Promise<[number, string | null]> => {
          const contents = webContents.fromId(guestId);
          if (
            !contents ||
            contents.isDestroyed() ||
            contents.getType() !== "webview" ||
            contents.hostWebContents !== event.sender
          )
            return [guestId, null];
          // A background tab is a hidden webview, and on macOS its capture
          // can wait forever on a frame it never paints. It gets no
          // thumbnail rather than holding back the list.
          const capture = contents
            .capturePage(undefined, { stayHidden: true })
            .then((image) =>
              image.isEmpty()
                ? null
                : image
                    .resize({ width: SHARE_THUMBNAIL_SIZE.width })
                    .toDataURL(),
            )
            .catch(() => null);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const thumbnail = await Promise.race([
            capture,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), TAB_THUMBNAIL_TIMEOUT_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          return [guestId, thumbnail];
        }),
      );
      return Object.fromEntries(entries);
    },
  );

  shellIpcMain.handle(
    "catamorphic:screen-share-answer",
    (event, input: unknown) => {
      const answer = screenShareAnswerSchema.parse(input);
      return (
        screenShareBroker.answer(
          answer.requestId,
          answer,
          windows.profileFor(event.sender),
        ) !== null
      );
    },
  );

  const siteCookies = async (profileId: string, host: string) => {
    await prepareProfileSession(profileId);
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
      faviconUrl: siteIcon(profileId, origin, visit?.faviconUrl),
    };
  };

  const originInput = z.object({ origin: z.string().url() });

  shellIpcMain.handle(
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

  const revokeCapture = (profileId: string, origin: string, kind: string) => {
    if (kind !== "microphone" && kind !== "camera" && kind !== "screenShare")
      return;
    const browsingSession = session.fromPartition(partitionFor(profileId));
    for (const guest of webContents.getAllWebContents()) {
      if (guest.isDestroyed() || guest.session !== browsingSession) continue;
      for (const frame of guest.mainFrame.framesInSubtree) {
        if (!frame.isDestroyed() && !frame.detached && frame.origin === origin)
          frame.send("catamorphic:page-media-stop", kind);
      }
    }
  };

  shellIpcMain.handle(
    "catamorphic:site-settings-set",
    (event, input: unknown) => {
      const { origin, kind, state } = z
        .object({
          origin: z.string().url(),
          kind: sitePermissionKindSchema,
          state: sitePermissionStateSchema,
        })
        .parse(input);
      const profileId = windows.profileFor(event.sender);
      const permissions = siteSettings.set(profileId, origin, kind, state);
      if (state !== "allow") revokeCapture(profileId, origin, kind);
      siteSettingsChanged(profileId, origin);
      return permissions;
    },
  );

  shellIpcMain.handle(
    "catamorphic:site-settings-reset",
    (event, input: unknown) => {
      const { origin } = originInput.parse(input);
      const profileId = windows.profileFor(event.sender);
      siteSettings.reset(profileId, origin);
      for (const kind of ["microphone", "camera", "screenShare"])
        revokeCapture(profileId, origin, kind);
      siteSettingsChanged(profileId, origin);
    },
  );

  shellIpcMain.handle(
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

  shellIpcMain.handle(
    "catamorphic:site-settings-list",
    async (event): Promise<SiteSummary[]> => {
      const profileId = windows.profileFor(event.sender);
      const origins = new Set<string>(siteSettings.origins(profileId));
      const visits = history.siteVisits(profileId);
      for (const origin of visits.keys()) origins.add(origin);
      await prepareProfileSession(profileId);
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
          faviconUrl: siteIcon(profileId, origin, visit?.faviconUrl),
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

  shellIpcMain.handle(
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

  shellIpcMain.handle(
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

  shellIpcMain.handle(
    "catamorphic:browser-prepare-profile",
    async (event, raw: unknown) => {
      const { profileId: asked, incognito } = z
        .object({ profileId: z.string(), incognito: z.boolean() })
        .parse(raw);
      const profileId = windows.profileFor(event.sender);
      if (asked !== profileId)
        throw new Error("This browser profile belongs to another window.");
      await prepareProfileSession(profileId, incognito);
      return incognito
        ? incognitoPartitionFor(profileId)
        : partitionFor(profileId);
    },
  );

  const historyChanged = (profileId: string) => {
    for (const window of windows.windowsFor(profileId)) {
      if (!window.isDestroyed())
        window.webContents.send("catamorphic:history-changed");
    }
  };
  shellIpcMain.handle("catamorphic:history-query", (event, input: unknown) => {
    const query = z
      .object({
        query: z.string().max(4096).optional(),
        projectId: z.string().min(1).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200).optional(),
      })
      .parse(input);
    return history.query({
      profileId: windows.profileFor(event.sender),
      ...query,
    });
  });
  /** A visit names only projects of the profile it lands in. */
  const ownedProject = (
    profileId: string,
    project: HistoryProject | undefined,
  ): HistoryProject | undefined =>
    project && profiles.get(profileId)?.projectIds.includes(project.id)
      ? project
      : undefined;
  shellIpcMain.handle("catamorphic:history-record", (event, input: unknown) => {
    const { visit, revisit } = z
      .object({ visit: historyVisitSchema, revisit: z.boolean() })
      .parse(input);
    const profileId = windows.profileFor(event.sender);
    const project = ownedProject(profileId, visit.project);
    if (
      visit.target.kind !== "web" &&
      visit.target.kind !== "local" &&
      visit.target.projectId !== project?.id
    )
      return;
    history.recordVisit({ profileId, visit: { ...visit, project }, revisit });
    historyChanged(profileId);
  });
  shellIpcMain.handle("catamorphic:history-remove", (event, id: unknown) => {
    const profileId = windows.profileFor(event.sender);
    const entry = z.string().parse(id);
    history.remove({ profileId, id: entry });
    paletteUsage.forget(profileId, entry);
    historyChanged(profileId);
  });
  shellIpcMain.handle("catamorphic:history-clear", (event) => {
    const profileId = windows.profileFor(event.sender);
    history.clear(profileId);
    paletteUsage.clear(profileId);
    historyChanged(profileId);
  });
  shellIpcMain.handle("catamorphic:palette-record", (event, input: unknown) => {
    const use = paletteUseSchema.parse(input);
    const profileId = windows.profileFor(event.sender);
    paletteUsage.record({
      profileId,
      use: {
        ...use,
        projectId: ownedProject(
          profileId,
          use.projectId ? { id: use.projectId, name: "" } : undefined,
        )?.id,
      },
    });
  });
  shellIpcMain.handle("catamorphic:palette-signals", (event) => {
    const profileId = windows.profileFor(event.sender);
    return paletteUsage.signals({
      profileId,
      history: history.entries(profileId),
    });
  });

  shellIpcMain.handle(
    "catamorphic:browser-history-record",
    (event, input: unknown) => {
      const { url, title, project } = z
        .object({
          url: z.string(),
          title: z.string(),
          project: historyProjectSchema.optional(),
        })
        .parse(input);
      const profileId = windows.profileFor(event.sender);
      history.record({
        profileId,
        url,
        title,
        project: ownedProject(profileId, project),
      });
      historyChanged(profileId);
    },
  );

  shellIpcMain.handle(
    "catamorphic:browser-history-retitle",
    (event, input: { url: string; title: string }) => {
      history.retitle(windows.profileFor(event.sender), input.url, input.title);
      historyChanged(windows.profileFor(event.sender));
    },
  );
  shellIpcMain.handle(
    "catamorphic:browser-history-favicon",
    (event, input: { url: string; faviconUrl: string }) => {
      const profileId = windows.profileFor(event.sender);
      history.setFavicon(profileId, input.url, input.faviconUrl);
      // Sign-in pages never reach history; the site's icon is still known.
      const site = siteIcons.observe({
        profileId,
        pageUrl: input.url,
        iconUrl: input.faviconUrl,
        scheme: colorScheme(),
      });
      if (site) siteSettingsChanged(profileId, site);
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

  shellIpcMain.handle(
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
  const requireProfile = (raw: unknown) => {
    const id = z.string().min(1).max(256).parse(raw);
    if (!profiles.get(id)) throw new Error("Choose a profile again.");
    return id;
  };
  shellIpcMain.handle("catamorphic:profiles-list", () => profiles.list());
  shellIpcMain.handle("catamorphic:profiles-create", (_event, raw: unknown) => {
    const profile = profiles.create(z.string().min(1).max(1024).parse(raw));
    broadcast("catamorphic:profiles-changed", profiles.list());
    return profile;
  });
  shellIpcMain.handle(
    "catamorphic:profiles-update",
    (_event, rawId: unknown, rawPatch: unknown) => {
      const id = requireProfile(rawId);
      const patch = z
        .object({
          name: z.string().min(1).max(1024).optional(),
          color: z.string().max(128).optional(),
          defaultProjectId: z.string().max(256).optional(),
        })
        .parse(rawPatch);
      const profile = profiles.update(id, patch);
      broadcast("catamorphic:profiles-changed", profiles.list());
      return profile;
    },
  );
  // Settings shared between profiles (ADR 0272).
  const syncParts = z.array(z.enum(PROFILE_SYNC_PARTS)).min(1);
  shellIpcMain.handle(
    "catamorphic:profiles-sync-settings",
    (_event, raw: unknown) => {
      const input = z
        .object({
          profileId: z.string(),
          from: z.string(),
          parts: syncParts,
          keepInSync: z.boolean(),
        })
        .parse(raw);
      requireProfile(input.profileId);
      requireProfile(input.from);
      profileConfig.syncSettings(input);
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );
  shellIpcMain.handle(
    "catamorphic:profiles-stop-syncing",
    (_event, raw: unknown) => {
      const input = z
        .object({ profileId: z.string(), parts: syncParts })
        .parse(raw);
      requireProfile(input.profileId);
      profileConfig.stopSyncing(input);
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );
  shellIpcMain.handle(
    "catamorphic:profiles-set-default",
    (_event, id: string) => {
      profiles.setDefaultProfile(requireProfile(id));
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );
  shellIpcMain.handle("catamorphic:profiles-remove", (_event, id: string) => {
    const removed = profiles.remove(requireProfile(id));
    if (removed) broadcast("catamorphic:profiles-changed", profiles.list());
    return removed;
  });
  shellIpcMain.handle(
    "catamorphic:profiles-claim-project",
    (_event, profileId: string, projectId: string) => {
      profiles.claimProject(
        requireProfile(profileId),
        z.string().min(1).max(256).parse(projectId),
      );
      broadcast("catamorphic:profiles-changed", profiles.list());
    },
  );
  shellIpcMain.handle(
    "catamorphic:profiles-for-project",
    (_event, projectId: string) => profiles.profileForProject(projectId),
  );
  shellIpcMain.handle(
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
  const vaultIdInput = z.object({ id: z.string().min(1).max(256) });
  shellIpcMain.handle("catamorphic:vault-list", (_event, raw: unknown) => {
    // Profile settings shows a selected profile's saved-login count.
    // This read never returns passwords; secret operations bind to the caller.
    const input = z
      .object({
        profileId: z.string(),
        origin: z.string().max(2048).optional(),
      })
      .parse(raw);
    return vault.list(requireProfile(input.profileId), input.origin);
  });
  shellIpcMain.handle("catamorphic:vault-reveal", (event, raw: unknown) =>
    vault.reveal(windows.profileFor(event.sender), vaultIdInput.parse(raw).id),
  );
  shellIpcMain.handle(
    "catamorphic:vault-update",
    async (event, raw: unknown) => {
      const input = credentialInput
        .extend({
          profileId: z.string(),
          id: z.string(),
          password: z.string().min(1).max(4096).optional(),
        })
        .parse(raw);
      const profileId = windows.profileFor(event.sender);
      const updated = await vault.update(profileId, input.id, {
        origin: input.origin,
        username: input.username,
        password: input.password,
        note: input.note,
      });
      if (updated) vaultChanged(profileId);
      return updated;
    },
  );
  shellIpcMain.handle("catamorphic:vault-save", async (event, raw: unknown) => {
    const input = credentialInput
      .extend({ profileId: z.string(), password: z.string().min(1).max(4096) })
      .parse(raw);
    const profileId = windows.profileFor(event.sender);
    const saved = await vault.save(profileId, {
      origin: input.origin,
      username: input.username,
      password: input.password,
      note: input.note,
    });
    vaultChanged(profileId);
    return saved;
  });
  shellIpcMain.handle("catamorphic:vault-generate-password", () =>
    generateStrongPassword(),
  );
  shellIpcMain.handle("catamorphic:vault-never-saved", (event) =>
    vault.neverSaved(windows.profileFor(event.sender)),
  );
  shellIpcMain.handle(
    "catamorphic:vault-allow-saving",
    async (event, raw: unknown) => {
      const input = z.object({ origin: z.string().max(2048) }).parse(raw);
      const profileId = windows.profileFor(event.sender);
      await vault.setNeverSave(profileId, input.origin, false);
      vaultChanged(profileId);
    },
  );
  shellIpcMain.handle(
    "catamorphic:vault-copy-password",
    async (event, raw: unknown) => {
      const credential = await vault.reveal(
        windows.profileFor(event.sender),
        vaultIdInput.parse(raw).id,
      );
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
  shellIpcMain.handle(
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
  shellIpcMain.handle(
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
  shellIpcMain.handle(
    "catamorphic:browser-credential-dismiss",
    (event, input: { pendingId: string }) => {
      const pending = pendingCredentials.get(input.pendingId);
      if (pending?.hostId === event.sender.id) {
        pendingCredentials.delete(input.pendingId);
      }
    },
  );
  shellIpcMain.handle(
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
  shellIpcMain.handle(
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
  // A tab's back and forward list rides on its workspace entry, so a
  // reopened or restored tab can go back. Only the window hosting a guest
  // reads its history.
  const hostedGuest = (host: WebContents, guestId: unknown) => {
    if (typeof guestId !== "number") return null;
    const guest = webContents.fromId(guestId);
    return guest &&
      !guest.isDestroyed() &&
      guest.getType() === "webview" &&
      guest.hostWebContents === host
      ? guest
      : null;
  };
  const disposeSleep = registerBrowserSleep({
    hostedGuest,
    keepsAwake: (guestId) => extensions.keepsAwake(guestId),
  });
  shellIpcMain.handle(
    "catamorphic:browser-navigation-history",
    (event, input: { guestId: number }) => {
      const guest = hostedGuest(event.sender, input?.guestId);
      if (!guest) return null;
      return boundedBrowserHistory({
        entries: guest.navigationHistory
          .getAllEntries()
          .map(({ url, title }) => ({ url, title })),
        index: guest.navigationHistory.getActiveIndex(),
      });
    },
  );
  shellIpcMain.handle(
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
  shellIpcMain.handle("catamorphic:vault-passkeys", (event) =>
    vault.listPasskeys(windows.profileFor(event.sender)),
  );
  shellIpcMain.handle(
    "catamorphic:vault-remove",
    async (event, raw: unknown) => {
      const profileId = windows.profileFor(event.sender);
      await vault.remove(profileId, vaultIdInput.parse(raw).id);
      vaultChanged(profileId);
    },
  );
  shellIpcMain.handle("catamorphic:device-auth-available", () =>
    process.platform === "darwin"
      ? systemPreferences.canPromptTouchID()
      : false,
  );

  // --- bookmarks ---
  const bookmarksChanged = (projectId: string | null, profileId: string) =>
    broadcast("catamorphic:bookmarks-changed", {
      projectId,
      profileId,
      ...bookmarks.trees({ projectId: projectId ?? undefined, profileId }),
    });
  // An agent (or the person) editing bookmarks.json shows up live.
  const unwatchBookmarks = bookmarks.watch(({ projectIds, profileIds }) => {
    for (const projectId of projectIds)
      bookmarksChanged(projectId, profiles.profileForProject(projectId).id);
    for (const profileId of profileIds) bookmarksChanged(null, profileId);
  });

  shellIpcMain.handle(
    "catamorphic:bookmarks-get",
    (_event, input: { projectId: string; profileId: string }) =>
      bookmarks.trees(input),
  );
  shellIpcMain.handle(
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
  shellIpcMain.handle(
    "catamorphic:bookmarks-place",
    (_event, input: BookmarkPlacement) => {
      const bookmark = bookmarks.place(input);
      bookmarksChanged(input.projectId, input.profileId);
      return bookmark;
    },
  );
  shellIpcMain.handle(
    "catamorphic:bookmarks-move",
    (_event, input: BookmarkMove) => {
      bookmarks.move(input);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  shellIpcMain.handle(
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
  shellIpcMain.handle(
    "catamorphic:bookmarks-update",
    (_event, input: BookmarkUpdate) => {
      bookmarks.update(input);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  shellIpcMain.handle(
    "catamorphic:bookmarks-remove",
    (_event, input: BookmarkRemoval) => {
      bookmarks.remove(input);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  shellIpcMain.handle(
    "catamorphic:bookmarks-pin",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.pin(input.projectId, input.profileId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  shellIpcMain.handle(
    "catamorphic:bookmarks-unpin",
    (_event, input: { projectId: string; profileId: string; id: string }) => {
      bookmarks.unpin(input.profileId, input.projectId, input.id);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );
  shellIpcMain.handle(
    "catamorphic:bookmarks-rename-folder",
    (_event, input: BookmarkFolderRename) => {
      bookmarks.renameFolder(input);
      bookmarksChanged(input.projectId, input.profileId);
    },
  );

  // --- workspace config (per sender profile) ---
  const workspaceFor = (event: Electron.IpcMainInvokeEvent) =>
    profileConfig.forProfile(windows.profileFor(event.sender)).workspace;

  // Layered per project (ADR 0043): project-local override → project
  // `.work/workspace.js` → profile `workspace.js` → built-in default.
  // Without a projectId only the profile layer applies (boot, settings).
  // The `-file`/`-source`/`-reset` handlers below stay profile-scoped:
  // they back the Settings "edit workspace.js" surface.
  shellIpcMain.handle(
    "catamorphic:workspace-config-get",
    async (event, projectId?: string) => {
      const profileId = windows.profileFor(event.sender);
      if (!projectId) return profileConfig.resolveWorkspace(profileId);
      const rootPath = await projectRootFor(projectId);
      const resolved = profileConfig.resolveWorkspace(profileId, {
        id: projectId,
        rootPath,
      });
      return rootPath
        ? { ...resolved, config: withModuleLists(resolved.config, rootPath) }
        : resolved;
    },
  );
  shellIpcMain.handle(
    "catamorphic:workspace-config-file",
    (event) => workspaceFor(event).file,
  );
  shellIpcMain.handle("catamorphic:workspace-config-source", (event) =>
    workspaceFor(event).read(),
  );
  shellIpcMain.handle("catamorphic:workspace-config-reset", (event) => {
    workspaceFor(event).write(DEFAULT_WORKSPACE_FILE);
  });
  // Change fan-out lives in main/index.ts (profileConfig.onWorkspaceChanged),
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
  shellIpcMain.handle("catamorphic:browser-import-list", () => {
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
  shellIpcMain.handle(
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
            bookmarksChanged(null, profileId);
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
            await prepareProfileSession(profileId);
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

  // --- password and passkey files (ADR 0201) ---
  /** KeePass databases waiting for their password, by token. */
  const lockedFiles = new Map<
    string,
    {
      profileId: string;
      /** The window that picked the file; only it may unlock or change it. */
      hostId: number;
      name: string;
      bytes: Buffer;
      keyFile: { name: string; bytes: Buffer } | null;
      expires: NodeJS.Timeout;
    }
  >();
  /** Exports and databases are small; anything larger is not one. */
  const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
  const readImportFile = (file: string): Buffer => {
    if (fs.statSync(file).size > MAX_IMPORT_BYTES)
      throw new PasswordFileError(
        "This file is too large to be a password export.",
      );
    return fs.readFileSync(file);
  };
  /** A locked database the calling window opened, for its profile. */
  const lockedFor = (sender: WebContents, token: string) => {
    const locked = lockedFiles.get(token);
    return locked &&
      locked.hostId === sender.id &&
      windows.profileFor(sender) === locked.profileId
      ? locked
      : null;
  };
  const forgetLocked = (token: string) => {
    const locked = lockedFiles.get(token);
    if (!locked) return;
    clearTimeout(locked.expires);
    locked.bytes.fill(0);
    locked.keyFile?.bytes.fill(0);
    lockedFiles.delete(token);
  };
  /** Where an import's file picker looks; E2E names files instead. */
  const pickFile = async (
    sender: WebContents,
    options: Electron.OpenDialogOptions,
  ): Promise<string | null> => {
    const scripted = process.env.CATAMORPHIC_E2E_PICK_FILE;
    if (process.env.CATAMORPHIC_E2E_DATA_DIR && scripted) {
      // The test writes the path it wants picked next ("" cancels).
      const next = fs.readFileSync(scripted, "utf8").trim();
      return next || null;
    }
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) return null;
    const picked = await dialog.showOpenDialog(window, options);
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  };
  const importVault = async (
    profileId: string,
    contents: ImportedVault,
  ): Promise<PasswordFileImportResult> => {
    const result = await vault.importMissing({
      profileId,
      credentials: contents.logins,
      passkeys: contents.passkeys,
    });
    if (result.imported + result.importedPasskeys > 0) vaultChanged(profileId);
    return {
      status: "imported",
      passwords: result.imported,
      passkeys: result.importedPasskeys,
      existing: result.existing,
      skipped: contents.skipped,
    };
  };
  const failed = (error: unknown): PasswordFileImportResult => ({
    status: "failed",
    message:
      error instanceof PasswordFileError
        ? error.message
        : "Work couldn't save what this file holds. Try again.",
  });
  shellIpcMain.handle(
    "catamorphic:password-file-import",
    async (event, input: unknown): Promise<PasswordFileImportResult> => {
      const { profileId } = z.object({ profileId: z.string() }).parse(input);
      if (!profiles.get(profileId)) throw new Error("Choose a profile again.");
      const file = await pickFile(event.sender, {
        title: "Import passwords and passkeys",
        properties: ["openFile"],
        filters: [
          {
            name: "CSV, Bitwarden JSON or KeePass database",
            extensions: ["csv", "json", "kdbx"],
          },
        ],
      });
      if (!file) return { status: "cancelled" };
      let bytes: Buffer;
      try {
        bytes = readImportFile(file);
      } catch (error) {
        return error instanceof PasswordFileError
          ? failed(error)
          : { status: "failed", message: "Work couldn't read this file." };
      }
      if (passwordFileKind(bytes) === "kdbx") {
        const token = randomUUID();
        lockedFiles.set(token, {
          profileId,
          hostId: event.sender.id,
          name: path.basename(file),
          bytes,
          keyFile: null,
          // An unlock nobody finishes lets the file go.
          expires: setTimeout(() => forgetLocked(token), 10 * 60_000),
        });
        return {
          status: "locked",
          token,
          name: path.basename(file),
          keyFile: null,
          wrongKey: false,
        };
      }
      try {
        const contents = readPasswordFile(bytes);
        return await importVault(profileId, contents);
      } catch (error) {
        return failed(error);
      } finally {
        bytes.fill(0);
      }
    },
  );
  shellIpcMain.handle(
    "catamorphic:password-file-unlock",
    async (event, input: unknown): Promise<PasswordFileImportResult> => {
      const { profileId, token, password } = z
        .object({
          profileId: z.string(),
          token: z.string(),
          password: z.string().max(4096),
        })
        .parse(input);
      const locked = lockedFor(event.sender, token);
      if (!locked || locked.profileId !== profileId)
        return {
          status: "failed",
          message: "Choose the database again.",
        };
      try {
        const contents = await readKeepassDatabase({
          bytes: locked.bytes,
          password,
          keyFile: locked.keyFile?.bytes,
        });
        forgetLocked(token);
        return await importVault(profileId, contents);
      } catch (error) {
        if (error instanceof WrongDatabaseKey)
          return {
            status: "locked",
            token,
            name: locked.name,
            keyFile: locked.keyFile?.name ?? null,
            wrongKey: true,
          };
        forgetLocked(token);
        return failed(error);
      }
    },
  );
  shellIpcMain.handle(
    "catamorphic:password-file-key-file",
    async (event, input: unknown) => {
      const { token, clear } = z
        .object({ token: z.string(), clear: z.boolean().optional() })
        .parse(input);
      const locked = lockedFor(event.sender, token);
      if (!locked) return null;
      if (clear) {
        locked.keyFile?.bytes.fill(0);
        locked.keyFile = null;
        return { keyFile: null };
      }
      const file = await pickFile(event.sender, {
        title: "Choose the database's key file",
        properties: ["openFile"],
      });
      if (!file) return { keyFile: locked.keyFile?.name ?? null };
      let bytes: Buffer;
      try {
        bytes = readImportFile(file);
      } catch {
        return { keyFile: locked.keyFile?.name ?? null };
      }
      locked.keyFile?.bytes.fill(0);
      locked.keyFile = { name: path.basename(file), bytes };
      return { keyFile: locked.keyFile.name };
    },
  );
  shellIpcMain.handle(
    "catamorphic:password-file-forget",
    (event, input: unknown) => {
      const { token } = z.object({ token: z.string() }).parse(input);
      if (lockedFor(event.sender, token)) forgetLocked(token);
    },
  );

  return {
    history,
    customization: async (projectId, input) => {
      const root = await projectRootFor(projectId);
      if (!root) throw new Error("This project has no local folder.");
      const authoring = customizationAuthoring({
        cacheDirectory: path.join(userData, "authoring"),
        assetsFile: path.join(
          app.getAppPath(),
          "out/main/authoring-assets.json",
        ),
      });
      if (input.action === "reference")
        return {
          ...authoring,
          content: fs.readFileSync(authoring.reference, "utf8"),
        };
      const sourcePath =
        typeof input.sourcePath === "string" ? input.sourcePath : undefined;
      const workspacePath =
        typeof input.workspacePath === "string"
          ? input.workspacePath
          : undefined;
      const toolchain = await sidebarToolchain();
      if (input.action === "check")
        return checkCustomization({
          projectRoot: root,
          sourcePath,
          workspacePath,
          sdkRoot: authoring.sdkRoot,
          bunPath: toolchain.CATAMORPHIC_BUN,
          kind: input.kind === "workflow" ? "workflow" : "source",
        });
      if (!sourcePath) throw new Error("Name this package's source file.");
      const profileId = profiles.profileForProject(projectId).id;
      const modulePath = path.resolve(root, sourcePath);
      const declaration = readModuleAccess({ projectRoot: root, modulePath });
      const subject = moduleAccessSubject({
        projectId,
        projectRoot: root,
        modulePath,
        declaration,
      });
      const approved = await approvals
        .approvalsFor(profileId)
        .approved(subject, { refresh: true });
      const required = accessBeyond(approved, declaration.access);
      if (!isEmptyAccess(required))
        return { ok: false, accessRequired: required, package: subject };
      const options =
        typeof input.options === "object" && input.options !== null
          ? input.options
          : {};
      const viewId = crypto.randomUUID();
      const viewController = new AbortController();
      const host = async (raw: unknown) => {
        viewController.signal.throwIfAborted();
        const current = readModuleAccess({ projectRoot: root, modulePath });
        const currentSubject = moduleAccessSubject({
          projectId,
          projectRoot: root,
          modulePath,
          declaration: current,
        });
        if (
          currentSubject !== subject ||
          !isEmptyAccess(
            accessBeyond(
              await approvals
                .approvalsFor(profileId)
                .approved(subject, { refresh: true }),
              current.access,
            ),
          )
        )
          throw new Error("This package's access needs approval.");
        parseWorkCall(raw, declaration.access);
        const call = parseWorkCall(raw, current.access);
        viewController.signal.throwIfAborted();
        if (call.op === "read" || call.op === "execute") {
          const sender = moduleSandbox.targetFor?.(projectId);
          if (
            !sender ||
            sender.isDestroyed() ||
            windows.profileFor(sender) !== profileId
          )
            throw new Error(
              "Open this project in Work to preview its live lists.",
            );
          return disposeSidebarSources.windowWork({
            sender,
            projectId,
            sectionId: "preview",
            call,
          });
        }
        if (!moduleSandbox.hostCall)
          throw new Error("The host runtime is unavailable.");
        return moduleSandbox.hostCall({
          viewId,
          viewSignal: viewController.signal,
          profileId,
          projectId,
          modulePath,
          subject,
          access: current.access,
          workflows: (declaration.access.workflows ?? []).filter((name) =>
            current.access.workflows?.includes(name),
          ),
          call,
        });
      };
      if (input.action === "state-read")
        return host(
          z
            .object({ op: z.literal("state-read"), key: z.string() })
            .parse({ op: input.action, ...options }),
        );
      if (input.action === "state-write")
        return host(
          z
            .object({
              op: z.literal("state-write"),
              key: z.string(),
              value: z.json(),
              ifVersion: z.number().int().nonnegative(),
            })
            .parse({ op: input.action, ...options }),
        );
      if (input.action === "process-list") return host({ op: "process-list" });
      if (input.action === "process-read")
        return host(
          z
            .object({
              op: z.literal("process-read"),
              key: z.string(),
              cursor: z.number().optional(),
              maxBytes: z.number().optional(),
              waitMs: z.number().optional(),
            })
            .parse({ op: input.action, ...options }),
        );
      if (input.action === "process-stop")
        return host(
          z
            .object({ op: z.literal("process-stop"), key: z.string() })
            .parse({ op: input.action, ...options }),
        );
      const request = sourceRequestSchema.parse({
        ...options,
        projectId,
        sectionId: "preview",
        requestId: crypto.randomUUID(),
        method: Reflect.get(options, "method") ?? "load",
      });
      const { after, ...previewRequest } = request;
      return previewCustomization({
        projectRoot: root,
        sourcePath,
        workerPath: authoring.worker,
        scratchRoot: path.join(userData, "authoring-preview"),
        toolchain,
        approvedAccess: approved ?? {},
        blocked: (host, port) =>
          isLoopback(host) && moduleSandbox.workPorts().includes(port),
        cleanup: async () => {
          viewController.abort();
          await moduleSandbox.sourceStopped?.({
            profileId,
            projectId,
            modulePath,
            viewId,
            viewSignal: viewController.signal,
          });
        },
        request: {
          ...previewRequest,
          ...(after === undefined
            ? {}
            : { after: sanitizeSidebarSourceItem(after) }),
        },
        work: async (_id, raw) => host(raw),
      });
    },
    profileOf,
    images,
    dispose: () => {
      ipcMain.removeHandler("catamorphic:window-image");
      approvals.dispose();
      disposeTrustedHosts();
      unwatchBookmarks();
      disposeSidebarSources.dispose();
      disposePasskeys();
      disposeSleep();
      disposeDialogs();
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
      for (const token of [...lockedFiles.keys()]) forgetLocked(token);
      unsubscribeRemoved();
      history.dispose();
      paletteUsage.dispose();
      vault.dispose();
      for (const timer of incognitoEnds.values()) clearTimeout(timer);
      incognitoEnds.clear();
      sitePermissionPolicy = null;
      downloadHook = null;
      extensionsHost = null;
      extensions.dispose();
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

/**
 * The layout as the window gets it: each module section carries the lists
 * its package.json declares (ADR 0277), so the window knows which list a
 * module shows (a module over Work's tabs takes them out of the top bar).
 */
function withModuleLists(
  config: WorkspaceConfig,
  projectRoot: string,
): WorkspaceConfig {
  const annotate = (section: SidebarSectionConfig): SidebarSectionConfig => {
    const module = sectionModule(section);
    if (!module) return section;
    try {
      const { access } = readModuleAccess({
        modulePath: path.resolve(projectRoot, module),
        projectRoot,
      });
      return access.lists?.length
        ? { ...section, moduleLists: access.lists }
        : section;
    } catch {
      // Its section shows what is wrong when it loads.
      return section;
    }
  };
  const side = (tabs: WorkspaceConfig["sidebars"]["left"]) =>
    tabs.map((tab) => ({ ...tab, sections: tab.sections.map(annotate) }));
  return {
    ...config,
    sidebars: {
      left: side(config.sidebars.left),
      right: side(config.sidebars.right),
    },
  };
}
