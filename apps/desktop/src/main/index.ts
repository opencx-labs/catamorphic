import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { registerBrowserSupport } from "./browser.js";
import { registerIpcHandlers, type ServerState } from "./ipc.js";
import { ProfilesStore } from "./profiles.js";
import {
  type Keybindings,
  KeybindingsStore,
  toAccelerator,
} from "./keybindings.js";
import { type EmbeddedServer, startEmbeddedServer } from "./server/boot.js";
import { resolveDataPaths } from "./server/paths.js";
import { SettingsStore } from "./server/settings.js";

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

// PGlite is single-writer: a second instance opening the same data dir
// aborts deep in WASM ("Aborted(). Build with -sASSERTIONS"). Refuse to
// start and surface the first instance's window instead.
if (!app.requestSingleInstanceLock()) {
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
const settingsStore = new SettingsStore(paths.settingsFile);
const keybindingsStore = new KeybindingsStore(paths.keybindingsFile);
const profilesStore = new ProfilesStore(paths.profilesFile);

let server: EmbeddedServer | null = null;
let restarting: Promise<EmbeddedServer> | null = null;

const state: ServerState = {
  get current() {
    return server;
  },
  set current(value) {
    server = value;
  },
  restart: (settings) => {
    restarting ??= (async () => {
      try {
        await server?.shutdown();
        server = await startEmbeddedServer(paths, settings, keybindingsStore);
        return server;
      } finally {
        restarting = null;
      }
    })();
    return restarting;
  },
  broadcast: (channel, payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channel, payload);
    }
  },
};

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Catamorphic",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0a0a0b",
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Browser tabs render as <webview> guests (see main/browser.ts).
      webviewTag: true,
    },
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
// Accelerators come from the user's keybindings file; new-chat and
// toggle-sidebar are window-level shortcuts handled in the renderer.
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
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [{ type: "separator" } as const, { role: "front" } as const]
          : [{ role: "close" } as const]),
      ],
    },
  ]);
}

function applyKeybindings(bindings: Keybindings): void {
  Menu.setApplicationMenu(buildMenu(bindings));
  state.broadcast("catamorphic:keybindings-changed", bindings);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu(keybindingsStore.load()));
  // Live-reload: agents and users edit keybindings.json directly.
  keybindingsStore.watch(applyKeybindings);
  registerIpcHandlers(settingsStore, keybindingsStore, state);
  browserSupport = registerBrowserSupport(profilesStore);
  ipcMain.handle("catamorphic:webview-preload", () =>
    path.join(import.meta.dirname, "../preload/webview.cjs"),
  );
  const window = createWindow();

  try {
    server = await startEmbeddedServer(
      paths,
      settingsStore.load(),
      keybindingsStore,
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

let quitting = false;
app.on("before-quit", (event) => {
  keybindingsStore.dispose();
  browserSupport?.dispose();
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  void server.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
