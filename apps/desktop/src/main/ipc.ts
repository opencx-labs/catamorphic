import { app, BrowserWindow, ipcMain } from "electron";
import type { EmbeddedServer } from "./server/boot.js";
import {
  DEFAULT_MODELS,
  type DesktopSettings,
  type ModelProvider,
  type PublicSettings,
  type SettingsStore,
  toPublicSettings,
} from "./server/settings.js";

export interface ServerState {
  current: EmbeddedServer | null;
  /** Restart the embedded server with fresh settings; resolves to the new URL. */
  restart: (settings: DesktopSettings) => Promise<EmbeddedServer>;
  /** Notify open windows that the server URL changed. */
  broadcast: (channel: string, payload: unknown) => void;
}

export interface UpdateSettingsInput {
  provider: ModelProvider;
  model?: string;
  /** New API key; omit to keep the stored one, null to clear it. */
  apiKey?: string | null;
}

export function registerIpcHandlers(
  store: SettingsStore,
  state: ServerState,
): void {
  ipcMain.handle("catamorphic:server-state", () => ({
    url: state.current?.url ?? null,
    hasCodingAgent: state.current?.hasCodingAgent ?? false,
  }));

  // Dev-only: lets UI automation (CDP) drive window geometry, which
  // Electron's CDP endpoint does not support (no Browser.getWindowForTarget).
  if (!app.isPackaged) {
    ipcMain.handle(
      "catamorphic:dev-window",
      (
        event,
        action: "maximize" | "unmaximize" | "minimize" | "restore" | "setSize",
        width?: number,
        height?: number,
      ) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return null;
        if (action === "setSize") {
          if (width && height) {
            if (window.isMaximized()) window.unmaximize();
            window.setBounds({ x: 0, y: 30, width, height });
          }
        } else {
          window[action]();
        }
        const bounds = window.getBounds();
        return { ...bounds, maximized: window.isMaximized() };
      },
    );
  }

  ipcMain.handle(
    "catamorphic:settings-get",
    (): PublicSettings => toPublicSettings(store.load()),
  );

  ipcMain.handle(
    "catamorphic:settings-set",
    async (_event, input: UpdateSettingsInput): Promise<PublicSettings> => {
      const previous = store.load();
      const next: DesktopSettings = {
        provider: input.provider,
        model: input.model?.trim() || DEFAULT_MODELS[input.provider],
        apiKey:
          input.apiKey === undefined
            ? previous.apiKey
            : input.apiKey?.trim() || null,
      };
      store.save(next);

      const server = await state.restart(next);
      state.broadcast("catamorphic:server-changed", {
        url: server.url,
        hasCodingAgent: server.hasCodingAgent,
      });
      return toPublicSettings(next);
    },
  );
}
