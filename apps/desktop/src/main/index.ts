import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type WebContents,
} from "electron";
import { registerAgentBridge } from "./agent-bridge.js";
import { registerBrowserSupport } from "./browser.js";
import { registerIpcHandlers, type ServerState } from "./ipc.js";
import { type Keybindings, toAccelerator } from "./keybindings.js";
import { ProfileConfigManager } from "./profile-config.js";
import { ProfilesStore } from "./profiles.js";
import { type EmbeddedServer, startEmbeddedServer } from "./server/boot.js";
import { resolveDataPaths } from "./server/paths.js";
import { registerTerminalSupport } from "./terminal.js";
import { windowBackgroundColor } from "./theme.js";

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
if (e2eDataDir) {
  app.setPath("userData", e2eDataDir);
}

// PGlite is single-writer: a second instance opening the same data dir
// aborts deep in WASM ("Aborted(). Build with -sASSERTIONS"). Refuse to
// start and surface the first instance's window instead.
if (!e2eDataDir && !app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

const paths = resolveDataPaths();
const profilesStore = new ProfilesStore(paths.profilesFile);
// Per-profile config (theme, keybindings, sidebar, agents) — one manager
// shared by IPC, the window layer, and the chat agent's config mirror.
const profileConfig = new ProfileConfigManager(paths, profilesStore);

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
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
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
  window.once("ready-to-show", () => window.show());
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
  // Legacy config migration first: it seeds the default profile's agent
  // roster from the old settings.json, whose key needs safeStorage (only
  // usable once the app is ready).
  profileConfig.migrate();
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
  profileConfig.onSidebarChanged((profileId, config) => {
    sendToProfile(profileId, "catamorphic:sidebar-config-changed", config);
  });
  profileConfig.onPrefsChanged((profileId, prefs) => {
    sendToProfile(profileId, "catamorphic:prefs-changed", prefs);
  });
  app.on("browser-window-focus", applyMenuForFocusedWindow);

  registerIpcHandlers(profileConfig, state, windows, paths);
  browserSupport = registerBrowserSupport(
    profilesStore,
    profileConfig,
    windows,
  );
  terminalSupport = registerTerminalSupport(state);
  agentBridge = registerAgentBridge(terminalSupport.agentTerminals);
  ipcMain.handle("catamorphic:webview-preload", () =>
    path.join(import.meta.dirname, "../preload/webview.cjs"),
  );
  const window = createWindow();

  try {
    server = await startEmbeddedServer(
      paths,
      profilesStore,
      profileConfig,
      agentBridge?.bridge,
    );
    state.broadcast("catamorphic:server-changed", {
      url: server.url,
      hasCodingAgent: server.hasCodingAgent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

let quitting = false;
app.on("before-quit", (event) => {
  profileConfig.dispose();
  browserSupport?.dispose();
  terminalSupport?.dispose();
  agentBridge?.dispose();
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  void server.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
