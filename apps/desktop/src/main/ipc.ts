import path from "node:path";
import {
  buildInstallationUrl,
  GithubAuthError,
  pollDeviceToken,
  requestDeviceCode,
} from "@catamorphic/github";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  type Keybindings,
  type KeybindingsStore,
  normalizeKeybindings,
} from "./keybindings.js";
import {
  normalizeTheme,
  type ResolvedTheme,
  resolveTheme,
  THEME_PRESETS,
  type ThemeStore,
  windowBackgroundColor,
} from "./theme.js";
import type { EmbeddedServer } from "./server/boot.js";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "./server/boot.js";
import { GITHUB_APP } from "./server/github.js";
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
  keybindings: KeybindingsStore,
  theme: ThemeStore,
  state: ServerState,
): void {
  ipcMain.handle("catamorphic:keybindings-get", () => keybindings.load());

  ipcMain.handle("catamorphic:theme-get", () => theme.resolved());

  ipcMain.handle("catamorphic:theme-presets", () =>
    THEME_PRESETS.map(({ id, label, colors }) => ({ id, label, colors })),
  );

  // Saving triggers the file watcher, which syncs the native window
  // background and broadcasts the resolved theme to every window.
  ipcMain.handle(
    "catamorphic:theme-set",
    (event, input: unknown): ResolvedTheme => {
      const next = normalizeTheme(input);
      theme.save(next);
      const resolved = resolveTheme(next);
      // Apply to the calling window synchronously so the UI can't flash
      // between the click and the watcher's debounce.
      const window = BrowserWindow.fromWebContents(event.sender);
      window?.setBackgroundColor(windowBackgroundColor(resolved));
      return resolved;
    },
  );

  ipcMain.handle("catamorphic:theme-file", () => theme.file);

  // Saving triggers the same file watcher that external edits do, which
  // rebuilds the menu and broadcasts the change to windows.
  ipcMain.handle(
    "catamorphic:keybindings-set",
    (_event, input: unknown): Keybindings => {
      const next = normalizeKeybindings(input);
      keybindings.save(next);
      return next;
    },
  );

  ipcMain.handle("catamorphic:keybindings-file", () => keybindings.file);

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

  // --- GitHub device flow ---
  // The flow lives in the main process: it opens the system browser and
  // polls GitHub, while the renderer only ever sees the short user code and
  // the final connected/failed state. Tokens go straight into the embedded
  // server's GithubService (encrypted via safeStorage before touching disk).
  let deviceFlowGeneration = 0;

  ipcMain.handle("catamorphic:github-connect-start", async () => {
    const grant = await requestDeviceCode(GITHUB_APP);
    const generation = ++deviceFlowGeneration;
    void shell.openExternal(grant.verificationUri);

    const poll = async (): Promise<void> => {
      const started = Date.now();
      let intervalMs = grant.interval * 1000;
      while (Date.now() - started < grant.expiresIn * 1000) {
        // A newer connect attempt or an app shutdown obsoletes this loop.
        if (generation !== deviceFlowGeneration) return;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const server = state.current;
        if (!server) return;
        try {
          const result = await pollDeviceToken(GITHUB_APP, grant.deviceCode);
          if (result.tokens) {
            const status = await server.catamorphic.core.github?.connect(
              identity,
              result.tokens,
            );
            state.broadcast("catamorphic:github-connected", status ?? null);
            return;
          }
          if (result.retryAfter > 0) intervalMs = result.retryAfter * 1000;
        } catch (cause) {
          state.broadcast("catamorphic:github-connected", {
            error:
              cause instanceof GithubAuthError
                ? cause.message
                : "GitHub authorization failed",
          });
          return;
        }
      }
      state.broadcast("catamorphic:github-connected", {
        error: "The GitHub device code expired — try connecting again",
      });
    };
    void poll();

    return {
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
    };
  });

  // Repo access is granted by *installing* the GitHub App, not by the OAuth
  // authorization itself — send users to the installation page where GitHub
  // shows the repository picker.
  ipcMain.handle("catamorphic:github-manage-repos", () => {
    void shell.openExternal(buildInstallationUrl(GITHUB_APP));
  });

  ipcMain.handle("catamorphic:github-disconnect", async () => {
    deviceFlowGeneration += 1;
    const server = state.current;
    if (!server) return;
    await server.catamorphic.core.github?.disconnect(identity);
  });

  // Import runs through IPC (not HTTP) for the same reason project-create
  // does: the destination folder is a desktop-owned filesystem path.
  ipcMain.handle(
    "catamorphic:github-import",
    async (
      _event,
      input: { fullName: string; name?: string; rootPath: string },
    ) => {
      const server = state.current;
      if (!server) throw new Error("Server not running");
      if (!server.catamorphic.core.github) {
        throw new Error("GitHub integration not configured");
      }
      if (!path.isAbsolute(input.rootPath)) {
        throw new Error("rootPath must be an absolute path");
      }
      const project = await server.catamorphic.core.github.importRepo(
        identity,
        {
          fullName: input.fullName,
          name: input.name,
          rootPath: input.rootPath,
        },
      );
      await server.projectRoots.set(project.id, input.rootPath);
      return { id: project.id, name: project.name };
    },
  );

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
