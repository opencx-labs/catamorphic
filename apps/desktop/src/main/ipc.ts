import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { EmbeddedServer } from "./server/boot.js";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "./server/boot.js";
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

  // Where new projects go by default: ~/Catamorphic/<name>. Always a real,
  // user-visible folder — project data never hides in app data.
  ipcMain.handle("catamorphic:default-projects-dir", () =>
    path.join(app.getPath("home"), "Catamorphic"),
  );

  const identity = {
    tenantId: DESKTOP_TENANT_ID,
    externalUserId: DESKTOP_USER_ID,
  };

  // Project create/import runs through IPC (not HTTP): explicit filesystem
  // locations are a desktop capability, and the projectId → folder mapping is
  // desktop-owned state the shared API never sees.
  ipcMain.handle(
    "catamorphic:project-create",
    async (
      _event,
      input: {
        name: string;
        rootPath: string;
        templateId?: string;
        importExisting?: boolean;
      },
    ) => {
      const server = state.current;
      if (!server) throw new Error("Server not running");
      if (!path.isAbsolute(input.rootPath)) {
        throw new Error("rootPath must be an absolute path");
      }
      const project = await server.catamorphic.core.projects.create(identity, {
        name: input.name,
        templateId: input.templateId,
        rootPath: input.rootPath,
        importExisting: input.importExisting,
      });
      await server.projectRoots.set(project.id, input.rootPath);
      return { id: project.id, name: project.name };
    },
  );

  ipcMain.handle(
    "catamorphic:project-delete",
    async (_event, input: { projectId: string; trashFolder?: boolean }) => {
      const server = state.current;
      if (!server) throw new Error("Server not running");
      const rootPath = await server.projectRoots.get(input.projectId);
      // Trash first: a failed trash should leave the project intact rather
      // than half-deleted, and after the row is gone we lose the path.
      if (input.trashFolder && rootPath) {
        await shell.trashItem(rootPath);
      }
      await server.catamorphic.core.projects.delete(identity, input.projectId);
      await server.projectRoots.delete(input.projectId);
    },
  );

  ipcMain.handle(
    "catamorphic:project-root",
    (_event, projectId: string): Promise<string | null> => {
      const server = state.current;
      if (!server) return Promise.resolve(null);
      return server.projectRoots.get(projectId);
    },
  );

  ipcMain.handle(
    "catamorphic:pick-folder",
    async (
      event,
      opts?: { title?: string; defaultPath?: string },
    ): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, {
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle("catamorphic:reveal-folder", (_event, folderPath: string) => {
    if (path.isAbsolute(folderPath)) shell.openPath(folderPath);
  });

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
