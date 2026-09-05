import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  safeStorage,
  type WebContents,
} from "electron";
import type { DesktopUpdateChannel } from "../shared/update.js";
import { registerAgentBridge } from "./agent-bridge.js";
import { registerBrowserSupport } from "./browser.js";
import { toPublicConnection } from "./connections-store.js";
import { ConnectorsService } from "./connectors.js";
import {
  desktopApplicationName,
  desktopDataDirFromEnvironment,
} from "./development-paths.js";
import {
  shouldShowWindow,
  shouldUseE2ePlainTextEncryption,
} from "./e2e-window-mode.js";
import { IncognitoSessionsStore } from "./incognito-sessions.js";
import { registerIpcHandlers, type ServerState } from "./ipc.js";
import { type Keybindings, toAccelerator } from "./keybindings.js";
import { McpAppsService } from "./mcp-apps.js";
import { MobilePairingService } from "./mobile-pairing.js";
import { prepareVersionBackup } from "./pre-migration-backup.js";
import { ProfileConfigManager } from "./profile-config.js";
import { ProfilesStore } from "./profiles.js";
import { type EmbeddedServer, startEmbeddedServer } from "./server/boot.js";
import { resolveDataPaths } from "./server/paths.js";
import { registerTerminalSupport } from "./terminal.js";
import { windowBackgroundColor } from "./theme.js";
import {
  type DesktopUpdaterService,
  registerDesktopUpdater,
} from "./updater.js";
import { WindowStateStore } from "./window-state.js";
import { desktopProfileMcpProvider } from "./workflow-mcp-connections.js";

// Electron derives the macOS safeStorage Keychain service from the app name.
// Keep unsigned development and E2E builds away from the consistently signed
// production identity so local testing cannot poison the production item's
// access control list and cause prompts after an update.
const isolatedDataDir = desktopDataDirFromEnvironment(process.env);
app.setName(
  desktopApplicationName({
    isPackaged: app.isPackaged,
    isolatedDataDir,
  }),
);

// macOS 26.x + Apple Silicon: V8's background compiler threads race the
// OS's MAP_JIT write-protection and SIGTRAP in ThreadIsolation::
// RegisterInstructionStreamAllocation (electron/electron#51351 family).
// Keep JIT compilation on the main thread until Electron ships a fix.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch(
    "js-flags",
    "--no-concurrent-sparkplug --no-concurrent-recompilation",
  );
}

// Present as plain Chrome to web content, Vivaldi/Edge-style. Chromium
// derives the default UA (and the Sec-CH-UA "brands" that Google's
// supported-browser gate checks) from the app name/version — stripping
// the Electron and app tokens here, before ready, makes every layer
// (request headers, navigator.userAgent, navigator.userAgentData)
// consistently Chrome. There is no "register as a browser with Google"
// path; identical-engine browsers get blocked by name (Vivaldi proved
// it by misspelling theirs), so shipping Chrome's identity IS the fix.
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/[\d.]+/, "")
  .replace(new RegExp(` ${app.name}/[\\d.]+`), "")
  .replace(/ catamorphic-desktop\/[\d.]+/, "");

// E2E runs point userData at a throwaway dir so tests never touch real
// settings/projects/DB, and may run beside a normally-running app.
const e2eDataDir = process.env.CATAMORPHIC_E2E_DATA_DIR;
const showWindow = shouldShowWindow({
  e2eDataDir,
  e2eWindowMode: process.env.CATAMORPHIC_E2E_WINDOW_MODE,
});
if (isolatedDataDir) {
  app.setPath("userData", isolatedDataDir);
}

// PGlite is single-writer: a second instance opening the same data dir
// aborts deep in WASM ("Aborted(). Build with -sASSERTIONS"). Refuse to
// start and surface the first instance's window instead.
if (!isolatedDataDir && !app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", (_event, argv) => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
  // Windows/Linux deliver a protocol URL as an argv of the second launch.
  const link = argv.find((arg) => arg.startsWith("catamorphic://"));
  if (link) deliverConnectLink(link);
});

// `catamorphic://connect?…` links (ADR 0055): what an invite hands a member.
// Registered as the protocol's handler; macOS delivers via open-url, other
// platforms via argv (first launch here, later launches via second-instance).
if (!e2eDataDir) app.setAsDefaultProtocolClient("catamorphic");
app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverConnectLink(url);
});
let pendingConnectLink: string | null =
  process.argv.find((arg) => arg.startsWith("catamorphic://")) ?? null;
function deliverConnectLink(url: string): void {
  if (!url.startsWith("catamorphic://connect")) return;
  // Pull, not push: the link stays pending until the renderer TAKES it
  // (`remote-take-pending-link`), so a link arriving before <App> mounts
  // its listener (cold launch, server still booting) is not lost. The push
  // only nudges a mounted renderer to take it now.
  pendingConnectLink = url;
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  window.webContents.send("catamorphic:connect-link", url);
  if (window.isMinimized()) window.restore();
  window.focus();
}

/** The renderer's side of the hand-off (registered here: no ipc.ts cycle). */
ipcMain.handle("catamorphic:remote-take-pending-link", () => {
  const link = pendingConnectLink;
  pendingConnectLink = null;
  return link;
});

const paths = resolveDataPaths();
const profilesStore = new ProfilesStore(paths.profilesFile);
// Per-profile config (theme, keybindings, sidebar, agents) — one manager
// shared by IPC, the window layer, and the chat agent's config mirror.
const profileConfig = new ProfileConfigManager(paths, profilesStore, () =>
  nativeTheme.shouldUseDarkColors ? "dark" : "light",
);

let server: EmbeddedServer | null = null;

const state: ServerState = {
  get current() {
    return server;
  },
  broadcast: (channel, payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  },
};

/**
 * Which profile each window shows. Windows are born with a profile (theme
 * pre-painted from it) and can switch in place when their workspace is
 * empty; broadcasts of per-profile state (theme, keybindings, sidebar,
 * agents) go only to that profile's windows.
 */
const windowProfiles = new Map<number, string>();

export interface WindowProfileRegistry {
  profileFor(sender: WebContents): string;
  windowsFor(profileId: string): BrowserWindow[];
  assign(sender: WebContents, profileId: string): void;
  openWindow(profileId: string): void;
}

const windows: WindowProfileRegistry = {
  profileFor(sender) {
    return (
      windowProfiles.get(sender.id) ?? profilesStore.lastActiveProfile().id
    );
  },
  windowsFor(profileId) {
    return BrowserWindow.getAllWindows().filter(
      (window) =>
        !window.isDestroyed() &&
        windowProfiles.get(window.webContents.id) === profileId,
    );
  },
  assign(sender, profileId) {
    windowProfiles.set(sender.id, profileId);
    profilesStore.setLastActiveProfile(profileId);
    const window = BrowserWindow.fromWebContents(sender);
    window?.setBackgroundColor(
      windowBackgroundColor(
        profileConfig.forProfile(profileId).theme.resolved(),
      ),
    );
    applyMenuForFocusedWindow();
  },
  openWindow(profileId) {
    const window = createWindow(profileId);
    window.focus();
  },
};

function sendToProfile(
  profileId: string,
  channel: string,
  payload: unknown,
): void {
  for (const window of windows.windowsFor(profileId)) {
    window.webContents.send(channel, payload);
  }
}

function createWindow(profileId?: string): BrowserWindow {
  const profile = profileId
    ? (profilesStore.get(profileId) ?? profilesStore.lastActiveProfile())
    : profilesStore.lastActiveProfile();
  const stores = profileConfig.forProfile(profile.id);
  // Placement survives a relaunch (size, position, maximized/fullscreen).
  const windowState = new WindowStateStore(
    path.join(app.getPath("userData"), "window-state.json"),
  );
  const saved = windowState.load();
  const window = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: 720,
    minHeight: 480,
    title: "Catamorphic",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Pre-paint background from the profile's theme so open doesn't flash;
    // stay hidden until the renderer has actually painted a frame.
    show: false,
    backgroundColor: windowBackgroundColor(stores.theme.resolved()),
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Browser tabs render as <webview> guests (see main/browser.ts).
      webviewTag: true,
      // E2e runs drive windows that are usually occluded (test runners
      // stack several instances behind the terminal), and Chromium
      // throttles rAF/animation events for occluded windows — exit
      // animations then never fire animationend and the motion suite
      // reads phantom zombies. Real usage keeps normal throttling.
      backgroundThrottling: e2eDataDir === undefined,
    },
  });
  // Renderer links must stay inside the workspace. Feature-specific flows can
  // open tabs through IPC, while this boundary catches plain window.open calls
  // from current and future renderer components.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      window.webContents.send("catamorphic:browser-open-url", { url });
    }
    return { action: "deny" };
  });
  if (saved.maximized) window.maximize();
  // A connect link that arrived before any window could take it (cold
  // launch from the link) is delivered once the renderer is up.
  window.webContents.once("did-finish-load", () => {
    if (pendingConnectLink) deliverConnectLink(pendingConnectLink);
  });
  window.once("ready-to-show", () => {
    if (!showWindow) {
      // On macOS, a never-shown BrowserWindow can remain unavailable to CDP.
      // Enter the native shown lifecycle without activating the app, then
      // hide in the same turn so local E2E runs never steal keyboard focus.
      window.showInactive();
      window.hide();
      return;
    }
    window.show();
    // Fullscreen after show: entering it on a hidden window leaves macOS
    // with a blank space until the next repaint.
    if (saved.fullscreen) window.setFullScreen(true);
  });
  windowState.track(window, saved);
  // Captured now: `closed` fires after destruction, when touching
  // window.webContents throws "Object has been destroyed".
  const webContentsId = window.webContents.id;
  windowProfiles.set(webContentsId, profile.id);
  profilesStore.setLastActiveProfile(profile.id);
  window.on("closed", () => {
    windowProfiles.delete(webContentsId);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(
      path.join(import.meta.dirname, "../renderer/index.html"),
    );
  }
  return window;
}

// The default menu binds Cmd+W to "Close Window". The workspace has its
// own closable surfaces (tabs, floating chats), so close-tab is forwarded
// to the renderer, which closes the most specific thing in focus.
// Accelerators come from the focused window's profile keybindings; new-tab,
// the command palette, and toggle-sidebar are window-level shortcuts handled
// in the renderer.
function buildMenu(bindings: Keybindings): Menu {
  const selectedUpdateChannel = desktopUpdater?.channel() ?? "stable";
  const chooseUpdateChannel = (channel: DesktopUpdateChannel) => {
    void desktopUpdater?.setChannel(channel).finally(() => {
      applyMenuForFocusedWindow();
    });
  };
  return Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Close Tab",
          accelerator: toAccelerator(bindings["close-tab"]),
          click: (_item, window) => {
            if (window instanceof BrowserWindow) {
              window.webContents.send("catamorphic:close-surface");
            }
          },
        },
      ],
    },
    { role: "editMenu" },
    {
      // Custom View menu: the stock viewMenu role binds Cmd+R /
      // Cmd+Shift+R to reloading the whole app window, which must belong
      // to the focused browser tab's page instead (handled in the
      // renderer). App reload stays available on Cmd+Alt+R.
      label: "View",
      submenu: [
        {
          label: "Reload App",
          accelerator: "CmdOrCtrl+Alt+R",
          role: "forceReload",
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        // Not the stock minimize role: its default Cmd+M accelerator would
        // swallow the workspace's minimize/restore-chat shortcut.
        {
          label: "Minimize",
          click: (_item, window) => {
            if (window instanceof BrowserWindow) window.minimize();
          },
        },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [{ type: "separator" } as const, { role: "front" } as const]
          : [{ role: "close" } as const]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Check for Updates…",
          click: () => void desktopUpdater?.check(true),
        },
        { type: "separator" },
        {
          label: "Update Channel",
          submenu: [
            {
              label: "Stable",
              type: "radio",
              checked: selectedUpdateChannel === "stable",
              click: () => chooseUpdateChannel("stable"),
            },
            {
              label: "Preview",
              type: "radio",
              checked: selectedUpdateChannel === "preview",
              click: () => chooseUpdateChannel("preview"),
            },
          ],
        },
      ],
    },
  ]);
}

/** Menu accelerators follow the focused window's profile. */
function applyMenuForFocusedWindow(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const profileId = focused
    ? (windowProfiles.get(focused.webContents.id) ??
      profilesStore.lastActiveProfile().id)
    : profilesStore.lastActiveProfile().id;
  Menu.setApplicationMenu(
    buildMenu(profileConfig.forProfile(profileId).keybindings.load()),
  );
}

app.whenReady().then(async () => {
  // GitHub's Linux runner has no Secret Service. Electron's in-memory key
  // keeps safeStorage-backed flows realistic inside isolated throwaway E2E
  // profiles without weakening normal desktop profiles.
  if (
    shouldUseE2ePlainTextEncryption({
      e2eDataDir,
      platform: process.platform,
    })
  ) {
    safeStorage.setUsePlainTextEncryption(true);
  }
  desktopUpdater = registerDesktopUpdater({
    broadcast: state.broadcast,
    beforeInstall: async () => {
      await server?.shutdown();
      quitting = true;
    },
  });
  applyMenuForFocusedWindow();
  // Live-reload: agents and users edit the per-profile config files
  // directly. Changes fan out only to that profile's windows.
  profileConfig.onKeybindingsChanged((profileId, bindings) => {
    applyMenuForFocusedWindow();
    sendToProfile(profileId, "catamorphic:keybindings-changed", bindings);
  });
  profileConfig.onThemeChanged((profileId, theme) => {
    for (const window of windows.windowsFor(profileId)) {
      window.setBackgroundColor(windowBackgroundColor(theme));
      window.webContents.send("catamorphic:theme-changed", theme);
    }
  });
  nativeTheme.on("updated", () => profileConfig.systemAppearanceChanged());
  profileConfig.onSidebarChanged((profileId) => {
    // No payload: the resolved config depends on each window's active
    // project (layered resolution), so the renderer refetches instead.
    sendToProfile(profileId, "catamorphic:sidebar-config-changed", null);
  });
  profileConfig.onPrefsChanged((profileId, prefs) => {
    sendToProfile(profileId, "catamorphic:prefs-changed", prefs);
  });
  profileConfig.onConnectionsChanged((profileId) => {
    sendToProfile(
      profileId,
      "catamorphic:connections-changed",
      profileConfig
        .forProfile(profileId)
        .connections.list()
        .map(toPublicConnection),
    );
  });
  app.on("browser-window-focus", applyMenuForFocusedWindow);

  // Connectors: profile-level MCP connections + installed plugin
  // connectors, shared by the IPC surface and the agent registry.
  const connectors = new ConnectorsService({
    connectorsDirFor: (profileId) =>
      path.join(paths.profilesDir, profileId, "connectors"),
    connectionsFor: (profileId) =>
      profileConfig.forProfile(profileId).connections,
  });
  // MCP Apps host: which connection tools carry a ui:// view, their
  // templates, and the view-initiated tool calls. Elicitation from those
  // servers routes to the front window (bridge assigned just below; the
  // closure reads it lazily, long after boot when a connect happens).
  const mcpApps = new McpAppsService({
    connectionsFor: (profileId) =>
      profileConfig.forProfile(profileId).connections,
    onElicit: (request) =>
      agentBridge
        ? agentBridge.bridge.elicit(undefined, request)
        : Promise.resolve({ action: "decline" }),
  });

  // Incognito sessions (ADR 0062): desktop-local state, consulted by the
  // mirror pusher and written from the renderer's chat creation.
  const incognitoSessions = new IncognitoSessionsStore(
    path.join(paths.root, "..", "incognito-sessions.json"),
  );

  // "Continue on mobile": the LAN listener that serves the PWA and
  // proxies /api with device-token auth. Auto-listens when phones are
  // already paired, so they reconnect after a desktop restart.
  const e2eMobilePairingAddress =
    process.env.CATAMORPHIC_E2E_MOBILE_PAIRING_ADDRESS;
  const mobilePairing = new MobilePairingService({
    file: path.join(paths.root, "..", "mobile-pairing.json"),
    profileConfig,
    serverUrl: () => state.current?.url ?? null,
    ...(e2eMobilePairingAddress && e2eDataDir
      ? {
          lanAddresses: () => [e2eMobilePairingAddress],
        }
      : {}),
  });
  if (mobilePairing.hasDevices()) {
    mobilePairing.ensureListening().catch((error) => {
      console.warn("[desktop] mobile listener failed to start:", error);
    });
  }

  registerIpcHandlers(
    profileConfig,
    state,
    windows,
    paths,
    profilesStore,
    connectors,
    mcpApps,
    mobilePairing,
    incognitoSessions,
  );
  browserSupport = registerBrowserSupport(
    profilesStore,
    profileConfig,
    windows,
    async (projectId) =>
      (await state.current?.projectRoots.get(projectId)) ?? null,
  );
  terminalSupport = registerTerminalSupport(
    state,
    (projectId) =>
      // Late-bound: the bridge registers just below, before any terminal
      // can spawn.
      agentBridge?.openHookEnv(projectId) ?? {},
  );
  agentBridge = registerAgentBridge(terminalSupport.agentTerminals);
  ipcMain.handle("catamorphic:webview-preload", () =>
    path.join(import.meta.dirname, "../preload/webview.cjs"),
  );
  const window = createWindow();

  try {
    const versionBackup = prepareVersionBackup({
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      dataRoot: paths.root,
      dbDir: paths.db,
    });
    if (versionBackup.backupPath) {
      console.log(
        `[desktop] Backed up the pre-migration database to ${versionBackup.backupPath}`,
      );
    }
    server = await startEmbeddedServer(
      paths,
      profilesStore,
      profileConfig,
      agentBridge?.bridge,
      connectors,
      mcpApps,
      incognitoSessions,
      [desktopProfileMcpProvider],
    );
    versionBackup.markBootSuccessful();
    state.broadcast("catamorphic:server-changed", {
      url: server.url,
      hasCodingAgent: server.hasCodingAgent,
    });
    // Don't hold job leases through OS sleep. A lease held by a frozen
    // process expires on the wall clock, so the step's work is discarded on
    // wake; releasing before the freeze parks the job cleanly and resume
    // picks it back up within a poll interval.
    powerMonitor.on("suspend", () => void server?.suspendExecution());
    powerMonitor.on("resume", () => {
      server?.resumeExecution();
      server?.syncSessionMailboxes();
    });
    app.on("browser-window-focus", () => server?.syncSessionMailboxes());
    // OAuth-backed connections hand their token to harnesses as a plain
    // header, so the app keeps it fresh: at boot, after sleep, and on a
    // slow tick (refresh only fires when a token is near expiry).
    const refreshConnectionTokens = () => {
      for (const profile of profilesStore.list().profiles) {
        void connectors.refreshTokens(profile.id).catch(() => {});
      }
    };
    refreshConnectionTokens();
    powerMonitor.on("resume", refreshConnectionTokens);
    // A wake is when sessions turn out to have expired — nudge every
    // window to re-probe its agents' auth health.
    powerMonitor.on("resume", () =>
      state.broadcast("catamorphic:agent-auth-maybe-changed", {}),
    );
    setInterval(refreshConnectionTokens, 4 * 60_000).unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[desktop] embedded server failed to start:", error);
    dialog.showErrorBox(
      "Catamorphic failed to start",
      `The embedded server could not boot.\n\n${message}`,
    );
    window.close();
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let browserSupport: ReturnType<typeof registerBrowserSupport> | null = null;
let terminalSupport: ReturnType<typeof registerTerminalSupport> | null = null;
let agentBridge: ReturnType<typeof registerAgentBridge> | null = null;
let desktopUpdater: DesktopUpdaterService | null = null;

let quitting = false;
app.on("before-quit", (event) => {
  profileConfig.dispose();
  browserSupport?.dispose();
  terminalSupport?.dispose();
  agentBridge?.dispose();
  desktopUpdater?.dispose();
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  void server.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
