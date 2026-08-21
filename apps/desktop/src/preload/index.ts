import { contextBridge, ipcRenderer, webUtils } from "electron";

export interface ServerInfo {
  url: string | null;
  hasCodingAgent: boolean;
}

const api = {
  getServerState: (): Promise<ServerInfo> =>
    ipcRenderer.invoke("catamorphic:server-state"),

  /**
   * Absolute filesystem path of a pasted/dropped File, "" when it has none
   * (clipboard bitmaps, synthetic Files). Lets the composer attach any
   * file at least as a path pill the agent can read itself.
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },

  // --- window ↔ profile ---
  windowProfile: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:window-profile"),
  windowSetProfile: (profileId: string): Promise<string> =>
    ipcRenderer.invoke("catamorphic:window-set-profile", profileId),
  openProfileWindow: (profileId: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:open-profile-window", profileId),

  // --- per-profile agents ---
  agentsList: (): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:agents-list"),
  agentsCreate: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:agents-create", input),
  agentsUpdate: (id: string, patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:agents-update", id, patch),
  agentsRemove: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("catamorphic:agents-remove", id),
  agentsSetDefault: (id: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:agents-set-default", id),
  agentModels: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:agent-models", id),
  projectAgentsList: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:project-agents-list", projectId),
  projectAgentApprove: (
    projectId: string,
    slug: string,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("catamorphic:project-agent-approve", projectId, slug),
  agentSetupStatus: (): Promise<{ claudeCode: boolean; codex: boolean }> =>
    ipcRenderer.invoke("catamorphic:agent-setup-status"),
  agentLogin: (
    id: string,
  ): Promise<{ started: boolean; command?: string; error?: string }> =>
    ipcRenderer.invoke("catamorphic:agent-login", id),
  agentLoginStatus: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("catamorphic:agent-login-status", id),
  /** Proactive auth probe: what is knowably wrong before a send. */
  agentAuthHealth: (id: string): Promise<"ok" | "expired" | "missing"> =>
    ipcRenderer.invoke("catamorphic:agent-auth-health", id),
  /** Fired on OS wake — sessions may have expired; re-probe. */
  onAgentAuthMaybeChanged: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("catamorphic:agent-auth-maybe-changed", handler);
    return () =>
      ipcRenderer.removeListener(
        "catamorphic:agent-auth-maybe-changed",
        handler,
      );
  },
  onAgentsChanged: (listener: (data: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on("catamorphic:agents-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:agents-changed", handler);
  },
  onAgentLoginFinished: (
    listener: (result: { agentId: string; ok: boolean }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      result: { agentId: string; ok: boolean },
    ) => listener(result);
    ipcRenderer.on("catamorphic:agent-login-finished", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:agent-login-finished", handler);
  },

  // --- profile MCP connections + connectors ---
  connectionsList: (): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connections-list"),
  connectionsCreate: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connections-create", input),
  connectionsUpdate: (id: string, patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connections-update", id, patch),
  connectionsRemove: (id: string): Promise<boolean> =>
    ipcRenderer.invoke("catamorphic:connections-remove", id),
  projectWorkflowTools: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:project-workflow-tools", projectId),
  connectionsSetPolicy: (id: string, policy: unknown): Promise<boolean> =>
    ipcRenderer.invoke("catamorphic:connections-set-policy", id, policy),
  connectionsProbe: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connections-probe", id),
  connectionsAuthorize: (id: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connections-authorize", id),
  connectorsSearch: (query: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connectors-search", query),
  connectorsSearchPlugins: (query: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connectors-search-plugins", query),
  connectorsSearchRegistry: (query: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connectors-search-registry", query),
  connectorsList: (): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:connectors-list"),
  connectorsInstallRegistry: (
    registryName: string,
    secrets: Record<string, string>,
  ): Promise<unknown> =>
    ipcRenderer.invoke(
      "catamorphic:connectors-install-registry",
      registryName,
      secrets,
    ),
  connectorsInstallPlugin: (
    marketplace: string,
    pluginName: string,
  ): Promise<unknown> =>
    ipcRenderer.invoke(
      "catamorphic:connectors-install-plugin",
      marketplace,
      pluginName,
    ),
  connectorsRemove: (name: string): Promise<boolean> =>
    ipcRenderer.invoke("catamorphic:connectors-remove", name),
  onConnectionsChanged: (listener: (data: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on("catamorphic:connections-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:connections-changed", handler);
  },
  workspaceStateGet: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:workspace-state-get", projectId),
  workspaceStateSet: (projectId: string, snapshot: unknown): Promise<void> =>
    ipcRenderer.invoke("catamorphic:workspace-state-set", projectId, snapshot),
  onGitChanged: (listener: (data: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on("catamorphic:git-changed", handler);
    return () => ipcRenderer.removeListener("catamorphic:git-changed", handler);
  },

  // --- MCP Apps (embedded views for connection tools) ---
  mcpAppsUiTools: (): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:mcp-apps-ui-tools"),
  mcpAppsView: (toolKey: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:mcp-apps-view", toolKey),
  mcpAppsCall: (
    viewToolKey: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> =>
    ipcRenderer.invoke(
      "catamorphic:mcp-apps-call",
      viewToolKey,
      toolName,
      args,
    ),

  // --- OpenRouter catalog (searchable model selector, best-free default) ---
  openrouterModels: (): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:openrouter-models"),

  // --- import from other browsers ---
  browserImportList: (): Promise<unknown[]> =>
    ipcRenderer.invoke("catamorphic:browser-import-list"),
  browserImportRun: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:browser-import-run", input),

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
  // Remote projects (ADR 0055).
  remoteParseLink: (link: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-parse-link", link),
  remoteConnect: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-connect", input),
  remoteStatus: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-status", projectId),
  remoteSync: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-sync", projectId),
  remoteShip: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-ship", projectId),
  remoteHistory: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-history", input),
  remoteReadVersion: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-read-version", input),
  remotePublish: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-publish", input),
  remotePropose: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:remote-propose", input),
  remoteRenew: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:remote-renew", projectId),
  remoteDisconnect: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:remote-disconnect", projectId),
  remoteTakePendingLink: (): Promise<string | null> =>
    ipcRenderer.invoke("catamorphic:remote-take-pending-link"),
  onConnectLink: (listener: (link: string) => void): (() => void) => {
    const handler = (_event: unknown, link: string) => listener(link);
    ipcRenderer.on("catamorphic:connect-link", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:connect-link", handler);
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
  // --- per-profile app preferences (notifications) ---
  getPrefs: (): Promise<unknown> => ipcRenderer.invoke("catamorphic:prefs-get"),
  setPrefs: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:prefs-set", patch),
  onPrefsChanged: (listener: (prefs: unknown) => void): (() => void) => {
    const handler = (_event: unknown, prefs: unknown) => listener(prefs);
    ipcRenderer.on("catamorphic:prefs-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:prefs-changed", handler);
  },
  windowFocus: (): Promise<void> =>
    ipcRenderer.invoke("catamorphic:window-focus"),

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
  browserRecentHistory: (input: {
    profileId: string;
    limit?: number;
  }): Promise<{ url: string; title: string }[]> =>
    ipcRenderer.invoke("catamorphic:browser-history-recent", input),
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
  onBrowserCloseUrl: (listener: (prefix: string) => void): (() => void) => {
    const handler = (_event: unknown, payload: { prefix: string }) =>
      listener(payload.prefix);
    ipcRenderer.on("catamorphic:browser-close-url", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:browser-close-url", handler);
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
    const handler = (
      _event: unknown,
      payload: Parameters<typeof listener>[0],
    ) => listener(payload);
    ipcRenderer.on("catamorphic:browser-guest-key", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:browser-guest-key", handler);
  },

  // --- terminal tabs (PTY sessions live in main; see main/terminal.ts) ---
  terminalCreate: (input: {
    projectId?: string;
    cols?: number;
    rows?: number;
  }): Promise<{ sessionId: string; cwd: string }> =>
    ipcRenderer.invoke("catamorphic:terminal-create", input),
  terminalWrite: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:terminal-write", sessionId, data),
  terminalResize: (
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> =>
    ipcRenderer.invoke("catamorphic:terminal-resize", sessionId, cols, rows),
  terminalKill: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:terminal-kill", sessionId),
  onTerminalData: (
    listener: (payload: { sessionId: string; data: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { sessionId: string; data: string },
    ) => listener(payload);
    ipcRenderer.on("catamorphic:terminal-data", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:terminal-data", handler);
  },
  terminalBuffer: (
    sessionId: string,
  ): Promise<{ buffer: string; running: boolean } | null> =>
    ipcRenderer.invoke("catamorphic:terminal-buffer", sessionId),
  terminalRestoreBuffer: (
    sessionId: string,
  ): Promise<{ buffer: string } | null> =>
    ipcRenderer.invoke("catamorphic:terminal-restore-buffer", sessionId),
  onTerminalBusy: (
    listener: (payload: { sessionId: string; busy: boolean }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { sessionId: string; busy: boolean },
    ) => listener(payload);
    ipcRenderer.on("catamorphic:terminal-busy", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:terminal-busy", handler);
  },
  onTerminalExit: (
    listener: (payload: { sessionId: string; exitCode: number }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { sessionId: string; exitCode: number },
    ) => listener(payload);
    ipcRenderer.on("catamorphic:terminal-exit", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:terminal-exit", handler);
  },

  // --- agent workspace bridge ---
  onBridgeRequest: (
    listener: (payload: {
      id: number;
      method: string;
      params: Record<string, unknown>;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: { id: number; method: string; params: Record<string, unknown> },
    ) => listener(payload);
    ipcRenderer.on("catamorphic:bridge-request", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:bridge-request", handler);
  },
  bridgeRespond: (payload: { id: number; result: unknown }): void =>
    ipcRenderer.send("catamorphic:bridge-response", payload),
  bridgeTakeover: (key: string): void =>
    ipcRenderer.send("catamorphic:bridge-takeover", { key }),

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
  profilesClaimProject: (profileId: string, projectId: string): Promise<void> =>
    ipcRenderer.invoke(
      "catamorphic:profiles-claim-project",
      profileId,
      projectId,
    ),
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
  }): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:bookmarks-get", input),
  bookmarksAdd: (input: {
    projectId: string;
    profileId: string;
    label: string;
    url: string;
    folderId?: string;
  }): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:bookmarks-add", input),
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
  }): Promise<void> =>
    ipcRenderer.invoke("catamorphic:bookmarks-update", input),
  bookmarksRemove: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }): Promise<void> =>
    ipcRenderer.invoke("catamorphic:bookmarks-remove", input),
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

  // --- git + pull requests (dev surfaces) ---
  gitOverview: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:git-overview", projectId),
  gitFileDiff: (
    projectId: string,
    worktreePath: string,
    filePath: string,
    mode: "uncommitted" | "vs-main",
  ): Promise<unknown> =>
    ipcRenderer.invoke(
      "catamorphic:git-file-diff",
      projectId,
      worktreePath,
      filePath,
      mode,
    ),
  prList: (projectId: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:pr-list", projectId),
  prFiles: (projectId: string, number: number): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:pr-files", projectId, number),

  // --- sidebar config ---
  sidebarConfigGet: (projectId?: string): Promise<unknown> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-get", projectId),
  sidebarConfigFile: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-file"),
  sidebarConfigSource: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-source"),
  sidebarConfigReset: (): Promise<void> =>
    ipcRenderer.invoke("catamorphic:sidebar-config-reset"),
  // The changed event carries no config: the resolved layers depend on the
  // renderer's active project, so the renderer refetches on the signal.
  onSidebarConfigChanged: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("catamorphic:sidebar-config-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:sidebar-config-changed", handler);
  },
};

export type CatamorphicDesktopApi = typeof api;

contextBridge.exposeInMainWorld("catamorphicDesktop", api);
