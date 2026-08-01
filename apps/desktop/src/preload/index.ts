import { contextBridge, ipcRenderer } from "electron";

export interface ServerInfo {
  url: string | null;
  hasCodingAgent: boolean;
}

const api = {
  getServerState: (): Promise<ServerInfo> =>
    ipcRenderer.invoke("catamorphic:server-state"),
  getSettings: () => ipcRenderer.invoke("catamorphic:settings-get"),
  setSettings: (input: unknown) =>
    ipcRenderer.invoke("catamorphic:settings-set", input),
  devWindow: (action: string, width?: number, height?: number) =>
    ipcRenderer.invoke("catamorphic:dev-window", action, width, height),
  defaultProjectsDir: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:default-projects-dir"),
  pickFolder: (opts?: {
    title?: string;
    defaultPath?: string;
  }): Promise<string | null> =>
    ipcRenderer.invoke("catamorphic:pick-folder", opts),
  createProject: (input: {
    name: string;
    rootPath: string;
    templateId?: string;
    importExisting?: boolean;
  }): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke("catamorphic:project-create", input),
  deleteProject: (input: {
    projectId: string;
    trashFolder?: boolean;
  }): Promise<void> => ipcRenderer.invoke("catamorphic:project-delete", input),
  projectRoot: (projectId: string): Promise<string | null> =>
    ipcRenderer.invoke("catamorphic:project-root", projectId),
  revealFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:reveal-folder", folderPath),
  githubConnectStart: (): Promise<{
    userCode: string;
    verificationUri: string;
  }> => ipcRenderer.invoke("catamorphic:github-connect-start"),
  githubDisconnect: (): Promise<void> =>
    ipcRenderer.invoke("catamorphic:github-disconnect"),
  githubManageRepos: (): Promise<void> =>
    ipcRenderer.invoke("catamorphic:github-manage-repos"),
  githubImport: (input: {
    fullName: string;
    name?: string;
    rootPath: string;
  }): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke("catamorphic:github-import", input),
  onGithubConnected: (listener: (result: unknown) => void): (() => void) => {
    const handler = (_event: unknown, result: unknown) => listener(result);
    ipcRenderer.on("catamorphic:github-connected", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:github-connected", handler);
  },
  getKeybindings: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke("catamorphic:keybindings-get"),
  setKeybindings: (
    bindings: Record<string, string>,
  ): Promise<Record<string, string>> =>
    ipcRenderer.invoke("catamorphic:keybindings-set", bindings),
  keybindingsFile: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:keybindings-file"),
  onKeybindingsChanged: (
    listener: (bindings: Record<string, string>) => void,
  ): (() => void) => {
    const handler = (_event: unknown, bindings: Record<string, string>) =>
      listener(bindings);
    ipcRenderer.on("catamorphic:keybindings-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:keybindings-changed", handler);
  },
  getTheme: (): Promise<unknown> => ipcRenderer.invoke("catamorphic:theme-get"),
  setTheme: (config: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:theme-set", config),
  themePresets: (): Promise<unknown[]> =>
    ipcRenderer.invoke("catamorphic:theme-presets"),
  themeFile: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:theme-file"),
  onThemeChanged: (listener: (theme: unknown) => void): (() => void) => {
    const handler = (_event: unknown, theme: unknown) => listener(theme);
    ipcRenderer.on("catamorphic:theme-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:theme-changed", handler);
  },
  onCloseSurface: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("catamorphic:close-surface", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:close-surface", handler);
  },
  onServerChanged: (listener: (info: ServerInfo) => void): (() => void) => {
    const handler = (_event: unknown, info: ServerInfo) => listener(info);
    ipcRenderer.on("catamorphic:server-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:server-changed", handler);
  },

  // --- browser tabs ---
  webviewPreloadPath: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:webview-preload"),
  browserPrepareProfile: (profileId: string): Promise<string> =>
    ipcRenderer.invoke("catamorphic:browser-prepare-profile", profileId),
  browserRecordHistory: (input: {
    profileId: string;
    url: string;
    title: string;
  }): Promise<void> =>
    ipcRenderer.invoke("catamorphic:browser-history-record", input),
  browserRetitleHistory: (input: {
    profileId: string;
    url: string;
    title: string;
  }): Promise<void> =>
    ipcRenderer.invoke("catamorphic:browser-history-retitle", input),
  browserSuggest: (input: {
    profileId: string;
    query: string;
  }): Promise<{
    matches: { url: string; title: string }[];
    inline: string | null;
  }> => ipcRenderer.invoke("catamorphic:browser-suggest", input),
  onBrowserOpenUrl: (listener: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, payload: { url: string }) =>
      listener(payload.url);
    ipcRenderer.on("catamorphic:browser-open-url", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:browser-open-url", handler);
  },
  onBrowserFocusAddress: (
    listener: (webContentsId: number) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: { webContentsId: number }) =>
      listener(payload.webContentsId);
    ipcRenderer.on("catamorphic:browser-focus-address", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:browser-focus-address", handler);
  },
  onBrowserGuestKey: (
    listener: (key: {
      webContentsId: number;
      key: string;
      meta: boolean;
      control: boolean;
      alt: boolean;
      shift: boolean;
    }) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: Parameters<typeof listener>[0]) =>
      listener(payload);
    ipcRenderer.on("catamorphic:browser-guest-key", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:browser-guest-key", handler);
  },

  // --- profiles ---
  profilesList: (): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:profiles-list"),
  profilesCreate: (name: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:profiles-create", name),
  profilesUpdate: (
    id: string,
    patch: { name?: string; color?: string; defaultProjectId?: string },
  ): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:profiles-update", id, patch),
  profilesSetDefault: (id: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:profiles-set-default", id),
  profilesRemove: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("catamorphic:profiles-remove", id),
  profilesClaimProject: (
    profileId: string,
    projectId: string,
  ): Promise<void> =>
    ipcRenderer.invoke("catamorphic:profiles-claim-project", profileId, projectId),
  profilesForProject: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:profiles-for-project", projectId),
  profilesReleaseProject: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:profiles-release-project", projectId),
  onProfilesChanged: (listener: (data: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on("catamorphic:profiles-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:profiles-changed", handler);
  },

  // --- password vault ---
  vaultList: (input: {
    profileId: string;
    origin?: string;
  }): Promise<unknown[]> => ipcRenderer.invoke("catamorphic:vault-list", input),
  vaultReveal: (input: { profileId: string; id: string }): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:vault-reveal", input),
  vaultSave: (input: {
    profileId: string;
    origin: string;
    username: string;
    password: string;
  }): Promise<unknown> => ipcRenderer.invoke("catamorphic:vault-save", input),
  vaultRemove: (input: { profileId: string; id: string }): Promise<void> =>
    ipcRenderer.invoke("catamorphic:vault-remove", input),
  deviceAuthAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke("catamorphic:device-auth-available"),

  // --- bookmarks ---
  bookmarksGet: (input: {
    projectId: string;
    profileId: string;
  }): Promise<unknown> => ipcRenderer.invoke("catamorphic:bookmarks-get", input),
  bookmarksAdd: (input: {
    projectId: string;
    profileId: string;
    label: string;
    url: string;
    folderId?: string;
  }): Promise<unknown> => ipcRenderer.invoke("catamorphic:bookmarks-add", input),
  bookmarksAddFolder: (input: {
    projectId: string;
    profileId: string;
    label: string;
  }): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:bookmarks-add-folder", input),
  bookmarksUpdate: (input: {
    projectId: string;
    profileId: string;
    id: string;
    label?: string;
    url?: string;
    folderId?: string | null;
  }): Promise<void> => ipcRenderer.invoke("catamorphic:bookmarks-update", input),
  bookmarksRemove: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }): Promise<void> => ipcRenderer.invoke("catamorphic:bookmarks-remove", input),
  bookmarksPin: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }): Promise<void> => ipcRenderer.invoke("catamorphic:bookmarks-pin", input),
  bookmarksUnpin: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }): Promise<void> => ipcRenderer.invoke("catamorphic:bookmarks-unpin", input),
  bookmarksRemovePinned: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }): Promise<void> =>
    ipcRenderer.invoke("catamorphic:bookmarks-remove-pinned", input),
  bookmarksRename: (input: {
    projectId: string;
    profileId: string;
    id: string;
    label: string;
  }): Promise<void> =>
    ipcRenderer.invoke("catamorphic:bookmarks-rename", input),
  onBookmarksChanged: (listener: (data: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on("catamorphic:bookmarks-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:bookmarks-changed", handler);
  },

  // --- sidebar config ---
  sidebarConfigGet: (): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-get"),
  sidebarConfigFile: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-file"),
  sidebarConfigSource: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-source"),
  sidebarConfigReset: (): Promise<void> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-reset"),
  onSidebarConfigChanged: (listener: (config: unknown) => void): (() => void) => {
    const handler = (_event: unknown, config: unknown) => listener(config);
    ipcRenderer.on("catamorphic:sidebar-config-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:sidebar-config-changed", handler);
  },
};

export type CatamorphicDesktopApi = typeof api;

contextBridge.exposeInMainWorld("catamorphicDesktop", api);
