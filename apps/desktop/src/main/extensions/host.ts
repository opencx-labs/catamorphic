import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
  webContents,
} from "electron";
import { z } from "zod";
import type { Keybindings } from "../../shared/actions.js";
import {
  EXTENSION_CHANNELS,
  type ExtensionActionResult,
  type ExtensionActionState,
  type ExtensionCallAnswer,
  type ExtensionCommandSummary,
  type ExtensionDebugging,
  type ExtensionInstalled,
  type ExtensionPrompt,
  type ExtensionSidePanel,
  type ExtensionSummary,
  type ExtensionsState,
  type ExtensionTabsReport,
  type ExtensionWindowRequest,
  extensionIdSchema,
  extensionPromptAnswerSchema,
  extensionTabsReportSchema,
  extensionViewSchema,
  extensionWindowResponseSchema,
  WEBSTORE_METHODS,
  type WebStoreMethod,
} from "../../shared/extensions.js";
import { matchesShortcut } from "../../shared/keybindings.js";
import { ActionStore, cssColor, DEFAULT_BADGE_BACKGROUND } from "./actions.js";
import { type ApiHandler, type Caller, createApi } from "./api.js";
import { extractArchive } from "./archive.js";
import {
  BRAND_EXTENSION_ID,
  NETWORK_PERMISSIONS,
  writeBrandExtension,
} from "./brand.js";
import { isActionCommand } from "./commands.js";
import {
  ContextMenuStore,
  type MenuEntry,
  pageMenuTarget,
  type SavedMenus,
  savedMenusSchema,
} from "./context-menus.js";
import type { VerifiedCrx } from "./crx.js";
import { ExtensionDebuggers } from "./debugger.js";
import {
  type ExtensionContext,
  ExtensionEvents,
  keepWorkerAlive,
} from "./events.js";
import { extensionFile, fileDataUrl } from "./icons.js";
import { LoadedExtension } from "./loaded.js";
import {
  accessIncrease,
  accessOf,
  accessWarnings,
  allRulesets,
  coversAllHosts,
  defaultRulesets,
  isEmptyAccess,
  localizer,
  ManifestError,
  type PermissionSet,
  parseManifest,
  permissionWarnings,
  readManifest,
} from "./manifest.js";
import {
  NATIVE_ERRORS,
  NativePort,
  nativeHostDirs,
  resolveNativeHost,
} from "./native-messaging.js";
import { ExtensionRegistry, type InstalledExtension } from "./registry.js";
import { SyncStorage } from "./sync-storage.js";
import {
  type TabEvent,
  type TabRecord,
  TabRegistry,
  type WindowRecord,
} from "./tabs.js";
import { matchesAny, patternCovers, scriptableUrl } from "./url-policy.js";
import { WebNavigationEvents } from "./web-navigation.js";
import {
  isWebStorePage,
  WebStore,
  webStoreOptions,
  webStoreOrigin,
} from "./webstore.js";

/**
 * Chrome extensions in Work's browser (ADR 0203). One host for the app:
 * it loads each profile's extensions into that profile's browsing session,
 * answers their `chrome.*` calls (api.ts), installs and updates them from
 * the Chrome Web Store, and drives the browser UI that shows them (toolbar
 * buttons, popups, the side panel, dialogs, menus, commands).
 */

const UPDATE_INTERVAL_MS = 5 * 60 * 60 * 1000;
/** At most one toolbar refresh per frame or so. */
const ACTIONS_CHANGED_MS = 50;
/** How long an event the person caused lets a worker ask for more (Chromium's activation). */
const GESTURE_MS = 5_000;
/** How soon an update that waited for its extension to be idle tries again. */
const UPDATE_RETRY_MS = 10 * 60 * 1000;
const FIRST_UPDATE_DELAY_MS = 60 * 1000;
const WINDOW_REQUEST_TIMEOUT_MS = 15_000;
const PROMPT_LIFETIME_MS = 10 * 60 * 1000;

export interface ExtensionsHostOptions {
  profilesDir: string;
  userData: string;
  /** The window→profile map the app keeps. */
  profileFor: (sender: WebContents) => string;
  windowsFor: (profileId: string) => BrowserWindow[];
  isDock: (window: BrowserWindow) => boolean;
  /** Sec-CH-UA values for a session (ADR 0194). */
  brands: (session: Session) => { brands: string; fullVersionList: string };
  /** Turn the session's webRequest brand rewrite on or off. */
  setBrandListener: (session: Session, on: boolean) => void;
  keybindings: (profileId: string) => Keybindings;
  /** E2E names files instead of showing a picker. */
  pickFolder: (sender: WebContents) => Promise<string | null>;
  history: {
    entries: (profileId: string) => readonly {
      id: string;
      title: string;
      lastVisitAt: number;
      visitCount: number;
      target: { kind: string; url?: string };
    }[];
  };
  bookmarks: () => {
    pinned: (profileId: string) => BookmarkTree;
    library: (profileId: string) => BookmarkTree;
  };
  downloads: DownloadsAccess;
}

export interface BookmarkTree {
  folders: {
    id: string;
    label: string;
    parentId?: string;
    position?: number;
  }[];
  bookmarks: {
    id: string;
    label: string;
    url: string;
    folderId?: string;
    position?: number;
  }[];
}

export interface DownloadsAccess {
  list: (profileId: string) => {
    id: string;
    filename: string;
    url: string;
    savePath: string;
    mimeType: string;
    totalBytes: number;
    receivedBytes: number;
    state: string;
    startedAt: number;
    finishedAt: number | null;
    exists: boolean;
    canResume: boolean;
  }[];
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  remove: (profileId: string, id: string) => void;
  onChange: (listener: (profileId: string) => void) => () => void;
  /**
   * The next download of `url` in this profile (downloads.download): named
   * as asked, its id once it starts, or null when it doesn't.
   */
  expect: (
    profileId: string,
    url: string,
    filename: string | null,
  ) => Promise<string | null>;
}

interface PendingPrompt {
  prompt: ExtensionPrompt;
  profileId: string;
  window: BrowserWindow;
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StoreApproval {
  profileId: string;
  /** What the person saw and accepted (see `accessOf`). */
  access: PermissionSet;
  at: number;
}

const key = (profileId: string, extensionId: string) =>
  `${profileId}:${extensionId}`;

function hasServiceWorker(manifest: LoadedExtension["manifest"]): boolean {
  const background = manifest.background;
  return Boolean(
    background !== null &&
      typeof background === "object" &&
      "service_worker" in background &&
      background.service_worker,
  );
}

const portKey = (context: ExtensionContext, portId: string) =>
  `${context.key}|${portId}`;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class ExtensionsHost {
  readonly registry: ExtensionRegistry;
  readonly tabs: TabRegistry;
  readonly menus = new ContextMenuStore();
  readonly events: ExtensionEvents;
  readonly debuggers: ExtensionDebuggers;
  readonly syncStorage: SyncStorage;
  readonly webStore: WebStore;
  private readonly navigation: WebNavigationEvents;
  private readonly api: Record<string, ApiHandler>;
  readonly actions = new ActionStore();
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly loadErrors = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  private readonly sessionProfiles = new WeakMap<Session, string>();
  private readonly workersWired = new WeakSet<ServiceWorkerMain>();
  private readonly expectedUnloads = new Set<string>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly approvals = new Map<string, StoreApproval>();
  private readonly installing = new Set<string>();
  private readonly checking = new Set<string>();
  private readonly updateTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly actionsTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Open side panels, by the tab they sit beside. */
  private readonly sidePanels = new Map<number, ExtensionSidePanel>();
  /** Each window's tab reports, one per project mounted in it. */
  private readonly tabReports = new Map<
    number,
    Map<string, ExtensionTabsReport>
  >();
  /** Extensions told `runtime.onInstalled` or `onStartup` this run. */
  private readonly installedThisRun = new Set<string>();
  private readonly startedThisRun = new Set<string>();
  /** When the person last acted on each extension (`profile:id`). */
  private readonly gestures = new Map<string, number>();
  /** Tabs whose closing already clears their side panel. */
  private readonly panelTabs = new WeakSet<WebContents>();
  /** Extension pages the app shows: popup and side panel views. */
  private readonly views = new Map<
    number,
    {
      kind: "popup" | "side-panel";
      extensionId: string;
      tabGuestId: number | null;
      profileId: string;
    }
  >();
  private readonly nativePorts = new Map<
    string,
    { port: NativePort; context: ExtensionContext; release: () => void }
  >();
  private readonly windowRequests = new Map<
    number,
    { resolve: (result: { guestId?: number } | null) => void; sender: number }
  >();
  private nextWindowRequest = 1;
  private readonly brandLoaded = new Set<string>();
  private readonly debuggerHolds = new Map<string, () => void>();
  private readonly disposers: (() => void)[] = [];
  private readonly preloadPath: string;

  constructor(private readonly options: ExtensionsHostOptions) {
    this.registry = new ExtensionRegistry(options.profilesDir);
    this.syncStorage = new SyncStorage((profileId, extensionId) =>
      path.join(
        this.registry.dataDir(profileId, extensionId),
        "sync-storage.json",
      ),
    );
    this.tabs = new TabRegistry((profileId, event) =>
      this.onTabEvent(profileId, event),
    );
    this.events = new ExtensionEvents(
      (profileId, extensionId) => this.startWorker(profileId, extensionId),
      (context) => this.closePortsOf(context.key),
    );
    this.debuggers = new ExtensionDebuggers(
      {
        onEvent: (client, tabId, method, params, sessionId) => {
          const [profileId, extensionId] = client.split(":");
          if (profileId && extensionId)
            this.events.dispatch(profileId, extensionId, "debugger.onEvent", [
              sessionId ? { tabId, sessionId } : { tabId },
              method,
              params,
            ]);
        },
        onDetach: (client, tabId, reason) => {
          const [profileId, extensionId] = client.split(":");
          if (profileId && extensionId)
            this.events.dispatch(profileId, extensionId, "debugger.onDetach", [
              { tabId },
              reason,
            ]);
        },
        onChange: (tabId) => this.debuggingChanged(tabId),
        closeTab: async (tabId) => {
          const tab = this.tabs.tab(tabId);
          const window = tab ? this.tabs.window(tab.windowId) : null;
          if (!tab || !window) return;
          if (window.type === "popup") window.window.close();
          else
            await this.requestWindow(window.window, {
              kind: "close-tab",
              guestId: tabId,
            });
        },
      },
      (url) => scriptableUrl(url) && !isWebStorePage(url),
    );
    this.navigation = new WebNavigationEvents((profileId, name, details) => {
      for (const extension of this.loadedIn(profileId)) {
        if (!extension.has("webNavigation")) continue;
        this.events.dispatch(profileId, extension.id, `webNavigation.${name}`, [
          details,
        ]);
      }
    });
    this.webStore = new WebStore(
      webStoreOptions((url) => fetch(url, { redirect: "follow" })),
    );
    this.preloadPath = path.join(import.meta.dirname, "../preload/session.cjs");
    this.api = createApi(this);
    this.registerIpc();
    this.registerAppEvents();
  }

  // ---- Profiles and sessions --------------------------------------------------------

  profileOfSession(session: Session): string | null {
    return this.sessionProfiles.get(session) ?? null;
  }

  session(profileId: string): Session | null {
    return this.sessions.get(profileId) ?? null;
  }

  loadedIn(profileId: string): LoadedExtension[] {
    return [...this.loaded.values()].filter(
      (extension) => extension.profileId === profileId,
    );
  }

  get downloads(): DownloadsAccess {
    return this.options.downloads;
  }

  bookmarks() {
    return this.options.bookmarks();
  }

  historyEntries(profileId: string) {
    return this.options.history.entries(profileId);
  }

  extension(profileId: string, extensionId: string): LoadedExtension | null {
    return this.loaded.get(key(profileId, extensionId)) ?? null;
  }

  /** Called while a profile's browsing session is prepared, before tabs load. */
  async prepare(session: Session, profileId: string): Promise<void> {
    this.sessions.set(profileId, session);
    this.sessionProfiles.set(session, profileId);
    const registered = new Set(
      session.getPreloadScripts().map((script) => script.id),
    );
    for (const type of ["frame", "service-worker"] as const) {
      const id = `work-extensions-${type}`;
      if (!registered.has(id))
        session.registerPreloadScript({ id, type, filePath: this.preloadPath });
    }
    session.cookies.on("changed", (_event, cookie, cause, removed) =>
      this.cookieChanged(profileId, cookie, cause, removed),
    );
    session.serviceWorkers.on("running-status-changed", (details) => {
      const { versionId, runningStatus } = details;
      if (runningStatus === "stopped" || runningStatus === "stopping") {
        this.events.workerStopped(versionId);
        this.closePortsOf(`worker:${versionId}`);
        return;
      }
      const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
      if (worker) this.wireWorker(session, profileId, worker);
      if (runningStatus === "running") this.events.workerRunning(versionId);
    });
    // An extension worker's errors and warnings reach the app's log, the
    // way Chrome lists them on its extensions page.
    session.serviceWorkers.on("console-message", (_event, details) => {
      // Levels: 0 verbose, 1 info, 2 warning, 3 error.
      if (details.level < 2) return;
      const worker = session.serviceWorkers.getWorkerFromVersionID(
        details.versionId,
      );
      if (!worker?.scope.startsWith("chrome-extension://")) return;
      console.warn(
        `[extensions] ${new URL(worker.scope).host}: ${details.message}`,
      );
    });
    session.extensions.on("extension-unloaded", (_event, extension) => {
      const id = key(profileId, extension.id);
      if (this.expectedUnloads.delete(id)) return;
      // The extension reloaded itself (runtime.reload, the answer to
      // onUpdateAvailable) or crashed out: a waiting update goes in now.
      const loaded = this.loaded.get(id);
      if (loaded) this.forgetRuntime(loaded);
      if (this.registry.get(profileId, extension.id)?.stagedUpdate)
        this.retryStaged(profileId, 0);
    });
    session.extensions.on("extension-loaded", (_event, extension) => {
      const loaded = this.loaded.get(key(profileId, extension.id));
      if (loaded && !this.actions.has(profileId, extension.id))
        this.initRuntime(loaded);
    });
    for (const record of this.registry.list(profileId)) {
      // An update that waited for its extension starts with it.
      const staged = record.stagedUpdate;
      const current = staged
        ? this.registry.update(profileId, record.id, (entry) => ({
            ...entry,
            path: staged.path,
            version: staged.version,
            updatedAt: Date.now(),
            approved: staged.approved,
            stagedUpdate: null,
            enabledRulesets: null,
          }))
        : record;
      if (staged) this.pruneVersions(profileId, record.id, staged.path);
      if (!current?.enabled) continue;
      await this.load(profileId, current);
    }
    await this.syncBrand(profileId);
    this.scheduleUpdates(profileId);
  }

  releaseProfile(profileId: string): void {
    // Its extensions leave the session too, so nothing (an alarm, an open
    // port) wakes a removed profile's workers again.
    const session = this.sessions.get(profileId);
    for (const extension of this.loadedIn(profileId)) {
      this.forgetRuntime(extension);
      if (session?.extensions.getExtension(extension.id)) {
        this.expectedUnloads.add(key(profileId, extension.id));
        session.extensions.removeExtension(extension.id);
      }
    }
    if (session?.extensions.getExtension(BRAND_EXTENSION_ID)) {
      this.expectedUnloads.add(key(profileId, BRAND_EXTENSION_ID));
      session.extensions.removeExtension(BRAND_EXTENSION_ID);
    }
    for (const id of [...this.loaded.keys()])
      if (id.startsWith(`${profileId}:`)) this.loaded.delete(id);
    clearTimeout(this.updateTimers.get(profileId));
    this.updateTimers.delete(profileId);
    clearTimeout(this.retryTimers.get(profileId));
    this.retryTimers.delete(profileId);
    clearTimeout(this.actionsTimers.get(profileId));
    this.actionsTimers.delete(profileId);
    this.sessions.delete(profileId);
    this.brandLoaded.delete(profileId);
    this.registry.releaseProfile(profileId);
    this.syncStorage.releaseProfile(profileId);
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const timer of this.updateTimers.values()) clearTimeout(timer);
    this.updateTimers.clear();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const timer of this.actionsTimers.values()) clearTimeout(timer);
    this.actionsTimers.clear();
    for (const entry of this.nativePorts.values()) entry.port.close();
    this.nativePorts.clear();
    for (const pending of this.prompts.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.prompts.clear();
    this.syncStorage.dispose();
  }

  /**
   * Profiles whose extensions filter requests rewrite the brand headers
   * through the hidden brand extension; others keep the webRequest rewrite.
   */
  private async syncBrand(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId);
    if (!session) return;
    const network = this.loadedIn(profileId).some((extension) =>
      [
        ...extension.required.permissions,
        ...extension.granted.permissions,
      ].some((permission) => NETWORK_PERMISSIONS.has(permission)),
    );
    const loaded = this.brandLoaded.has(profileId);
    if (network && !loaded) {
      try {
        const dir = writeBrandExtension(
          path.join(this.options.userData, "extension-components", "brand"),
          this.options.brands(session),
        );
        await session.extensions.loadExtension(dir);
        this.brandLoaded.add(profileId);
        await session.serviceWorkers
          .startWorkerForScope(`chrome-extension://${BRAND_EXTENSION_ID}/`)
          .catch(() => {});
        this.options.setBrandListener(session, false);
      } catch (cause) {
        console.warn("[extensions] brand extension failed:", cause);
      }
    } else if (!network && loaded) {
      this.options.setBrandListener(session, true);
      this.expectedUnloads.add(key(profileId, BRAND_EXTENSION_ID));
      session.extensions.removeExtension(BRAND_EXTENSION_ID);
      this.brandLoaded.delete(profileId);
    }
  }

  // ---- Loading -----------------------------------------------------------------------

  private async load(
    profileId: string,
    record: InstalledExtension,
  ): Promise<LoadedExtension | null> {
    const session = this.sessions.get(profileId);
    if (!session) return null;
    const id = key(profileId, record.id);
    this.loadErrors.delete(id);
    let extension: LoadedExtension;
    try {
      extension = new LoadedExtension(profileId, record);
      const loaded = await session.extensions.loadExtension(record.path, {
        allowFileAccess: false,
      });
      if (loaded.id !== record.id) {
        this.expectedUnloads.add(key(profileId, loaded.id));
        session.extensions.removeExtension(loaded.id);
        throw new Error("The folder now holds a different extension.");
      }
    } catch (cause) {
      const message = errorMessage(cause);
      this.loadErrors.set(id, message);
      console.warn(`[extensions] could not load ${record.id}:`, message);
      return null;
    }
    this.loaded.set(id, extension);
    this.initRuntime(extension);
    // Its rulesets apply as one of its contexts starts: start one now, so
    // a page loaded before the extension next wakes is filtered too.
    if (allRulesets(extension.manifest).length > 0) {
      const hasWorker = Boolean(
        (
          extension.manifest.background as
            | { service_worker?: unknown }
            | undefined
        )?.service_worker,
      );
      if (hasWorker) this.startWorker(profileId, record.id);
      else void this.bootHidden(extension);
    }
    return extension;
  }

  private menusFile(extension: LoadedExtension): string {
    return path.join(
      this.registry.dataDir(extension.profileId, extension.id),
      "context-menus.json",
    );
  }

  /** Keep an extension's menu items for its next run. */
  saveMenus(extension: LoadedExtension): void {
    const saved: SavedMenus = {
      version: extension.version,
      items: this.menus.snapshot(extension.profileId, extension.id),
    };
    const file = this.menusFile(extension);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    } catch (cause) {
      console.warn("[extensions] could not save menu items:", cause);
    }
  }

  /** Items the same version made on its last run; an update starts clean. */
  private restoreMenus(extension: LoadedExtension): void {
    try {
      const saved = savedMenusSchema.safeParse(
        JSON.parse(fs.readFileSync(this.menusFile(extension), "utf-8")),
      );
      if (saved.success && saved.data.version === extension.version)
        this.menus.restore(extension.profileId, extension.id, saved.data.items);
    } catch {
      // Nothing saved yet.
    }
  }

  private initRuntime(extension: LoadedExtension): void {
    const { profileId, id } = extension;
    this.restoreMenus(extension);
    const action = extension.action;
    this.actions.init(profileId, id, {
      title: action?.title ?? extension.name,
      icon: extension.actionIcon(32),
      badgeText: "",
      badgeBackground: null,
      badgeTextColor: null,
      popup: action?.popup ?? "",
      enabled: action?.key !== "page_action",
    });
  }

  /** Clear what an extension had while running (it unloaded or reloaded). */
  private forgetRuntime(extension: LoadedExtension): void {
    const { profileId, id } = extension;
    this.actions.forget(profileId, id);
    this.menus.forget(profileId, id);
    this.events.forget(profileId, id);
    this.debuggers.forgetClient(key(profileId, id));
    for (const [portId, entry] of [...this.nativePorts])
      if (
        entry.context.profileId === profileId &&
        entry.context.extensionId === id
      ) {
        entry.port.close();
        entry.release();
        this.nativePorts.delete(portId);
      }
    for (const [guestId, panel] of [...this.sidePanels])
      if (
        panel.extensionId === id &&
        this.tabs.tabProfile(guestId) === profileId
      )
        this.closeSidePanel(guestId);
    this.actionsChanged(profileId);
  }

  private unload(profileId: string, extensionId: string): void {
    const extension = this.loaded.get(key(profileId, extensionId));
    if (extension) this.forgetRuntime(extension);
    this.loaded.delete(key(profileId, extensionId));
    const session = this.sessions.get(profileId);
    if (session?.extensions.getExtension(extensionId)) {
      this.expectedUnloads.add(key(profileId, extensionId));
      session.extensions.removeExtension(extensionId);
    }
  }

  /** Open an extension page out of sight so it boots (rulesets). */
  private async bootHidden(extension: LoadedExtension): Promise<void> {
    const session = this.sessions.get(extension.profileId);
    if (!session) return;
    const window = new BrowserWindow({
      show: false,
      webPreferences: { session, sandbox: true, contextIsolation: true },
    });
    try {
      await window.loadURL(extension.url("manifest.json"));
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // Nothing to show; the attempt is the point.
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  /**
   * `runtime.onInstalled` and `runtime.onStartup`, which Electron never
   * fires and extensions set themselves up in (ChatGPT names its browser
   * instance there): install or update once per version, as the extension
   * first listens; startup once per run for one installed before it.
   */
  private lifecycleListened(extension: LoadedExtension, name: string): void {
    const { profileId, id } = extension;
    const record = this.registry.get(profileId, id);
    if (!record) return;
    if (name === "runtime.onInstalled") {
      if (record.installedEventFor === extension.version) return;
      const previous = record.installedEventFor;
      this.registry.update(profileId, id, (current) => ({
        ...current,
        installedEventFor: extension.version,
      }));
      this.installedThisRun.add(key(profileId, id));
      queueMicrotask(() =>
        this.events.dispatch(profileId, id, "runtime.onInstalled", [
          previous === null
            ? { reason: "install" }
            : { reason: "update", previousVersion: previous },
        ]),
      );
    } else if (name === "runtime.onStartup") {
      const id_ = key(profileId, id);
      if (this.startedThisRun.has(id_) || this.installedThisRun.has(id_))
        return;
      if (record.installedEventFor === null) return;
      this.startedThisRun.add(id_);
      queueMicrotask(() =>
        this.events.dispatch(profileId, id, "runtime.onStartup", []),
      );
    }
  }

  /** The rulesets an extension's version should run with now. */
  private wantedRulesets(extension: LoadedExtension): string[] | null {
    const all = allRulesets(extension.manifest);
    if (all.length === 0) return null;
    const wanted =
      extension.record.enabledRulesets ?? defaultRulesets(extension.manifest);
    return wanted.filter((id) => all.includes(id));
  }

  /** The extension changed (or Work restored) which rulesets are on. */
  noteEnabledRulesets(extension: LoadedExtension, ids: unknown): void {
    if (!Array.isArray(ids)) return;
    const all = allRulesets(extension.manifest);
    const enabled = ids.filter(
      (id): id is string => typeof id === "string" && all.includes(id),
    );
    const updated = this.registry.update(
      extension.profileId,
      extension.id,
      (record) => ({ ...record, enabledRulesets: enabled }),
    );
    if (updated) Object.assign(extension.record, updated);
  }

  // ---- Extension contexts: boot, calls, listeners ----------------------------------------

  private wireWorker(
    session: Session,
    profileId: string,
    worker: ServiceWorkerMain,
  ): void {
    if (this.workersWired.has(worker)) return;
    let extensionId: string;
    try {
      const scope = new URL(worker.scope);
      if (scope.protocol !== "chrome-extension:") return;
      extensionId = scope.host;
    } catch {
      return;
    }
    this.workersWired.add(worker);
    if (extensionId === BRAND_EXTENSION_ID) {
      // Work's own: it needs no APIs, but its boot must not wait.
      worker.ipc.on(EXTENSION_CHANNELS.boot, (event) => {
        event.returnValue = null;
      });
      return;
    }
    const contextOf = () => {
      const extension = this.extension(profileId, extensionId);
      if (!extension || this.sessions.get(profileId) !== session) return null;
      return {
        extension,
        context: this.events.registerWorker(profileId, extensionId, worker),
      };
    };
    worker.ipc.on(EXTENSION_CHANNELS.boot, (event) => {
      const resolved = contextOf();
      event.returnValue = resolved ? this.boot(resolved.extension) : null;
    });
    worker.ipc.handle(
      EXTENSION_CHANNELS.call,
      async (_event, method: unknown, args: unknown) => {
        const resolved = contextOf();
        if (!resolved) return { error: "This extension is not running." };
        const end = keepWorkerAlive(worker, 0);
        try {
          return await this.call(
            {
              ext: resolved.extension,
              context: resolved.context,
              tabId: null,
              windowId: null,
              gesture: this.recentGesture(
                resolved.extension.profileId,
                resolved.extension.id,
              ),
            },
            method,
            args,
          );
        } finally {
          end();
        }
      },
    );
    worker.ipc.on(EXTENSION_CHANNELS.listen, (_event, name, on) => {
      const resolved = contextOf();
      if (!resolved || typeof name !== "string") return;
      this.events.listen(resolved.context, name, on === true);
      if (on === true) this.lifecycleListened(resolved.extension, name);
    });
    this.wireNative<Electron.IpcMainServiceWorkerEvent>(
      (channel, listener) => worker.ipc.on(channel, listener),
      () => contextOf()?.context ?? null,
    );
  }

  /** The caller behind a frame's IPC, or null when it is not an extension. */
  private frameCaller(
    event: IpcMainEvent | IpcMainInvokeEvent,
    register: boolean,
  ): Caller | null {
    const frame = event.senderFrame;
    const contents = event.sender;
    if (!frame || contents.isDestroyed()) return null;
    let extensionId: string;
    try {
      const origin = new URL(frame.url);
      if (origin.protocol !== "chrome-extension:") return null;
      extensionId = origin.host;
    } catch {
      return null;
    }
    const profileId = this.profileOfSession(contents.session);
    if (!profileId) return null;
    const extension = this.extension(profileId, extensionId);
    if (!extension) return null;
    const contextKey = `frame:${contents.id}:${frame.processId}:${frame.routingId}`;
    const context = register
      ? this.events.registerFrame(profileId, extensionId, contents, frame)
      : (this.events.context(contextKey) ??
        this.events.registerFrame(profileId, extensionId, contents, frame));
    const tab = this.tabs.tab(contents.id);
    const window = this.tabs.windowOfContents(contents);
    return {
      ext: extension,
      context,
      tabId: tab?.id ?? null,
      windowId: window?.id ?? null,
      gesture: false,
    };
  }

  /** The person just acted on an extension (its worker may now ask). */
  noteGesture(profileId: string, extensionId: string): void {
    this.gestures.set(key(profileId, extensionId), Date.now());
  }

  private recentGesture(profileId: string, extensionId: string): boolean {
    const at = this.gestures.get(key(profileId, extensionId));
    return at !== undefined && Date.now() - at < GESTURE_MS;
  }

  private boot(extension: LoadedExtension): {
    granted: string[];
    rulesets: string[] | null;
  } {
    return {
      granted: extension.granted.permissions,
      rulesets: this.wantedRulesets(extension),
    };
  }

  private async call(
    caller: Caller,
    method: unknown,
    args: unknown,
  ): Promise<ExtensionCallAnswer> {
    if (typeof method !== "string") return { error: "Invalid call." };
    const handler = Object.hasOwn(this.api, method) ? this.api[method] : null;
    if (!handler) return { error: `${method} is not supported in Work.` };
    try {
      return { result: await handler(caller, Array.isArray(args) ? args : []) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private wireNative<E>(
    listen: (
      channel: string,
      listener: (event: E, ...args: unknown[]) => void,
    ) => void,
    contextOf: (event: E) => ExtensionContext | null,
  ): void {
    listen(EXTENSION_CHANNELS.nativeConnect, (event, portId, name) => {
      const context = contextOf(event);
      if (!context || typeof portId !== "string" || typeof name !== "string")
        return;
      this.connectNative(context, portId, name);
    });
    // Ports are named within the context that opened them, so no other
    // page or extension can reach (or squat on) one.
    listen(EXTENSION_CHANNELS.nativePost, (event, portId, message) => {
      const context = contextOf(event);
      if (!context || typeof portId !== "string") return;
      this.nativePorts.get(portKey(context, portId))?.port.post(message);
    });
    listen(EXTENSION_CHANNELS.nativeDisconnect, (event, portId) => {
      const context = contextOf(event);
      if (!context || typeof portId !== "string") return;
      const id = portKey(context, portId);
      const entry = this.nativePorts.get(id);
      if (!entry) return;
      entry.port.close();
      entry.release();
      this.nativePorts.delete(id);
    });
  }

  private connectNative(
    context: ExtensionContext,
    portId: string,
    name: string,
  ): void {
    const extension = this.extension(context.profileId, context.extensionId);
    const fail = (error: string) =>
      context.send("__native.disconnect", [portId, error]);
    if (!extension?.has("nativeMessaging")) {
      fail(NATIVE_ERRORS.forbidden);
      return;
    }
    const id = portKey(context, portId);
    if (this.nativePorts.has(id)) return;
    const host = resolveNativeHost(
      name,
      extension.id,
      nativeHostDirs(this.options.userData),
    );
    if ("error" in host) {
      fail(host.error);
      return;
    }
    const release = keepWorkerAlive(context.worker, 0);
    const port = new NativePort(host, extension.id, {
      message: (message) => context.send("__native.message", [portId, message]),
      close: (error) => {
        this.nativePorts.delete(id);
        release();
        if (context.alive()) fail(error ?? NATIVE_ERRORS.exited);
      },
    });
    this.nativePorts.set(id, { port, context, release });
  }

  /** A page or worker went away: its native hosts stop. */
  private closePortsOf(contextKey: string): void {
    for (const [id, entry] of [...this.nativePorts])
      if (entry.context.key === contextKey) {
        entry.port.close();
        entry.release();
        this.nativePorts.delete(id);
      }
  }

  /** One native message, answered once (`runtime.sendNativeMessage`). */
  sendNativeMessage(
    extension: LoadedExtension,
    name: string,
    message: unknown,
  ): Promise<unknown> {
    if (!extension.has("nativeMessaging"))
      return Promise.reject(new Error(NATIVE_ERRORS.forbidden));
    const host = resolveNativeHost(
      name,
      extension.id,
      nativeHostDirs(this.options.userData),
    );
    if ("error" in host) return Promise.reject(new Error(host.error));
    return new Promise((resolve, reject) => {
      let settled = false;
      const port = new NativePort(host, extension.id, {
        message: (reply) => {
          if (settled) return;
          settled = true;
          port.close();
          resolve(reply);
        },
        close: (error) => {
          if (settled) return;
          settled = true;
          reject(new Error(error ?? NATIVE_ERRORS.exited));
        },
      });
      port.post(message);
    });
  }

  /**
   * Chrome keeps a worker alive while it debugs a tab; one hold per
   * extension debugging anything, ended when it no longer is.
   */
  private refreshDebuggerHolds(): void {
    const debugging = new Set(this.debuggers.allClients());
    for (const [client, end] of [...this.debuggerHolds])
      if (!debugging.has(client)) {
        end();
        this.debuggerHolds.delete(client);
      }
    for (const client of debugging) {
      if (this.debuggerHolds.has(client)) continue;
      const [profileId, extensionId] = client.split(":");
      if (!profileId || !extensionId) continue;
      const worker = this.events
        .contextsOf(profileId, extensionId)
        .find((context) => context.kind === "worker")?.worker;
      if (worker) this.debuggerHolds.set(client, keepWorkerAlive(worker, 0));
    }
  }

  private cookieChanged(
    profileId: string,
    cookie: Electron.Cookie,
    cause: string,
    removed: boolean,
  ): void {
    const url = `${cookie.secure ? "https" : "http"}://${(cookie.domain ?? "").replace(/^\./, "")}${cookie.path ?? "/"}`;
    // Electron's causes, in Chrome's words.
    const chromeCause = cause.startsWith("inserted")
      ? "explicit"
      : cause.replaceAll("-", "_");
    for (const extension of this.loadedIn(profileId)) {
      if (!extension.has("cookies")) continue;
      if (!this.events.listening(profileId, extension.id, "cookies.onChanged"))
        continue;
      if (!matchesAny(extension.hostPatterns(), url)) continue;
      this.events.dispatch(profileId, extension.id, "cookies.onChanged", [
        {
          removed,
          cause: chromeCause,
          cookie: {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain ?? "",
            hostOnly: cookie.hostOnly ?? false,
            path: cookie.path ?? "/",
            secure: cookie.secure ?? false,
            httpOnly: cookie.httpOnly ?? false,
            sameSite: cookie.sameSite ?? "unspecified",
            session: cookie.session ?? true,
            ...(cookie.expirationDate
              ? { expirationDate: cookie.expirationDate }
              : {}),
            storeId: "0",
          },
        },
      ]);
    }
  }

  private startWorker(profileId: string, extensionId: string): void {
    const session = this.sessions.get(profileId);
    if (!session) return;
    void session.serviceWorkers
      .startWorkerForScope(`chrome-extension://${extensionId}/`)
      .catch(() => {});
  }

  // ---- IPC ------------------------------------------------------------------------------------

  private handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, input: unknown) => unknown,
  ): void {
    ipcMain.handle(channel, listener);
    this.disposers.push(() => ipcMain.removeHandler(channel));
  }

  private on(
    channel: string,
    listener: (event: IpcMainEvent, ...args: unknown[]) => void,
  ): void {
    ipcMain.on(channel, listener);
    this.disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  private registerIpc(): void {
    // Extension pages.
    this.on(EXTENSION_CHANNELS.boot, (event) => {
      const caller = this.frameCaller(event, true);
      event.returnValue = caller ? this.boot(caller.ext) : null;
    });
    ipcMain.handle(
      EXTENSION_CHANNELS.call,
      async (event, method: unknown, args: unknown, meta: unknown) => {
        const caller = this.frameCaller(event, false);
        if (!caller) return { error: "Not an extension page." };
        // The session preload reads the frame's user activation in its own
        // world, where the extension's code can't change it.
        const gesture =
          meta !== null &&
          typeof meta === "object" &&
          "gesture" in meta &&
          meta.gesture === true;
        return this.call({ ...caller, gesture }, method, args);
      },
    );
    this.disposers.push(() => ipcMain.removeHandler(EXTENSION_CHANNELS.call));
    this.on(EXTENSION_CHANNELS.listen, (event, name, on) => {
      const caller = this.frameCaller(event, false);
      if (!caller || typeof name !== "string") return;
      this.events.listen(caller.context, name, on === true);
      // Lifecycle events go to the background: a worker's, or an MV2
      // background page's (no worker), never a popup that listened first.
      if (on === true && !hasServiceWorker(caller.ext.manifest))
        this.lifecycleListened(caller.ext, name);
    });
    this.wireNative<IpcMainEvent>(
      (channel, listener) => this.on(channel, listener),
      (event) => this.frameCaller(event, false)?.context ?? null,
    );
    // A press in a page or side panel (the session preload) closes the
    // window's popup; the popup's own presses are its own.
    this.on(EXTENSION_CHANNELS.pagePressed, (event) => {
      if (event.sender.getType() === "webview")
        this.closePopupsBeside(event.sender);
    });

    // The Chrome Web Store page.
    ipcMain.handle(
      EXTENSION_CHANNELS.webstore,
      (event, method: unknown, args: unknown, meta: unknown) =>
        this.webStoreCall(
          event,
          method,
          Array.isArray(args) ? args : [],
          meta !== null &&
            typeof meta === "object" &&
            "gesture" in meta &&
            meta.gesture === true,
        ),
    );
    this.disposers.push(() =>
      ipcMain.removeHandler(EXTENSION_CHANNELS.webstore),
    );

    // The app's own windows.
    this.handle("catamorphic:extensions-state", (event) =>
      this.state(this.options.profileFor(event.sender)),
    );
    this.handle("catamorphic:extensions-set-enabled", async (event, input) => {
      const { id, enabled } = z
        .object({ id: extensionIdSchema, enabled: z.boolean() })
        .parse(input);
      await this.setEnabled(this.options.profileFor(event.sender), id, enabled);
    });
    this.handle("catamorphic:extensions-set-pinned", (event, input) => {
      const { id, pinned } = z
        .object({ id: extensionIdSchema, pinned: z.boolean() })
        .parse(input);
      this.setPinned(this.options.profileFor(event.sender), id, pinned);
    });
    this.handle("catamorphic:extensions-remove", async (event, input) => {
      const { id } = z.object({ id: extensionIdSchema }).parse(input);
      const profileId = this.options.profileFor(event.sender);
      const window = BrowserWindow.fromWebContents(event.sender);
      return this.confirmRemove(profileId, id, window);
    });
    this.handle("catamorphic:extensions-developer-mode", (event, input) => {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(input);
      const profileId = this.options.profileFor(event.sender);
      this.registry.setDeveloperMode(profileId, enabled);
      this.changed(profileId);
    });
    this.handle("catamorphic:extensions-load-unpacked", async (event) => {
      const profileId = this.options.profileFor(event.sender);
      if (!this.registry.developerMode(profileId))
        throw new Error("Turn on developer mode to load unpacked extensions.");
      const folder = await this.options.pickFolder(event.sender);
      if (!folder) return null;
      return this.loadUnpacked(profileId, folder);
    });
    this.handle("catamorphic:extensions-reload", async (event, input) => {
      const { id } = z.object({ id: extensionIdSchema }).parse(input);
      await this.reload(this.options.profileFor(event.sender), id);
    });
    this.handle("catamorphic:extensions-update-now", async (event) => {
      await this.checkUpdates(this.options.profileFor(event.sender), true);
    });
    this.handle(
      "catamorphic:extensions-review-update",
      async (event, input) => {
        const { id } = z.object({ id: extensionIdSchema }).parse(input);
        const profileId = this.options.profileFor(event.sender);
        await this.reviewUpdate(
          profileId,
          id,
          BrowserWindow.fromWebContents(event.sender),
        );
      },
    );
    this.handle("catamorphic:extensions-open-options", async (event, input) => {
      const { id } = z.object({ id: extensionIdSchema }).parse(input);
      const extension = this.extension(
        this.options.profileFor(event.sender),
        id,
      );
      const url = extension?.optionsUrl();
      if (!extension || !url) throw new Error("This extension has no options.");
      await this.openInTab(
        extension.profileId,
        url,
        true,
        BrowserWindow.fromWebContents(event.sender),
      );
    });
    this.handle("catamorphic:extensions-actions", (event, input) => {
      const { guestId } = z
        .object({ guestId: z.number().int().positive().nullable() })
        .parse(input);
      return this.actionStates(this.options.profileFor(event.sender), guestId);
    });
    this.handle("catamorphic:extensions-action-click", (event, input) => {
      const { id, guestId } = z
        .object({
          id: extensionIdSchema,
          guestId: z.number().int().positive().nullable(),
        })
        .parse(input);
      return this.actionClick(
        this.options.profileFor(event.sender),
        id,
        guestId,
      );
    });
    this.handle("catamorphic:extensions-action-menu", (event, input) => {
      const { id, guestId } = z
        .object({
          id: extensionIdSchema,
          guestId: z.number().int().positive().nullable(),
        })
        .parse(input);
      this.actionMenu(
        event.sender,
        this.options.profileFor(event.sender),
        id,
        guestId,
      );
    });
    this.handle("catamorphic:extensions-tabs-report", (event, input) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || this.options.isDock(window)) return;
      const report = extensionTabsReportSchema.parse(input);
      let reports = this.tabReports.get(window.id);
      if (!reports) {
        const windowId = window.id;
        const fresh = new Map<string, ExtensionTabsReport>();
        reports = fresh;
        this.tabReports.set(windowId, fresh);
        window.once("closed", () => this.tabReports.delete(windowId));
        // A reloaded window ("Reload App") runs no cleanup: its projects
        // report again from scratch.
        window.webContents.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument) fresh.clear();
        });
      }
      if (!report.visible && report.guestIds.length === 0)
        reports.delete(report.reporter);
      else reports.set(report.reporter, report);
      // The window's tabs: the project in front first, then the others'.
      const ordered = [...reports.values()].sort(
        (a, b) => Number(b.visible) - Number(a.visible),
      );
      this.tabs.report(window, this.options.profileFor(event.sender), {
        guestIds: ordered.flatMap((entry) => entry.guestIds),
        activeGuestId:
          ordered.find((entry) => entry.visible)?.activeGuestId ?? null,
      });
    });
    this.on("catamorphic:extensions-window-response", (event, input) => {
      const parsed = extensionWindowResponseSchema.safeParse(input);
      if (!parsed.success) return;
      const pending = this.windowRequests.get(parsed.data.id);
      if (!pending || pending.sender !== event.sender.id) return;
      this.windowRequests.delete(parsed.data.id);
      pending.resolve(parsed.data.result);
    });
    this.handle("catamorphic:extensions-view-attached", (event, input) => {
      const view = extensionViewSchema.parse(input);
      const guest = webContents.fromId(view.guestId);
      if (
        guest?.getType() !== "webview" ||
        guest.hostWebContents !== event.sender
      )
        return;
      const profileId = this.profileOfSession(guest.session);
      if (!profileId) return;
      try {
        if (new URL(guest.getURL()).host !== view.extensionId) return;
      } catch {
        return;
      }
      this.views.set(view.guestId, {
        kind: view.kind,
        extensionId: view.extensionId,
        tabGuestId: view.tabGuestId,
        profileId,
      });
      guest.once("destroyed", () => this.views.delete(view.guestId));
    });
    // A popup takes focus once it shows, as Chrome's does. Its element
    // can't take focus from the page's guest from inside the window.
    this.handle("catamorphic:extensions-focus-popup", (event, input) => {
      const { guestId } = z
        .object({ guestId: z.number().int().positive() })
        .parse(input);
      const guest = webContents.fromId(guestId);
      if (
        guest?.hostWebContents === event.sender &&
        this.views.get(guestId)?.kind === "popup"
      )
        guest.focus();
    });
    this.handle("catamorphic:extensions-side-panels", (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return [...this.sidePanels.values()].filter((panel) => {
        const tab = this.tabs.tab(panel.guestId);
        return tab && window && tab.windowId === window.id;
      });
    });
    this.handle("catamorphic:extensions-side-panel-close", (event, input) => {
      const { guestId } = z
        .object({ guestId: z.number().int().positive() })
        .parse(input);
      const guest = webContents.fromId(guestId);
      if (guest?.hostWebContents !== event.sender) return;
      this.closeSidePanel(guestId);
    });
    this.handle("catamorphic:extensions-debugging", (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      return this.tabs
        .tabsOf(this.options.profileFor(event.sender))
        .filter((tab) => window && tab.windowId === window.id)
        .map((tab) => this.debuggingOf(tab.id))
        .filter((entry): entry is ExtensionDebugging => entry !== null);
    });
    this.handle("catamorphic:extensions-debugger-stop", (event, input) => {
      const { guestId } = z
        .object({ guestId: z.number().int().positive() })
        .parse(input);
      const guest = webContents.fromId(guestId);
      if (guest?.hostWebContents !== event.sender) return;
      this.debuggers.end(guestId, "canceled_by_user");
    });
    this.handle("catamorphic:extensions-prompt-answer", (event, input) => {
      const answer = extensionPromptAnswerSchema.parse(input);
      const pending = this.prompts.get(answer.id);
      if (!pending || pending.window.webContents !== event.sender) return;
      this.settlePrompt(answer.id, answer.accept);
    });
    this.handle("catamorphic:extensions-prompts", (event) => {
      return [...this.prompts.values()]
        .filter((pending) => pending.window.webContents === event.sender)
        .map((pending) => pending.prompt);
    });
  }

  private registerAppEvents(): void {
    const created = (_event: Electron.Event, contents: WebContents) => {
      if (contents.getType() !== "webview") return;
      // Popups size to their page, as Chrome's do.
      contents.on("preferred-size-changed", (_sized, size) => {
        const host = contents.hostWebContents;
        if (host && !host.isDestroyed())
          host.send("catamorphic:extensions-popup-size", {
            guestId: contents.id,
            width: size.width,
            height: size.height,
          });
      });
    };
    app.on("web-contents-created", created);
    this.disposers.push(() => app.off("web-contents-created", created));
    const focus = (_event: Electron.Event, window: BrowserWindow) => {
      const record = this.tabs.window(window.id);
      if (record) this.tabs.focus(window, record.profileId);
    };
    const blur = (_event: Electron.Event, window: BrowserWindow) => {
      const record = this.tabs.window(window.id);
      if (record && !BrowserWindow.getFocusedWindow())
        this.tabs.blurAll(record.profileId);
    };
    app.on("browser-window-focus", focus);
    app.on("browser-window-blur", blur);
    this.disposers.push(() => {
      app.off("browser-window-focus", focus);
      app.off("browser-window-blur", blur);
    });
  }

  // ---- Windows: requests, prompts, notices ------------------------------------------------

  /** Ask a window to act for an extension; null when it could not. */
  requestWindow(
    window: BrowserWindow,
    request: ExtensionWindowRequest,
  ): Promise<{ guestId?: number } | null> {
    if (window.isDestroyed()) return Promise.resolve(null);
    const id = this.nextWindowRequest++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.windowRequests.delete(id)) resolve(null);
      }, WINDOW_REQUEST_TIMEOUT_MS);
      this.windowRequests.set(id, {
        sender: window.webContents.id,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      window.webContents.send("catamorphic:extensions-window-request", {
        id,
        request,
      });
    });
  }

  private sendToProfile(profileId: string, channel: string, payload: unknown) {
    for (const window of this.options.windowsFor(profileId))
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }

  changed(profileId: string): void {
    this.sendToProfile(profileId, "catamorphic:extensions-changed", {
      profileId,
    });
    this.actionsChanged(profileId);
  }

  /**
   * Toolbar state changed. An ad blocker sets its badge for each request it
   * blocks; windows hear once per frame, not once per change.
   */
  actionsChanged(profileId: string): void {
    if (this.actionsTimers.has(profileId)) return;
    this.actionsTimers.set(
      profileId,
      setTimeout(() => {
        this.actionsTimers.delete(profileId);
        this.sendToProfile(
          profileId,
          "catamorphic:extensions-actions-changed",
          { profileId },
        );
      }, ACTIONS_CHANGED_MS),
    );
  }

  /** A window to ask the person in: the given one, else the profile's last. */
  private promptWindow(
    profileId: string,
    preferred: BrowserWindow | null,
  ): BrowserWindow | null {
    if (
      preferred &&
      !preferred.isDestroyed() &&
      !this.options.isDock(preferred)
    )
      return preferred;
    const record = this.tabs.lastFocusedWindow(profileId);
    if (record && record.type === "normal") return record.window;
    return (
      this.options
        .windowsFor(profileId)
        .find((window) => !this.options.isDock(window)) ?? null
    );
  }

  ask(
    profileId: string,
    prompt: Omit<ExtensionPrompt, "id">,
    preferred: BrowserWindow | null,
  ): Promise<boolean> {
    const window = this.promptWindow(profileId, preferred);
    if (!window) return Promise.resolve(false);
    const full: ExtensionPrompt = { ...prompt, id: randomUUID() };
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.settlePrompt(full.id, false),
        PROMPT_LIFETIME_MS,
      );
      timer.unref?.();
      this.prompts.set(full.id, {
        prompt: full,
        profileId,
        window,
        resolve,
        timer,
      });
      window.once("closed", () => this.settlePrompt(full.id, false));
      if (window.isMinimized()) window.restore();
      window.show();
      window.webContents.send("catamorphic:extensions-prompt", full);
    });
  }

  private settlePrompt(id: string, accept: boolean): void {
    const pending = this.prompts.get(id);
    if (!pending) return;
    this.prompts.delete(id);
    clearTimeout(pending.timer);
    if (!pending.window.isDestroyed())
      pending.window.webContents.send(
        "catamorphic:extensions-prompt-withdrawn",
        { id },
      );
    pending.resolve(accept);
  }

  // ---- State for the app -----------------------------------------------------------------------

  private summary(
    profileId: string,
    record: InstalledExtension,
  ): ExtensionSummary | null {
    const loaded = this.extension(profileId, record.id);
    let manifest = loaded?.manifest;
    let name = loaded?.name;
    let description = loaded?.description;
    let icon = loaded?.icon(64) ?? null;
    if (!manifest) {
      try {
        manifest = readManifest(record.path);
        const localize = localizer(record.path, manifest, app.getLocale());
        name = localize(String(manifest.name));
        description = localize(String(manifest.description ?? ""));
        const icons = manifest.icons as Record<string, string> | undefined;
        const best = icons
          ? Object.entries(icons).sort(
              (a, b) => Number(b[0]) - Number(a[0]),
            )[0]?.[1]
          : undefined;
        icon = best
          ? fileDataUrl(extensionFile(record.path, record.id, best))
          : null;
      } catch {
        manifest = undefined;
      }
    }
    const error = this.loadErrors.get(key(profileId, record.id)) ?? null;
    const keybindings = this.options.keybindings(profileId);
    const assigned = this.assignedCommands(profileId, keybindings);
    const commands: ExtensionCommandSummary[] = (loaded?.commands ?? []).map(
      (command) => ({
        name: command.name,
        description: command.description,
        shortcut:
          assigned.find(
            (entry) =>
              entry.extensionId === record.id && entry.name === command.name,
          )?.binding ?? null,
      }),
    );
    return {
      id: record.id,
      name: name ?? record.id,
      version: manifest ? String(manifest.version) : record.version,
      description: description ?? "",
      iconUrl: icon,
      enabled: record.enabled && Boolean(loaded),
      disabledReason: !record.enabled
        ? (record.disabledReason ?? "user")
        : error
          ? "error"
          : null,
      error,
      source: record.source,
      path: record.source === "unpacked" ? record.path : null,
      manifestVersion: manifest?.manifest_version === 2 ? 2 : 3,
      pinned: record.pinned,
      hasAction: Boolean(loaded?.action),
      hasOptions: Boolean(loaded?.optionsUrl()),
      hasSidePanel: Boolean(loaded?.sidePanelPath),
      warnings: loaded
        ? loaded.warnings()
        : manifest
          ? permissionWarnings(manifest)
          : [],
      commands,
      pendingUpdate: record.pendingUpdate
        ? {
            version: record.pendingUpdate.version,
            warnings: record.pendingUpdate.warnings,
          }
        : null,
      installedAt: record.installedAt,
    };
  }

  state(profileId: string): ExtensionsState {
    const { commandLine } = app;
    return {
      profileId,
      developerMode: this.registry.developerMode(profileId),
      checking: this.checking.has(profileId),
      // Service worker preloads run only in Electron's sandboxed renderers.
      sandboxed:
        !commandLine.hasSwitch("no-sandbox") ||
        commandLine.hasSwitch("enable-sandbox"),
      extensions: this.registry
        .list(profileId)
        .map((record) => this.summary(profileId, record))
        .filter((entry): entry is ExtensionSummary => entry !== null),
    };
  }

  actionStates(
    profileId: string,
    guestId: number | null,
  ): ExtensionActionState[] {
    const tabId = guestId !== null && this.tabs.tab(guestId) ? guestId : null;
    return this.registry.list(profileId).flatMap((record) => {
      const extension = this.extension(profileId, record.id);
      if (!extension) return [];
      const values = this.actions.get(profileId, record.id, tabId);
      if (!values) return [];
      return [
        {
          extensionId: record.id,
          name: extension.name,
          title: values.title || extension.name,
          iconUrl: values.icon ?? extension.icon(32),
          badgeText: values.badgeText,
          badgeBackground: cssColor(
            values.badgeBackground ?? DEFAULT_BADGE_BACKGROUND,
          ),
          badgeTextColor: values.badgeTextColor
            ? cssColor(values.badgeTextColor)
            : null,
          enabled: values.enabled,
          hasPopup: Boolean(values.popup),
          pinned: record.pinned,
        },
      ];
    });
  }

  // ---- Toolbar action ---------------------------------------------------------------------------

  /** The person clicked an extension's button (or ran its command). */
  async actionClick(
    profileId: string,
    extensionId: string,
    guestId: number | null,
  ): Promise<ExtensionActionResult> {
    const extension = this.extension(profileId, extensionId);
    if (!extension) throw new Error("This extension is not running.");
    this.noteGesture(profileId, extensionId);
    const tab = guestId === null ? null : this.tabs.tab(guestId);
    if (tab) this.grantActiveTab(extension, tab.id);
    const values = this.actions.get(profileId, extensionId, tab?.id ?? null);
    if (values && !values.enabled) return { popupUrl: null };
    if (values?.popup) return { popupUrl: extension.url(values.popup) };
    if (extension.openPanelOnActionClick && tab) {
      if (this.sidePanels.get(tab.id)?.extensionId === extensionId)
        this.closeSidePanel(tab.id);
      else this.openSidePanel(extension, tab.id);
      return { popupUrl: null };
    }
    const namespace =
      extension.action?.key === "browser_action"
        ? "browserAction"
        : extension.action?.key === "page_action"
          ? "pageAction"
          : "action";
    this.events.dispatch(profileId, extensionId, `${namespace}.onClicked`, [
      tab ? this.tabObject(extension, tab) : undefined,
    ]);
    return { popupUrl: null };
  }

  grantActiveTab(extension: LoadedExtension, tabId: number): void {
    // A grant already held keeps its one watcher.
    if (!extension.has("activeTab") || extension.activeTabs.has(tabId)) return;
    extension.activeTabs.add(tabId);
    const tab = this.tabs.tab(tabId);
    if (!tab) return;
    // The grant lasts until the tab navigates elsewhere or closes.
    const origin = (() => {
      try {
        return new URL(tab.guest.getURL()).origin;
      } catch {
        return null;
      }
    })();
    const revoke = (_event: Electron.Event, url: string) => {
      try {
        if (new URL(url).origin === origin) return;
      } catch {
        // revoke
      }
      extension.activeTabs.delete(tabId);
      tab.guest.off("did-navigate", revoke);
    };
    tab.guest.on("did-navigate", revoke);
  }

  private actionMenu(
    sender: WebContents,
    profileId: string,
    extensionId: string,
    guestId: number | null,
  ): void {
    const extension = this.extension(profileId, extensionId);
    const record = this.registry.get(profileId, extensionId);
    if (!record) return;
    const window = BrowserWindow.fromWebContents(sender);
    const tab = guestId === null ? null : this.tabs.tab(guestId);
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: extension?.name ?? extensionId, enabled: false },
    ];
    if (extension && tab) {
      const items = this.menus.entries(profileId, extensionId, {
        contexts: new Set(["all", "action", "browser_action", "page_action"]),
        pageUrl: tab.guest.getURL(),
        frameUrl: null,
        frameId: 0,
        linkUrl: null,
        srcUrl: null,
        mediaType: null,
        selectionText: null,
        editable: false,
      });
      if (items.length > 0) {
        template.push({ type: "separator" });
        template.push(
          ...this.menuTemplate(extension, items, tab, {
            pageUrl: tab.guest.getURL(),
            frameId: 0,
            editable: false,
          }),
        );
      }
    }
    template.push({ type: "separator" });
    const optionsUrl = extension?.optionsUrl();
    if (optionsUrl)
      template.push({
        label: "Options",
        click: () => void this.openInTab(profileId, optionsUrl, true, window),
      });
    template.push({
      label: record.pinned ? "Unpin" : "Pin to toolbar",
      click: () => this.setPinned(profileId, extensionId, !record.pinned),
    });
    template.push({
      label: "Remove from Work…",
      click: () => void this.confirmRemove(profileId, extensionId, window),
    });
    template.push({
      label: "Manage extension",
      click: () => {
        if (window)
          void this.requestWindow(window, { kind: "open-extensions" });
      },
    });
    Menu.buildFromTemplate(template).popup(window ? { window } : {});
  }

  setPinned(profileId: string, extensionId: string, pinned: boolean): void {
    const updated = this.registry.update(profileId, extensionId, (record) => ({
      ...record,
      pinned,
    }));
    if (!updated) return;
    const extension = this.extension(profileId, extensionId);
    if (extension) {
      Object.assign(extension.record, updated);
      const namespace =
        extension.action?.key === "browser_action" ? "browserAction" : "action";
      this.events.dispatch(
        profileId,
        extensionId,
        `${namespace}.onUserSettingsChanged`,
        [{ isOnToolbar: pinned }],
      );
    }
    this.changed(profileId);
  }

  async openPopup(
    extension: LoadedExtension,
    windowId: number | null,
  ): Promise<void> {
    const window =
      windowId === null
        ? this.tabs.lastFocusedWindow(extension.profileId)
        : this.tabs.window(windowId);
    if (window?.type !== "normal")
      throw new Error("Could not find an active browser window.");
    const tab = this.tabs.activeTab(window.id);
    const values = this.actions.get(
      extension.profileId,
      extension.id,
      tab?.id ?? null,
    );
    if (!values?.popup)
      throw new Error("Extension does not have a popup on the active tab.");
    if (tab) this.grantActiveTab(extension, tab.id);
    const result = await this.requestWindow(window.window, {
      kind: "open-popup",
      extensionId: extension.id,
      guestId: tab?.id ?? null,
      url: extension.url(values.popup),
    });
    if (!result) throw new Error("Could not open the popup.");
  }

  // ---- Side panel -------------------------------------------------------------------------------

  openSidePanel(extension: LoadedExtension, tabId: number): void {
    const tab = this.tabs.tab(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    const { path: panelPath, enabled } = extension.panelFor(tabId);
    if (!panelPath || !enabled)
      throw new Error("No active side panel for this tab.");
    const previous = this.sidePanels.get(tabId);
    const panel: ExtensionSidePanel = {
      guestId: tabId,
      extensionId: extension.id,
      name: extension.name,
      iconUrl: extension.icon(32),
      url: extension.url(panelPath),
    };
    if (
      previous?.extensionId === panel.extensionId &&
      previous.url === panel.url
    )
      return;
    if (previous) this.closeSidePanel(tabId);
    this.sidePanels.set(tabId, panel);
    if (!this.panelTabs.has(tab.guest)) {
      this.panelTabs.add(tab.guest);
      tab.guest.once("destroyed", () => this.sidePanels.delete(tabId));
    }
    this.sendSidePanel(tab, panel);
    this.events.dispatch(
      extension.profileId,
      extension.id,
      "sidePanel.onOpened",
      [{ windowId: tab.windowId, tabId, path: panelPath }],
    );
  }

  closeSidePanel(tabId: number, extensionId?: string): void {
    const panel = this.sidePanels.get(tabId);
    if (!panel || (extensionId && panel.extensionId !== extensionId)) return;
    this.sidePanels.delete(tabId);
    const tab = this.tabs.tab(tabId);
    if (tab) {
      this.sendSidePanel(tab, null);
      const profileId = this.tabs.tabProfile(tabId);
      if (profileId)
        this.events.dispatch(
          profileId,
          panel.extensionId,
          "sidePanel.onClosed",
          [
            {
              windowId: tab.windowId,
              tabId,
              path: new URL(panel.url).pathname.slice(1),
            },
          ],
        );
    }
  }

  sidePanelOf(tabId: number): ExtensionSidePanel | null {
    return this.sidePanels.get(tabId) ?? null;
  }

  private sendSidePanel(
    tab: TabRecord,
    panel: ExtensionSidePanel | null,
  ): void {
    const host = tab.guest.hostWebContents;
    if (host && !host.isDestroyed())
      host.send("catamorphic:extensions-side-panel", {
        guestId: tab.id,
        panel,
      });
  }

  // ---- Debugger notice ------------------------------------------------------------------------

  private debuggingOf(tabId: number): ExtensionDebugging | null {
    const clients = this.debuggers.clients(tabId);
    if (clients.length === 0) return null;
    return {
      guestId: tabId,
      extensions: clients.flatMap((client) => {
        const [profileId, extensionId] = client.split(":");
        const extension =
          profileId && extensionId
            ? this.extension(profileId, extensionId)
            : null;
        return extension ? [{ id: extension.id, name: extension.name }] : [];
      }),
    };
  }

  private debuggingChanged(tabId: number): void {
    const tab = this.tabs.tab(tabId);
    const guest = tab?.guest ?? webContents.fromId(tabId);
    const host = guest && !guest.isDestroyed() ? guest.hostWebContents : null;
    this.refreshDebuggerHolds();
    if (host && !host.isDestroyed())
      host.send("catamorphic:extensions-debugging-changed", {
        guestId: tabId,
        debugging: this.debuggingOf(tabId),
      });
  }

  /** An extension controls this tab: it stays awake (ADR 0194). */
  keepsAwake(guestId: number): boolean {
    return (
      this.debuggers.clients(guestId).length > 0 || this.sidePanels.has(guestId)
    );
  }

  // ---- Tabs as Chrome describes them --------------------------------------------------------

  tabObject(
    extension: LoadedExtension,
    tab: TabRecord,
  ): Record<string, unknown> {
    const { guest } = tab;
    const url = guest.getURL();
    const visible = extension.seesTab(tab.id, url);
    return {
      id: tab.id,
      index: tab.index,
      windowId: tab.windowId,
      groupId: tab.groupId,
      ...(tab.openerTabId !== null ? { openerTabId: tab.openerTabId } : {}),
      highlighted: tab.active,
      active: tab.active,
      selected: tab.active,
      pinned: false,
      audible: guest.isCurrentlyAudible(),
      discarded: false,
      autoDiscardable: true,
      frozen: false,
      mutedInfo: { muted: guest.isAudioMuted() },
      status: tab.status,
      incognito: false,
      lastAccessed: tab.lastAccessed,
      splitViewId: -1,
      ...(visible
        ? {
            url,
            title: guest.getTitle() || url,
            ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
          }
        : {}),
    };
  }

  windowObject(
    extension: LoadedExtension,
    record: WindowRecord,
    populate: boolean,
  ): Record<string, unknown> {
    const { window } = record;
    const bounds = window.getBounds();
    const state = window.isFullScreen()
      ? "fullscreen"
      : window.isMinimized()
        ? "minimized"
        : window.isMaximized()
          ? "maximized"
          : "normal";
    return {
      id: record.id,
      focused: window.isFocused(),
      top: bounds.y,
      left: bounds.x,
      width: bounds.width,
      height: bounds.height,
      incognito: false,
      type: record.type,
      state,
      alwaysOnTop: window.isAlwaysOnTop(),
      ...(populate
        ? {
            tabs: this.tabs
              .tabsInWindow(record.id)
              .map((tab) => this.tabObject(extension, tab)),
          }
        : {}),
    };
  }

  /** `windowId` as an extension passes it: -2 is the caller's window. */
  resolveWindow(caller: Caller, windowId: unknown): WindowRecord {
    const profileId = caller.ext.profileId;
    if (windowId === undefined || windowId === null || windowId === -2) {
      const record =
        (caller.windowId !== null ? this.tabs.window(caller.windowId) : null) ??
        this.tabs.lastFocusedWindow(profileId);
      if (!record) throw new Error("No current window.");
      return record;
    }
    const record =
      typeof windowId === "number" ? this.tabs.window(windowId) : null;
    if (!record || record.profileId !== profileId)
      throw new Error(`No window with id: ${String(windowId)}.`);
    return record;
  }

  /** A tab of the caller's profile, or the error Chrome gives. */
  tabOf(caller: Caller, tabId: unknown): TabRecord {
    const tab = typeof tabId === "number" ? this.tabOrPage(tabId) : null;
    if (!tab || this.tabs.tabProfile(tab.id) !== caller.ext.profileId)
      throw new Error(`No tab with id: ${String(tabId)}.`);
    return tab;
  }

  /** A known tab, or a web page guest its window has not reported yet. */
  private tabOrPage(tabId: number): TabRecord | null {
    const known = this.tabs.tab(tabId);
    if (known) return known;
    const guest = webContents.fromId(tabId);
    if (!guest || guest.isDestroyed() || !scriptableUrl(guest.getURL()))
      return null;
    const profileId = this.profileOfSession(guest.session);
    return profileId ? this.tabs.adopt(guest, profileId) : null;
  }

  /** The caller's tab when it omits one (Chrome's "active tab of current window"). */
  defaultTab(caller: Caller): TabRecord | null {
    if (caller.tabId !== null) return this.tabs.tab(caller.tabId);
    const window =
      (caller.windowId !== null ? this.tabs.window(caller.windowId) : null) ??
      this.tabs.lastFocusedWindow(caller.ext.profileId);
    return window ? this.tabs.activeTab(window.id) : null;
  }

  async openInTab(
    profileId: string,
    url: string,
    active: boolean,
    preferred: BrowserWindow | null,
  ): Promise<TabRecord | null> {
    const window =
      preferred && !preferred.isDestroyed() && !this.options.isDock(preferred)
        ? preferred
        : (this.tabs.lastFocusedWindow(profileId)?.window ?? null);
    if (!window) throw new Error("No browser window is open.");
    if (active) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    const result = await this.requestWindow(window, {
      kind: "create-tab",
      url,
      active,
    });
    const guestId = result?.guestId;
    if (!guestId) throw new Error("The tab could not be opened.");
    // The window reports its new tab right after creating it.
    for (let attempt = 0; attempt < 40; attempt++) {
      const tab = this.tabs.tab(guestId);
      if (tab) return tab;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.tabs.tab(guestId);
  }

  private onTabEvent(profileId: string, event: TabEvent): void {
    const each = (
      name: string,
      args: (extension: LoadedExtension) => unknown[] | null,
    ) => {
      for (const extension of this.loadedIn(profileId)) {
        if (!this.events.listening(profileId, extension.id, name)) continue;
        const payload = args(extension);
        if (payload)
          this.events.dispatch(profileId, extension.id, name, payload);
      }
    };
    switch (event.kind) {
      case "created": {
        const tab = this.tabs.tab(event.tabId);
        if (!tab) return;
        this.navigation.watch(
          profileId,
          tab.guest,
          () => this.tabs.tab(tab.id) !== null,
        );
        each("tabs.onCreated", (extension) => [this.tabObject(extension, tab)]);
        return;
      }
      case "removed":
        this.actions.clearTab(event.tabId);
        for (const extension of this.loadedIn(profileId)) {
          extension.activeTabs.delete(event.tabId);
          extension.panelOptions.delete(event.tabId);
        }
        each("tabs.onRemoved", () => [
          event.tabId,
          { windowId: event.windowId, isWindowClosing: event.closing },
        ]);
        return;
      case "activated":
        each("tabs.onActivated", () => [
          { tabId: event.tabId, windowId: event.windowId },
        ]);
        each("tabs.onHighlighted", () => [
          { tabIds: [event.tabId], windowId: event.windowId },
        ]);
        return;
      case "moved":
        each("tabs.onMoved", () => [
          event.tabId,
          {
            windowId: event.windowId,
            fromIndex: event.from,
            toIndex: event.to,
          },
        ]);
        return;
      case "updated": {
        const tab = this.tabs.tab(event.tabId);
        if (!tab) return;
        each("tabs.onUpdated", (extension) => {
          const full = this.tabObject(extension, tab);
          const change: Record<string, unknown> = {};
          for (const [name, value] of Object.entries(event.change)) {
            // Address, title and icon need access to the tab's site.
            if (
              (name === "url" || name === "title" || name === "favIconUrl") &&
              !(name in full)
            )
              continue;
            change[name] = value;
          }
          return Object.keys(change).length > 0 ? [tab.id, change, full] : null;
        });
        return;
      }
      case "window-created": {
        const record = this.tabs.window(event.windowId);
        if (record)
          each("windows.onCreated", (extension) => [
            this.windowObject(extension, record, false),
          ]);
        return;
      }
      case "window-removed":
        each("windows.onRemoved", () => [event.windowId]);
        return;
      case "window-focus":
        each("windows.onFocusChanged", () => [event.windowId]);
        return;
      case "group-created":
      case "group-updated": {
        const group = this.tabs.group(event.groupId);
        if (group)
          each(
            event.kind === "group-created"
              ? "tabGroups.onCreated"
              : "tabGroups.onUpdated",
            (extension) =>
              extension.has("tabGroups") ? [groupObject(group)] : null,
          );
        return;
      }
      case "group-removed":
        each("tabGroups.onRemoved", (extension) =>
          extension.has("tabGroups") ? [groupObject(event.group)] : null,
        );
        return;
    }
  }

  // ---- Page context menu ----------------------------------------------------------------------

  /** Extension entries for a right-click in a tab. */
  pageMenu(
    guest: WebContents,
    params: Electron.ContextMenuParams,
  ): Electron.MenuItemConstructorOptions[] {
    const tab = this.tabs.tab(guest.id);
    const profileId = this.profileOfSession(guest.session);
    if (!profileId || !tab) return [];
    const frame = params.frame;
    const target = pageMenuTarget({
      pageURL: params.pageURL,
      frameURL: params.frameURL,
      linkURL: params.linkURL,
      srcURL: params.srcURL,
      mediaType: params.mediaType,
      selectionText: params.selectionText,
      isEditable: params.isEditable,
      frameId: frame && frame !== guest.mainFrame ? frame.frameTreeNodeId : 0,
    });
    const template: Electron.MenuItemConstructorOptions[] = [];
    for (const extension of this.loadedIn(profileId)) {
      if (!extension.has("contextMenus")) continue;
      const entries = this.menus.entries(profileId, extension.id, target);
      if (entries.length === 0) continue;
      const items = this.menuTemplate(extension, entries, tab, target);
      // Chrome groups an extension's several items under its name.
      if (entries.length > 1)
        template.push({ label: extension.name, submenu: items });
      else template.push(...items);
    }
    return template;
  }

  private menuTemplate(
    extension: LoadedExtension,
    entries: MenuEntry[],
    tab: TabRecord,
    target: {
      pageUrl: string;
      frameUrl?: string | null;
      frameId: number;
      linkUrl?: string | null;
      srcUrl?: string | null;
      mediaType?: string | null;
      selectionText?: string | null;
      editable: boolean;
    },
  ): Electron.MenuItemConstructorOptions[] {
    return entries.map((entry): Electron.MenuItemConstructorOptions => {
      const { item } = entry;
      if (item.type === "separator") return { type: "separator" };
      if (entry.children.length > 0)
        return {
          label: entry.label,
          enabled: item.enabled,
          submenu: this.menuTemplate(extension, entry.children, tab, target),
        };
      return {
        label: entry.label,
        enabled: item.enabled,
        type:
          item.type === "checkbox"
            ? "checkbox"
            : item.type === "radio"
              ? "radio"
              : "normal",
        checked: item.checked,
        click: () => {
          const wasChecked = this.menus.click(
            extension.profileId,
            extension.id,
            item.id,
          );
          this.noteGesture(extension.profileId, extension.id);
          this.grantActiveTab(extension, tab.id);
          const info: Record<string, unknown> = {
            menuItemId: item.rawId,
            ...(item.rawParentId !== null
              ? { parentMenuItemId: item.rawParentId }
              : {}),
            pageUrl: target.pageUrl,
            frameId: target.frameId,
            editable: target.editable,
            ...(target.frameUrl ? { frameUrl: target.frameUrl } : {}),
            ...(target.linkUrl ? { linkUrl: target.linkUrl } : {}),
            ...(target.srcUrl ? { srcUrl: target.srcUrl } : {}),
            ...(target.mediaType ? { mediaType: target.mediaType } : {}),
            ...(target.selectionText
              ? { selectionText: target.selectionText }
              : {}),
            ...(item.type === "checkbox" || item.type === "radio"
              ? {
                  wasChecked,
                  checked:
                    this.menus.item(extension.profileId, extension.id, item.id)
                      ?.checked ?? false,
                }
              : {}),
          };
          this.events.dispatch(
            extension.profileId,
            extension.id,
            "contextMenus.onClicked",
            [info, this.tabObject(extension, tab)],
          );
        },
      };
    });
  }

  // ---- Keyboard commands ----------------------------------------------------------------------------

  private assignedCommands(
    profileId: string,
    keybindings: Keybindings,
  ): { extensionId: string; name: string; binding: string }[] {
    const taken = Object.values(keybindings).filter(
      (binding): binding is string =>
        typeof binding === "string" && binding !== "",
    );
    const assigned: { extensionId: string; name: string; binding: string }[] =
      [];
    const mac = process.platform === "darwin";
    const conflicts = (binding: string, other: string) => {
      const parts = binding.split("+");
      const keyName = parts.pop() ?? "";
      const event = {
        key: keyName === "Space" ? " " : keyName,
        metaKey: parts.includes("Cmd") && mac,
        ctrlKey: parts.includes("Ctrl") || (parts.includes("Cmd") && !mac),
        altKey: parts.includes("Alt"),
        shiftKey: parts.includes("Shift"),
      };
      return matchesShortcut({ event, binding: other, mac });
    };
    for (const extension of this.loadedIn(profileId)) {
      let count = 0;
      for (const command of extension.commands) {
        if (!command.binding || count >= 4) continue;
        const binding = command.binding;
        if (taken.some((other) => conflicts(binding, other))) continue;
        if (assigned.some((entry) => conflicts(binding, entry.binding)))
          continue;
        assigned.push({
          extensionId: extension.id,
          name: command.name,
          binding,
        });
        count += 1;
      }
    }
    return assigned;
  }

  /** A key pressed in a tab: true when an extension command took it. */
  handleKey(guest: WebContents, input: Electron.Input): boolean {
    if (input.type !== "keyDown") return false;
    const profileId = this.profileOfSession(guest.session);
    const tab = this.tabs.tab(guest.id);
    if (!profileId || !tab) return false;
    if (input.key === "Escape" && this.closePopupsBeside(guest)) return true;
    if (!input.meta && !input.control && !input.alt) return false;
    const event = {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
    };
    const mac = process.platform === "darwin";
    const hit = this.assignedCommands(
      profileId,
      this.options.keybindings(profileId),
    ).find((entry) => matchesShortcut({ event, binding: entry.binding, mac }));
    if (!hit) return false;
    void this.runCommand(profileId, hit.extensionId, hit.name, tab);
    return true;
  }

  /**
   * Escape or a press reaching another page while its window shows a
   * popup closes the popup, as in Chrome. A page can take focus back from
   * a popup while it loads (all of a window's guests share its focus,
   * where Chrome's popup is a window of its own).
   */
  closePopupsBeside(guest: WebContents): boolean {
    if (this.views.get(guest.id)?.kind === "popup") return false;
    const host = guest.hostWebContents;
    if (!host || host.isDestroyed()) return false;
    // The window closes its popup, loaded or still loading.
    host.send("catamorphic:extensions-close-popups");
    for (const [id, view] of this.views) {
      if (view.kind !== "popup") continue;
      if (webContents.fromId(id)?.hostWebContents === host) return true;
    }
    return false;
  }

  private async runCommand(
    profileId: string,
    extensionId: string,
    name: string,
    tab: TabRecord,
  ): Promise<void> {
    const extension = this.extension(profileId, extensionId);
    if (!extension) return;
    this.grantActiveTab(extension, tab.id);
    if (isActionCommand(name)) {
      const result = await this.actionClick(profileId, extensionId, tab.id);
      if (result.popupUrl) {
        const window = this.tabs.window(tab.windowId);
        if (window)
          void this.requestWindow(window.window, {
            kind: "open-popup",
            extensionId,
            guestId: tab.id,
            url: result.popupUrl,
          });
      }
      return;
    }
    this.noteGesture(profileId, extensionId);
    this.events.dispatch(profileId, extensionId, "commands.onCommand", [
      name,
      this.tabObject(extension, tab),
    ]);
  }

  commandsOf(extension: LoadedExtension): Record<string, unknown>[] {
    const assigned = this.assignedCommands(
      extension.profileId,
      this.options.keybindings(extension.profileId),
    );
    return extension.commands.map((command) => ({
      name: command.name,
      description: command.description,
      shortcut:
        assigned.find(
          (entry) =>
            entry.extensionId === extension.id && entry.name === command.name,
        )?.binding ?? "",
    }));
  }

  // ---- Permissions -------------------------------------------------------------------------------

  async requestPermissions(
    caller: Caller,
    requested: { permissions: string[]; origins: string[] },
  ): Promise<boolean> {
    const extension = caller.ext;
    for (const permission of requested.permissions)
      if (
        !extension.optional.permissions.includes(permission) &&
        !extension.required.permissions.includes(permission)
      )
        throw new Error(
          `Only permissions specified in the manifest may be requested.`,
        );
    for (const origin of requested.origins)
      if (
        ![...extension.optional.origins, ...extension.required.origins].some(
          (pattern) =>
            coversAllHosts(pattern) || patternCovers(pattern, origin),
        )
      )
        throw new Error(
          `Only permissions specified in the manifest may be requested.`,
        );
    const missing = {
      permissions: requested.permissions.filter(
        (permission) => !extension.has(permission),
      ),
      origins: requested.origins.filter(
        (origin) => !extension.holdsOrigin(origin),
      ),
    };
    if (missing.permissions.length === 0 && missing.origins.length === 0)
      return true;
    // Only what it doesn't hold yet, and only what carries a warning,
    // needs the person.
    const warnings = accessWarnings(missing);
    if (warnings.length > 0) {
      const preferred =
        caller.windowId !== null
          ? (this.tabs.window(caller.windowId)?.window ?? null)
          : null;
      const accepted = await this.ask(
        extension.profileId,
        {
          kind: "permissions",
          extensionId: extension.id,
          name: extension.name,
          iconUrl: extension.icon(64),
          warnings,
        },
        preferred,
      );
      if (!accepted) return false;
    }
    this.grant(extension, missing);
    return true;
  }

  private grant(
    extension: LoadedExtension,
    added: { permissions: string[]; origins: string[] },
  ): void {
    const granted = {
      permissions: [
        ...new Set([...extension.granted.permissions, ...added.permissions]),
      ],
      origins: [...new Set([...extension.granted.origins, ...added.origins])],
    };
    extension.granted = granted;
    this.registry.update(extension.profileId, extension.id, (record) => ({
      ...record,
      granted,
    }));
    this.events.broadcast(
      extension.profileId,
      extension.id,
      "__permissions.granted",
      [added.permissions],
    );
    this.events.dispatch(
      extension.profileId,
      extension.id,
      "permissions.onAdded",
      [added],
    );
    void this.syncBrand(extension.profileId);
    this.changed(extension.profileId);
  }

  removePermissions(
    extension: LoadedExtension,
    removed: { permissions: string[]; origins: string[] },
  ): boolean {
    for (const permission of removed.permissions)
      if (extension.required.permissions.includes(permission))
        throw new Error("You cannot remove required permissions.");
    for (const origin of removed.origins)
      if (extension.required.origins.includes(origin))
        throw new Error("You cannot remove required permissions.");
    const granted = {
      permissions: extension.granted.permissions.filter(
        (permission) => !removed.permissions.includes(permission),
      ),
      origins: extension.granted.origins.filter(
        (origin) => !removed.origins.includes(origin),
      ),
    };
    extension.granted = granted;
    this.registry.update(extension.profileId, extension.id, (record) => ({
      ...record,
      granted,
    }));
    this.events.dispatch(
      extension.profileId,
      extension.id,
      "permissions.onRemoved",
      [removed],
    );
    this.changed(extension.profileId);
    return true;
  }

  // ---- Runtime contexts --------------------------------------------------------------------------

  contextsOf(extension: LoadedExtension): Record<string, unknown>[] {
    const contexts: Record<string, unknown>[] = [];
    for (const context of this.events.contextsOf(
      extension.profileId,
      extension.id,
    )) {
      if (context.kind === "worker" && context.worker) {
        contexts.push({
          contextType: "BACKGROUND",
          contextId: context.key,
          tabId: -1,
          windowId: -1,
          frameId: -1,
          documentId: undefined,
          documentUrl: context.worker.scriptURL,
          documentOrigin: `chrome-extension://${extension.id}`,
          incognito: false,
        });
        continue;
      }
      const contents = context.contents;
      const frame = context.frame;
      if (!contents || !frame) continue;
      const view = this.views.get(contents.id);
      const tab = this.tabs.tab(contents.id);
      const window = this.tabs.windowOfContents(contents);
      const contextType = view
        ? view.kind === "popup"
          ? "POPUP"
          : "SIDE_PANEL"
        : tab
          ? "TAB"
          : contents.getType() === "offscreen" ||
              contents.getType() === "backgroundPage"
            ? "OFFSCREEN_DOCUMENT"
            : "TAB";
      contexts.push({
        contextType,
        contextId: context.key,
        tabId: tab?.id ?? view?.tabGuestId ?? -1,
        windowId: window?.id ?? -1,
        frameId: frame === contents.mainFrame ? 0 : frame.frameTreeNodeId,
        documentUrl: frame.url,
        documentOrigin: frame.origin,
        incognito: false,
      });
    }
    return contexts;
  }

  // ---- Install, update, remove --------------------------------------------------------------------

  private async webStoreCall(
    event: IpcMainInvokeEvent,
    method: unknown,
    args: unknown[],
    gesture: boolean,
  ): Promise<unknown> {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || frame.origin !== webStoreOrigin())
      throw new Error("Not the Chrome Web Store.");
    if (
      event.sender.getType() !== "webview" ||
      typeof method !== "string" ||
      !(WEBSTORE_METHODS as readonly string[]).includes(method)
    )
      throw new Error("Not supported.");
    const profileId = this.profileOfSession(event.sender.session);
    if (!profileId) throw new Error("Not a browsing session.");
    const host = event.sender.hostWebContents;
    const window = host ? BrowserWindow.fromWebContents(host) : null;
    // Installing, turning on or off and removing follow a click, as in
    // Chrome: a script on the page can't start them by itself.
    if (
      !gesture &&
      (method === "beginInstallWithManifest3" ||
        method === "management.setEnabled" ||
        method === "management.uninstall")
    )
      return {
        result: "user_gesture_required",
        error: "This function must be called during a user gesture",
      };
    // One envelope for the page: a result, and the error Chrome would put
    // in runtime.lastError.
    const value = await this.webStoreMethod(
      profileId,
      window,
      method as WebStoreMethod,
      args,
    );
    const envelope =
      value !== null &&
      typeof value === "object" &&
      Object.keys(value).every((key) => key === "result" || key === "error");
    return envelope ? value : { result: value };
  }

  private async webStoreMethod(
    profileId: string,
    window: BrowserWindow | null,
    method: WebStoreMethod,
    args: unknown[],
  ): Promise<unknown> {
    const idOf = (value: unknown) => extensionIdSchema.parse(value);
    switch (method) {
      case "beginInstallWithManifest3": {
        const details = z
          .object({
            id: z.string(),
            manifest: z.string().max(1024 * 1024),
            iconUrl: z.string().optional(),
            localizedName: z.string().optional(),
          })
          .safeParse(args[0]);
        if (
          !details.success ||
          !extensionIdSchema.safeParse(details.data.id).success
        )
          return { result: "invalid_id", error: "Invalid id" };
        const { id } = details.data;
        if (this.registry.get(profileId, id))
          return {
            result: "already_installed",
            error: "This extension is already installed.",
          };
        let manifest: ReturnType<typeof parseManifest>;
        try {
          manifest = parseManifest(details.data.manifest);
        } catch (cause) {
          return { result: "manifest_error", error: errorMessage(cause) };
        }
        const warnings = permissionWarnings(manifest);
        const name =
          details.data.localizedName ||
          (typeof manifest.name === "string" &&
          !manifest.name.startsWith("__MSG_")
            ? manifest.name
            : id);
        const accepted = await this.ask(
          profileId,
          {
            kind: "install",
            extensionId: id,
            name,
            iconUrl: await this.storeIcon(details.data.iconUrl),
            warnings,
          },
          window,
        );
        if (!accepted)
          return { result: "user_cancelled", error: "User cancelled install" };
        this.approvals.set(key(profileId, id), {
          profileId,
          access: accessOf(manifest),
          at: Date.now(),
        });
        return { result: "success" };
      }
      case "completeInstall": {
        const id = idOf(args[0]);
        const approval = this.approvals.get(key(profileId, id));
        this.approvals.delete(key(profileId, id));
        if (!approval || Date.now() - approval.at > PROMPT_LIFETIME_MS)
          return {
            result: "install_error",
            error: "Install was not approved.",
          };
        try {
          await this.installFromStore(profileId, id, approval.access, window);
          return { result: "success" };
        } catch (cause) {
          return { result: "install_error", error: errorMessage(cause) };
        }
      }
      case "install":
        return {
          result: "unsupported_extension_type",
          error: "Use the Add button.",
        };
      case "getExtensionStatus": {
        const id = idOf(args[0]);
        const record = this.registry.get(profileId, id);
        if (!record) return "installable";
        return record.enabled ? "enabled" : "disabled";
      }
      case "getFullChromeVersion":
        return { version_number: process.versions.chrome };
      case "getMV2DeprecationStatus":
        return "inactive";
      case "getBrowserLogin":
        return { login: "" };
      case "getStoreLogin":
        return "";
      case "setStoreLogin":
        return undefined;
      case "isInIncognitoMode":
      case "getIsLauncherEnabled":
      case "isPendingCustodianApproval":
        return false;
      // Only Chrome Enterprise Core answers anything here.
      case "shouldShowEnterprisePromotionBanner":
        return "";
      case "enableAppLauncher":
        return undefined;
      case "getReferrerChain":
        return "";
      case "getWebGLStatus":
        return "webgl_allowed";
      case "management.getAll":
        return this.registry
          .list(profileId)
          .filter((record) => record.source === "webstore")
          .map((record) => this.managementInfo(profileId, record));
      case "management.get": {
        const record = this.registry.get(profileId, idOf(args[0]));
        if (record?.source !== "webstore")
          return { error: "Failed to find extension" };
        return this.managementInfo(profileId, record);
      }
      case "management.setEnabled": {
        const id = idOf(args[0]);
        const enabled = args[1] === true;
        const record = this.registry.get(profileId, id);
        if (record?.source !== "webstore")
          return { error: "Failed to find extension" };
        // Turning on what waits for new access goes through its review.
        if (enabled && record.pendingUpdate) {
          await this.reviewUpdate(profileId, id, window);
          return undefined;
        }
        await this.setEnabled(profileId, id, enabled);
        return undefined;
      }
      case "management.uninstall": {
        const id = idOf(args[0]);
        const removed = await this.confirmRemove(profileId, id, window);
        return removed
          ? undefined
          : { result: undefined, error: "User cancelled uninstall" };
      }
    }
  }

  private managementInfo(profileId: string, record: InstalledExtension) {
    const summary = this.summary(profileId, record);
    return {
      id: record.id,
      name: summary?.name ?? record.id,
      shortName: summary?.name ?? record.id,
      description: summary?.description ?? "",
      version: summary?.version ?? record.version,
      enabled: record.enabled,
      mayDisable: true,
      mayEnable: true,
      isApp: false,
      type: "extension",
      installType: "normal",
      offlineEnabled: false,
      homepageUrl: "",
      optionsUrl: "",
      permissions: [],
      hostPermissions: [],
      icons: [],
    };
  }

  private async storeIcon(url: string | undefined): Promise<string | null> {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "data:")
        return url.startsWith("data:image/") ? url : null;
      if (parsed.protocol !== "https:") return null;
      const response = await fetch(parsed.href);
      if (!response.ok) return null;
      const type = response.headers.get("content-type") ?? "image/png";
      if (!type.startsWith("image/")) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 512 * 1024) return null;
      return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  }

  /** Download, verify and install a store extension the person approved. */
  async installFromStore(
    profileId: string,
    extensionId: string,
    approved: PermissionSet,
    window: BrowserWindow | null,
  ): Promise<void> {
    const id = key(profileId, extensionId);
    if (this.installing.has(id)) throw new Error("Already installing.");
    this.installing.add(id);
    try {
      const offer = await this.webStore.latest(extensionId);
      const crx = await this.webStore.download(offer);
      const { dir, manifest } = this.unpack(profileId, crx, offer.version);
      const access = accessOf(manifest);
      const extra = accessIncrease(approved, access);
      if (!isEmptyAccess(extra)) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error(
          `The extension asks for more than you approved: ${accessWarnings(extra).join("; ")}`,
        );
      }
      const now = Date.now();
      const record: InstalledExtension = {
        id: extensionId,
        source: "webstore",
        path: dir,
        version: String(manifest.version),
        enabled: true,
        disabledReason: null,
        pinned: false,
        installedAt: now,
        updatedAt: now,
        approved: access,
        granted: { permissions: [], origins: [] },
        enabledRulesets: null,
        pendingUpdate: null,
        uninstallUrl: null,
        stagedUpdate: null,
        installedEventFor: null,
      };
      this.registry.put(profileId, record);
      this.pruneVersions(profileId, extensionId, dir);
      const loaded = await this.load(profileId, record);
      if (!loaded)
        throw new Error(
          this.loadErrors.get(id) ?? "The extension did not load.",
        );
      await this.syncBrand(profileId);
      this.changed(profileId);
      this.notifyStore(profileId, "management.onInstalled", [
        this.managementInfo(profileId, record),
      ]);
      const installed: ExtensionInstalled = {
        extensionId,
        name: loaded.name,
        iconUrl: loaded.icon(64),
        hasAction: Boolean(loaded.action),
      };
      const target = this.promptWindow(profileId, window);
      target?.webContents.send("catamorphic:extensions-installed", installed);
    } finally {
      this.installing.delete(id);
    }
  }

  /** Unpack a verified package next to its earlier versions. */
  private unpack(
    profileId: string,
    crx: VerifiedCrx,
    version: string,
  ): { dir: string; manifest: ReturnType<typeof parseManifest> } {
    if (!/^\d{1,9}(\.\d{1,9}){0,3}$/.test(version))
      throw new Error("The store named an invalid version.");
    const base = this.registry.dataDir(profileId, crx.id);
    fs.mkdirSync(base, { recursive: true });
    const staging = path.join(base, `.staging-${randomUUID()}`);
    extractArchive(crx.archive, staging);
    try {
      const manifest = readManifest(staging);
      if (String(manifest.version) !== version)
        throw new ManifestError("The package's version is not the store's.");
      // The id is the key's: Electron derives it from `key`.
      manifest.key = crx.publicKey.toString("base64");
      fs.writeFileSync(
        path.join(staging, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      const dir = path.join(base, `${version}_0`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
      return { dir, manifest };
    } catch (cause) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw cause;
    }
  }

  /** Remove version folders other than `keep` (and stray staging). */
  private pruneVersions(
    profileId: string,
    extensionId: string,
    ...keep: string[]
  ): void {
    const base = this.registry.dataDir(profileId, extensionId);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      if (!keep.includes(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async loadUnpacked(
    profileId: string,
    folder: string,
  ): Promise<ExtensionSummary | null> {
    const dir = path.resolve(folder);
    const manifest = readManifest(dir);
    const session = this.sessions.get(profileId);
    if (!session) throw new Error("Open a browser tab in this profile first.");
    const extension = await session.extensions.loadExtension(dir, {
      allowFileAccess: false,
    });
    this.expectedUnloads.add(key(profileId, extension.id));
    session.extensions.removeExtension(extension.id);
    const existing = this.registry.get(profileId, extension.id);
    if (existing && existing.source !== "unpacked")
      throw new Error(
        "An extension with this id is already installed from the Chrome Web Store.",
      );
    if (existing) this.unload(profileId, extension.id);
    const now = Date.now();
    const record: InstalledExtension = {
      id: extension.id,
      source: "unpacked",
      path: dir,
      version: String(manifest.version),
      enabled: true,
      disabledReason: null,
      pinned: existing?.pinned ?? false,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      approved: accessOf(manifest),
      granted: existing?.granted ?? { permissions: [], origins: [] },
      enabledRulesets: null,
      pendingUpdate: null,
      uninstallUrl: null,
      stagedUpdate: null,
      installedEventFor: null,
    };
    this.registry.put(profileId, record);
    await this.load(profileId, record);
    await this.syncBrand(profileId);
    this.changed(profileId);
    return this.summary(profileId, record);
  }

  async reload(profileId: string, extensionId: string): Promise<void> {
    const record = this.registry.get(profileId, extensionId);
    if (!record?.enabled) return;
    this.unload(profileId, extensionId);
    // An unpacked extension's edited manifest applies its rulesets again.
    const next =
      record.source === "unpacked"
        ? this.registry.update(profileId, extensionId, (current) => ({
            ...current,
            enabledRulesets: null,
          }))
        : record;
    if (next) await this.load(profileId, next);
    await this.syncBrand(profileId);
    this.changed(profileId);
  }

  async setEnabled(
    profileId: string,
    extensionId: string,
    enabled: boolean,
  ): Promise<void> {
    const record = this.registry.get(profileId, extensionId);
    if (!record) throw new Error("No such extension.");
    if (enabled && record.pendingUpdate)
      throw new Error("Review the extension's new access first.");
    if (
      record.enabled === enabled &&
      (enabled ? this.extension(profileId, extensionId) : true)
    )
      return;
    const next = this.registry.update(profileId, extensionId, (current) => ({
      ...current,
      enabled,
      disabledReason: enabled ? null : "user",
    }));
    if (!next) return;
    if (enabled) await this.load(profileId, next);
    else this.unload(profileId, extensionId);
    await this.syncBrand(profileId);
    this.changed(profileId);
    this.notifyStore(
      profileId,
      enabled ? "management.onEnabled" : "management.onDisabled",
      [this.managementInfo(profileId, next)],
    );
  }

  /** Ask, then remove; true when it went. */
  async confirmRemove(
    profileId: string,
    extensionId: string,
    window: BrowserWindow | null,
  ): Promise<boolean> {
    const record = this.registry.get(profileId, extensionId);
    if (!record) return false;
    const summary = this.summary(profileId, record);
    const accepted = await this.ask(
      profileId,
      {
        kind: "remove",
        extensionId,
        name: summary?.name ?? extensionId,
        iconUrl: summary?.iconUrl ?? null,
        warnings: [],
      },
      window,
    );
    if (!accepted) return false;
    await this.uninstall(profileId, extensionId);
    return true;
  }

  async uninstall(profileId: string, extensionId: string): Promise<void> {
    const record = this.registry.get(profileId, extensionId);
    if (!record) return;
    const uninstallUrl = record.uninstallUrl;
    this.unload(profileId, extensionId);
    this.registry.remove(profileId, extensionId);
    this.syncStorage.forget(profileId, extensionId);
    // The profile's copy and data; an unpacked folder stays where it is.
    fs.rmSync(this.registry.dataDir(profileId, extensionId), {
      recursive: true,
      force: true,
    });
    const session = this.sessions.get(profileId);
    await session
      ?.clearStorageData({ origin: `chrome-extension://${extensionId}` })
      .catch(() => {});
    await this.syncBrand(profileId);
    this.changed(profileId);
    this.notifyStore(profileId, "management.onUninstalled", [extensionId]);
    if (uninstallUrl)
      void this.openInTab(profileId, uninstallUrl, true, null).catch(() => {});
  }

  private notifyStore(profileId: string, name: string, args: unknown[]): void {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed() || contents.getType() !== "webview") continue;
      if (this.profileOfSession(contents.session) !== profileId) continue;
      try {
        if (new URL(contents.getURL()).origin !== webStoreOrigin()) continue;
      } catch {
        continue;
      }
      contents.send(EXTENSION_CHANNELS.webstoreEvent, name, args);
    }
  }

  private scheduleUpdates(profileId: string): void {
    clearTimeout(this.updateTimers.get(profileId));
    const last = this.registry.lastUpdateCheck(profileId) ?? 0;
    const due = Math.max(
      FIRST_UPDATE_DELAY_MS,
      last + UPDATE_INTERVAL_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      void this.checkUpdates(profileId, false).finally(() => {
        // A profile removed meanwhile checks nothing more.
        if (this.sessions.has(profileId)) this.scheduleUpdates(profileId);
      });
    }, due);
    timer.unref?.();
    this.updateTimers.set(profileId, timer);
  }

  /** Check the store for newer versions and apply what needs no new access. */
  async checkUpdates(profileId: string, manual: boolean): Promise<void> {
    if (this.checking.has(profileId)) return;
    const store = this.registry
      .list(profileId)
      .filter((record) => record.source === "webstore");
    if (store.length === 0) return;
    this.checking.add(profileId);
    this.changed(profileId);
    try {
      const offers = await this.webStore.check(
        store.map((record) => ({ id: record.id, version: record.version })),
      );
      for (const offer of offers) {
        try {
          await this.applyUpdate(profileId, offer);
        } catch (cause) {
          console.warn(
            `[extensions] update of ${offer.id} failed:`,
            errorMessage(cause),
          );
        }
      }
      this.registry.setLastUpdateCheck(profileId, Date.now());
    } catch (cause) {
      if (manual) throw cause;
      console.warn("[extensions] update check failed:", errorMessage(cause));
    } finally {
      this.checking.delete(profileId);
      this.changed(profileId);
    }
  }

  private async applyUpdate(
    profileId: string,
    offer: Awaited<ReturnType<WebStore["check"]>>[number],
  ): Promise<void> {
    const record = this.registry.get(profileId, offer.id);
    if (
      !record ||
      record.pendingUpdate?.version === offer.version ||
      record.stagedUpdate?.version === offer.version
    )
      return;
    const crx = await this.webStore.download(offer);
    const { dir, manifest } = this.unpack(profileId, crx, offer.version);
    const access = accessOf(manifest);
    const extra = accessIncrease(record.approved, access);
    if (!isEmptyAccess(extra)) {
      // Chrome turns off an extension whose update asks for more, until
      // the person accepts; the running version keeps nothing new. One the
      // person turned off stays off for their reason.
      if (record.enabled) this.unload(profileId, offer.id);
      this.registry.update(profileId, offer.id, (current) => ({
        ...current,
        enabled: false,
        disabledReason: current.enabled
          ? "permissions"
          : current.disabledReason,
        pendingUpdate: {
          version: offer.version,
          path: dir,
          warnings: accessWarnings(extra),
        },
      }));
      this.pruneVersions(profileId, offer.id, record.path, dir);
      await this.syncBrand(profileId);
      return;
    }
    // An extension at work (a popup or side panel open, a tab under its
    // debugger, a native host connected) keeps its version until it is
    // idle, as Chrome waits: the update waits beside it, and the extension
    // hears once that it is ready.
    if (record.enabled && this.isBusy(profileId, offer.id)) {
      this.registry.update(profileId, offer.id, (current) => ({
        ...current,
        stagedUpdate: { version: offer.version, path: dir, approved: access },
      }));
      this.pruneVersions(profileId, offer.id, record.path, dir);
      this.events.dispatch(profileId, offer.id, "runtime.onUpdateAvailable", [
        { version: offer.version },
      ]);
      this.retryStaged(profileId);
      return;
    }
    // Turned off only because an earlier update asked for more: a version
    // that no longer does runs again.
    await this.swapVersion(profileId, offer.id, {
      dir,
      version: String(manifest.version),
      approved: access,
      enable: record.enabled || record.disabledReason === "permissions",
    });
  }

  /** Install staged updates whose extensions are idle now. */
  private async applyStaged(profileId: string): Promise<void> {
    for (const record of this.registry.list(profileId)) {
      const staged = record.stagedUpdate;
      if (!staged) continue;
      if (record.enabled && this.isBusy(profileId, record.id)) {
        this.retryStaged(profileId);
        continue;
      }
      await this.swapVersion(profileId, record.id, {
        dir: staged.path,
        version: staged.version,
        approved: staged.approved,
        enable: record.enabled,
      });
      this.changed(profileId);
    }
  }

  /** Install a version; it runs only when `enable` says so. */
  private async swapVersion(
    profileId: string,
    extensionId: string,
    next: {
      dir: string;
      version: string;
      approved: PermissionSet;
      enable: boolean;
    },
  ): Promise<void> {
    this.unload(profileId, extensionId);
    const record = this.registry.update(profileId, extensionId, (current) => ({
      ...current,
      path: next.dir,
      version: next.version,
      updatedAt: Date.now(),
      approved: next.approved,
      enabled: next.enable,
      disabledReason: next.enable
        ? null
        : current.disabledReason === "permissions"
          ? "user"
          : (current.disabledReason ?? "user"),
      pendingUpdate: null,
      stagedUpdate: null,
      enabledRulesets: null,
    }));
    this.pruneVersions(profileId, extensionId, next.dir);
    if (record?.enabled) await this.load(profileId, record);
    await this.syncBrand(profileId);
  }

  /** Whether an extension is in use right now, so an update should wait. */
  private isBusy(profileId: string, extensionId: string): boolean {
    for (const view of this.views.values())
      if (view.profileId === profileId && view.extensionId === extensionId)
        return true;
    for (const entry of this.nativePorts.values())
      if (
        entry.context.profileId === profileId &&
        entry.context.extensionId === extensionId
      )
        return true;
    return this.debuggers.allClients().includes(`${profileId}:${extensionId}`);
  }

  /** Look again soon for a staged update's extension to be idle. */
  private retryStaged(profileId: string, delay = UPDATE_RETRY_MS): void {
    if (this.retryTimers.has(profileId)) {
      if (delay > 0) return;
      clearTimeout(this.retryTimers.get(profileId));
    }
    this.retryTimers.set(
      profileId,
      setTimeout(() => {
        this.retryTimers.delete(profileId);
        if (this.sessions.has(profileId))
          void this.applyStaged(profileId).catch((cause: unknown) =>
            console.warn(
              "[extensions] a waiting update failed:",
              errorMessage(cause),
            ),
          );
      }, delay),
    );
  }

  /** The person reviews an update that needs more access. */
  async reviewUpdate(
    profileId: string,
    extensionId: string,
    window: BrowserWindow | null,
  ): Promise<void> {
    const record = this.registry.get(profileId, extensionId);
    const pending = record?.pendingUpdate;
    if (!record || !pending) return;
    let name = extensionId;
    try {
      const manifest = readManifest(pending.path);
      name = localizer(
        pending.path,
        manifest,
        app.getLocale(),
      )(String(manifest.name));
    } catch {
      // fall back to the id
    }
    const accepted = await this.ask(
      profileId,
      {
        kind: "update",
        extensionId,
        name,
        iconUrl: this.summary(profileId, record)?.iconUrl ?? null,
        warnings: pending.warnings,
      },
      window,
    );
    if (!accepted) return;
    const manifest = readManifest(pending.path);
    await this.swapVersion(profileId, extensionId, {
      dir: pending.path,
      version: pending.version,
      approved: accessOf(manifest),
      enable: true,
    });
    this.changed(profileId);
  }

  /** Where a launched auth flow or popup window lives (identity, windows.create). */
  async openExtensionWindow(
    extension: LoadedExtension,
    options: {
      url: string;
      type: "popup" | "normal";
      bounds: Partial<Electron.Rectangle>;
      focused: boolean;
      show?: boolean;
      /** False for an auth flow: it is no tab of the person's. */
      track?: boolean;
    },
  ): Promise<WindowRecord> {
    const session = this.sessions.get(extension.profileId);
    if (!session) throw new Error("The extension is not running.");
    const parent = this.tabs.lastFocusedWindow(extension.profileId)?.window;
    const window = new BrowserWindow({
      width: options.bounds.width ?? 500,
      height: options.bounds.height ?? 640,
      ...(options.bounds.x !== undefined && options.bounds.y !== undefined
        ? { x: options.bounds.x, y: options.bounds.y }
        : {}),
      show: false,
      autoHideMenuBar: true,
      title: extension.name,
      ...(parent && options.type === "popup" ? { parent } : {}),
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    // The title names the site it shows and the extension that opened it;
    // the page can't set it (Chrome's popup windows show the address).
    const label = () => {
      try {
        const { protocol, host } = new URL(window.webContents.getURL());
        if (protocol === "http:" || protocol === "https:")
          return `${host} (${extension.name})`;
      } catch {
        // Not loaded yet.
      }
      return extension.name;
    };
    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(label());
    });
    window.webContents.on("did-navigate", () => window.setTitle(label()));
    // Links it opens become tabs, as from any popup.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url))
        void this.openInTab(extension.profileId, url, true, null).catch(
          () => {},
        );
      return { action: "deny" };
    });
    const record: WindowRecord = {
      id: window.id,
      profileId: extension.profileId,
      type: options.type,
      window,
      openedBy: extension.id,
    };
    if (options.track !== false) this.tabs.addWindow(record);
    if (options.show !== false)
      window.once("ready-to-show", () => {
        if (options.focused) window.show();
        else window.showInactive();
      });
    void window.loadURL(options.url).catch(() => {});
    return record;
  }
}

export function groupObject(group: {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}): Record<string, unknown> {
  return {
    id: group.id,
    windowId: group.windowId,
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
    shared: false,
  };
}
