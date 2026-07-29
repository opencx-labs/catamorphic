import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers, type ServerState } from "./ipc.js";
import { type EmbeddedServer, startEmbeddedServer } from "./server/boot.js";
import { resolveDataPaths } from "./server/paths.js";
import { SettingsStore } from "./server/settings.js";

const paths = resolveDataPaths();
const settingsStore = new SettingsStore(paths.settingsFile);

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
        server = await startEmbeddedServer(paths, settings);
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
      preload: path.join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts require an unsandboxed renderer.
      sandbox: false,
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

app.whenReady().then(async () => {
  registerIpcHandlers(settingsStore, state);
  const window = createWindow();

  try {
    server = await startEmbeddedServer(paths, settingsStore.load());
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

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  void server.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
