export interface ServerInfo {
  url: string | null;
  hasCodingAgent: boolean;
}

export type AgentHarness = "ai-sdk" | "claude-code" | "codex";
export type AgentEffort = "low" | "medium" | "high";
export type AgentAuthMode = "local" | "account" | "api-key";

/**
 * Which of the profile's MCP connections an agent gets: every current and
 * future connection, or a pinned subset.
 */
export type AgentConnectionsSetting =
  | { mode: "all" }
  | { mode: "picked"; connectionIds: string[] };

export interface AgentInfo {
  id: string;
  name: string;
  harness: AgentHarness;
  provider?: "anthropic" | "openai" | "openrouter";
  model: string;
  effort: AgentEffort;
  auth: AgentAuthMode;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  /** Media kinds this agent's chat composer accepts. */
  accepts: Array<"image" | "document">;
  connections: AgentConnectionsSetting;
}

export interface AgentsData {
  agents: AgentInfo[];
  defaultAgentId: string | null;
}

/**
 * A PROJECT agent: a committed `agents/<slug>.json` definition (ADR 0050),
 * listed for the active project. `consent` gates running it on the user's
 * own credentials; `invalid` marks unusable definitions (shown disabled).
 */
export interface ProjectAgentInfo {
  /** Registry id: `project:<projectId>:<slug>`. */
  id: string;
  projectId: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  model: string | null;
  effort: AgentEffort | null;
  credentialsSource: "profile" | "secret" | "local";
  secretName: string | null;
  connections: string[];
  promptPreview: string | null;
  consent: "not-required" | "none" | "stale" | "ok";
  invalid: string | null;
}

export interface ProjectAgentsData {
  agents: ProjectAgentInfo[];
}

/**
 * A project agent shaped like a roster {@link AgentInfo}, for surfaces
 * that resolve an id to a display name and capabilities (chat identity,
 * switch markers, composer attachment gating).
 */
export function projectAgentAsInfo(agent: ProjectAgentInfo): AgentInfo {
  const harness: AgentHarness =
    agent.kind === "claude-code"
      ? "claude-code"
      : agent.kind === "codex"
        ? "codex"
        : "ai-sdk";
  return {
    id: agent.id,
    name: agent.name,
    harness,
    ...(harness === "ai-sdk" ? { provider: "anthropic" as const } : {}),
    model: agent.model ?? "",
    effort: agent.effort ?? "medium",
    auth: agent.credentialsSource === "secret" ? "api-key" : "local",
    hasApiKey: false,
    apiKeyMasked: null,
    accepts: harness === "codex" ? [] : ["image", "document"],
    connections: { mode: "all" },
  };
}

export interface CreateAgentInput {
  name?: string;
  harness: AgentHarness;
  provider?: "anthropic" | "openai" | "openrouter";
  model?: string;
  effort?: AgentEffort;
  auth?: AgentAuthMode;
  apiKey?: string | null;
  connections?: AgentConnectionsSetting;
}

export interface UpdateAgentInput {
  name?: string;
  provider?: "anthropic" | "openai" | "openrouter";
  model?: string;
  effort?: AgentEffort;
  auth?: AgentAuthMode;
  /** New key; omit to keep the stored one, null to clear it. */
  apiKey?: string | null;
  connections?: AgentConnectionsSetting;
}

/** A profile MCP connection as the renderer sees it (no secret values). */
export interface ConnectionInfo {
  id: string;
  name: string;
  /** Slug the harnesses use as the tool-name prefix (`<serverKey>/<tool>`). */
  serverKey: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headerNames: string[];
  envNames: string[];
  enabled: boolean;
  /** Display icon (https/data), e.g. from the registry entry. */
  iconUrl?: string;
  source:
    | { kind: "manual" }
    | { kind: "registry"; registryName: string }
    | { kind: "plugin"; plugin: string };
  /** Has been through OAuth (tokens on file). */
  authorized: boolean;
}

export interface CreateConnectionInput {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface UpdateConnectionInput {
  name?: string;
  url?: string;
  headers?: Record<string, string> | null;
  command?: string;
  args?: string[];
  env?: Record<string, string> | null;
  enabled?: boolean;
}

export interface ConnectionProbe {
  ok: boolean;
  toolCount?: number;
  toolNames?: string[];
  protocolVersion?: string;
  error?: string;
  /** The server wants a user to authorize (401): offer the OAuth flow. */
  needsAuth?: boolean;
}

export interface ConnectorSearchData {
  registry: Array<{
    name: string;
    displayName: string;
    description: string;
    version?: string;
    repositoryUrl?: string;
    iconUrl?: string;
    /** Published under a DNS-verified vendor namespace (not io.github.*). */
    official: boolean;
    suggested?: {
      transport: string;
      inputs: Array<{
        name: string;
        kind: "header" | "env";
        description?: string;
        required: boolean;
        secret: boolean;
      }>;
    };
  }>;
  plugins: Array<{
    name: string;
    description: string;
    version?: string;
    marketplace: string;
    installed: boolean;
    /** From an Anthropic-maintained marketplace. */
    official: boolean;
    /** Where to read about the plugin (repo / subdirectory). */
    pageUrl?: string;
  }>;
}

export interface InstalledConnectorInfo {
  name: string;
  description: string;
  version?: string;
  marketplace: string;
  connectionIds: string[];
}

/** An MCP Apps view template, ready to mount in a sandboxed iframe. */
export interface McpAppViewData {
  toolKey: string;
  html: string;
  csp: { connectDomains: string[]; resourceDomains: string[] };
  prefersBorder: boolean;
  /** Served document URL the view iframe navigates to. */
  url: string;
}

export interface HarnessModelInfo {
  id: string;
  name: string;
  description?: string;
  /** Versioned model id an alias resolves to (e.g. "sonnet" → "claude-sonnet-5"). */
  resolvedId?: string;
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number;
  free: boolean;
  created: number;
}

export interface OpenRouterCatalog {
  models: OpenRouterModelInfo[];
  /** Current best free model per the catalog heuristic; null if none. */
  bestFreeModelId: string | null;
}

export interface ImportableProfile {
  id: string;
  name: string;
  bookmarkCount: number;
}

export interface ImportableBrowser {
  id: string;
  label: string;
  profiles: ImportableProfile[];
}

export interface BrowserImportRequest {
  browserId: string;
  imports: Array<{
    sourceProfileId: string;
    sourceProfileName: string;
    target: "current" | "new-profile";
  }>;
}

export interface BrowserImportResult {
  bookmarksImported: number;
  profilesCreated: string[];
}

export type GithubConnectResult =
  | { connected: true; login: string }
  | { error: string }
  | null;

export interface Profile {
  id: string;
  name: string;
  color: string;
  projectIds: string[];
  defaultProjectId?: string;
}

export interface ProfilesData {
  profiles: Profile[];
  defaultProfileId: string;
}

export interface SavedCredential {
  id: string;
  origin: string;
  username: string;
}

export interface CredentialWithSecret extends SavedCredential {
  password: string;
}

export interface BrowserSuggestions {
  matches: { url: string; title: string }[];
  inline: string | null;
}

export interface Bookmark {
  id: string;
  label: string;
  url: string;
  folderId?: string;
}

export interface BookmarkFolder {
  id: string;
  label: string;
}

export interface ProjectBookmarks {
  folders: BookmarkFolder[];
  bookmarks: Bookmark[];
}

export interface BookmarksData {
  project: ProjectBookmarks;
  pinned: Bookmark[];
}

export interface BookmarksChange {
  /** Null for profile-wide changes (e.g. a browser import touching pinned). */
  projectId: string | null;
  project: ProjectBookmarks | null;
  profileId: string;
  pinned: Bookmark[];
}

/** Mirror of main/git-view.ts shapes (the renderer never imports main). */
export interface GitChangedFile {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  /** Set when kind is "renamed". */
  previousPath?: string;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  isMain: boolean;
  /** Uncommitted changes in this worktree (staged + unstaged + untracked). */
  changes: GitChangedFile[];
  /** For non-main worktrees: files changed on this branch vs main (3-dot). */
  vsMain?: GitChangedFile[];
}

export interface GitOverview {
  available: boolean;
  worktrees: GitWorktree[];
}

export type GitDiffMode = "uncommitted" | "vs-main";

export interface GitFileDiff {
  path: string;
  before: string;
  after: string;
  binary: boolean;
}

/** Mirror of core's host-neutral PR shapes. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  updatedAt: string;
}

export interface PullRequestFile {
  path: string;
  /** added | modified | removed | renamed | … */
  status: string;
  additions: number;
  deletions: number;
  /** Unified-diff hunk text; null for binary or oversized files. */
  patch: string | null;
  previousPath?: string;
}

export type SidebarAction =
  | "open"
  | "open-tab"
  | "open-here"
  | "copy-url"
  | "pin"
  | "unpin"
  | "rename"
  | "remove";

export interface SidebarMenuEntry {
  label: string;
  action: SidebarAction;
  danger?: boolean;
}

export interface SidebarItem {
  label: string;
  url: string;
  icon?: string;
  open?: "tab" | "replace";
  menu?: SidebarMenuEntry[];
}

export interface SidebarSectionConfig {
  type: "workflows" | "apps" | "chats" | "bookmarks" | "git" | "prs" | "custom";
  title?: string;
  collapsed?: boolean;
  /**
   * Hide the whole section while it has nothing to list. Absent = the
   * per-type default (true for workflows and apps, false elsewhere).
   */
  hideEmpty?: boolean;
  items?: SidebarItem[];
  open?: "tab" | "replace";
  menu?: SidebarMenuEntry[];
}

export interface SidebarConfig {
  sections: SidebarSectionConfig[];
}

/**
 * Which layer of the layered resolution produced the config: this user's
 * per-project override, the project's shared `.catamorphic/sidebar.js`,
 * the profile-global `sidebar.js`, or the built-in default.
 */
export type SidebarLayer = "project-local" | "project" | "profile" | "default";

export interface ResolvedSidebarConfig {
  config: SidebarConfig;
  layer: SidebarLayer;
}

export type ThemeToken =
  | "bg"
  | "bg-raised"
  | "bg-overlay"
  | "bg-inset"
  | "border"
  | "border-strong"
  | "fg"
  | "fg-muted"
  | "fg-faint"
  | "accent"
  | "accent-fg"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "user-tint"
  | "agent-tint";

export type ThemeColors = Record<ThemeToken, string>;

export interface ThemePreset {
  id: string;
  label: string;
  colors: ThemeColors;
}

export interface ThemeConfig {
  preset: string;
  overrides: Partial<ThemeColors>;
}

/** Per-profile app preferences (profiles/<id>/prefs.json). */
export interface AppPrefs {
  notificationSounds: boolean;
  desktopNotifications: boolean;
  sidebarOpen: boolean;
  lastProjectId?: string;
}

export interface ResolvedTheme extends ThemeConfig {
  colors: ThemeColors;
  appearance: "dark" | "light";
}

export interface CatamorphicDesktopApi {
  githubConnectStart: () => Promise<{
    userCode: string;
    verificationUri: string;
  }>;
  githubDisconnect: () => Promise<void>;
  githubManageRepos: () => Promise<void>;
  githubImport: (input: {
    fullName: string;
    name?: string;
    rootPath: string;
  }) => Promise<{ id: string; name: string }>;
  onGithubConnected: (
    listener: (result: GithubConnectResult) => void,
  ) => () => void;
  getServerState: () => Promise<ServerInfo>;
  onServerChanged: (listener: (info: ServerInfo) => void) => () => void;

  windowProfile: () => Promise<string>;
  windowSetProfile: (profileId: string) => Promise<string>;
  openProfileWindow: (profileId: string) => Promise<void>;

  agentsList: () => Promise<AgentsData>;
  agentsCreate: (input: CreateAgentInput) => Promise<AgentInfo>;
  agentsUpdate: (
    id: string,
    patch: UpdateAgentInput,
  ) => Promise<AgentInfo | null>;
  agentsRemove: (id: string) => Promise<boolean>;
  agentsSetDefault: (id: string) => Promise<void>;
  agentModels: (id: string) => Promise<{ models: HarnessModelInfo[] }>;
  projectAgentsList: (projectId: string) => Promise<ProjectAgentsData>;
  projectAgentApprove: (
    projectId: string,
    slug: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  agentSetupStatus: () => Promise<{ claudeCode: boolean; codex: boolean }>;
  agentLogin: (
    id: string,
  ) => Promise<{ started: boolean; command?: string; error?: string }>;
  agentLoginStatus: (id: string) => Promise<boolean>;
  onAgentsChanged: (listener: (data: AgentsData) => void) => () => void;
  onAgentLoginFinished: (
    listener: (result: { agentId: string; ok: boolean }) => void,
  ) => () => void;

  connectionsList: () => Promise<ConnectionInfo[]>;
  connectionsCreate: (input: CreateConnectionInput) => Promise<ConnectionInfo>;
  connectionsUpdate: (
    id: string,
    patch: UpdateConnectionInput,
  ) => Promise<ConnectionInfo | null>;
  connectionsRemove: (id: string) => Promise<boolean>;
  connectionsProbe: (id: string) => Promise<ConnectionProbe>;
  /** Run OAuth for a remote connection (opens the consent page as a tab). */
  connectionsAuthorize: (id: string) => Promise<{ toolCount: number }>;
  connectorsSearch: (query: string) => Promise<ConnectorSearchData>;
  connectorsSearchPlugins: (
    query: string,
  ) => Promise<ConnectorSearchData["plugins"]>;
  connectorsSearchRegistry: (
    query: string,
  ) => Promise<ConnectorSearchData["registry"]>;
  connectorsList: () => Promise<InstalledConnectorInfo[]>;
  connectorsInstallRegistry: (
    registryName: string,
    secrets: Record<string, string>,
  ) => Promise<ConnectionInfo>;
  connectorsInstallPlugin: (
    marketplace: string,
    pluginName: string,
  ) => Promise<InstalledConnectorInfo>;
  connectorsRemove: (name: string) => Promise<boolean>;
  onConnectionsChanged: (
    listener: (connections: ConnectionInfo[]) => void,
  ) => () => void;
  /** Fired after a turn checkpoint moves a project's git state. */
  onGitChanged: (
    listener: (change: { projectId: string }) => void,
  ) => () => void;
  /**
   * Per-project open-workspace snapshot (tabs, chats, ordering) — the
   * renderer owns the shape; main stores opaque JSON.
   */
  workspaceStateGet: (projectId: string) => Promise<unknown>;
  workspaceStateSet: (projectId: string, snapshot: unknown) => Promise<void>;

  /** "server/tool" → ui:// resource uri, for tools declaring app views. */
  mcpAppsUiTools: () => Promise<Record<string, string>>;
  mcpAppsView: (toolKey: string) => Promise<McpAppViewData>;
  mcpAppsCall: (
    viewToolKey: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  openrouterModels: () => Promise<OpenRouterCatalog>;
  browserImportList: () => Promise<ImportableBrowser[]>;
  browserImportRun: (
    input: BrowserImportRequest,
  ) => Promise<BrowserImportResult>;
  onCloseSurface: (listener: () => void) => () => void;
  getPrefs: () => Promise<AppPrefs>;
  setPrefs: (patch: Partial<AppPrefs>) => Promise<AppPrefs>;
  onPrefsChanged: (listener: (prefs: AppPrefs) => void) => () => void;
  windowFocus: () => Promise<void>;
  getKeybindings: () => Promise<Record<string, string>>;
  setKeybindings: (
    bindings: Record<string, string>,
  ) => Promise<Record<string, string>>;
  keybindingsFile: () => Promise<string>;
  onKeybindingsChanged: (
    listener: (bindings: Record<string, string>) => void,
  ) => () => void;
  defaultProjectsDir: () => Promise<string>;
  pickFolder: (opts?: {
    title?: string;
    defaultPath?: string;
  }) => Promise<string | null>;
  createProject: (input: {
    name: string;
    rootPath: string;
    importExisting?: boolean;
  }) => Promise<{ id: string; name: string }>;
  deleteProject: (input: {
    projectId: string;
    trashFolder?: boolean;
  }) => Promise<void>;
  projectRoot: (projectId: string) => Promise<string | null>;
  revealFolder: (folderPath: string) => Promise<void>;

  terminalCreate: (input: {
    projectId?: string;
    cols?: number;
    rows?: number;
  }) => Promise<{ sessionId: string; cwd: string }>;
  terminalWrite: (sessionId: string, data: string) => Promise<void>;
  terminalResize: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
  terminalKill: (sessionId: string) => Promise<void>;
  terminalBuffer: (
    sessionId: string,
  ) => Promise<{ buffer: string; running: boolean } | null>;
  terminalRestoreBuffer: (
    sessionId: string,
  ) => Promise<{ buffer: string } | null>;
  onTerminalBusy: (
    listener: (payload: { sessionId: string; busy: boolean }) => void,
  ) => () => void;
  onTerminalData: (
    listener: (payload: { sessionId: string; data: string }) => void,
  ) => () => void;
  onTerminalExit: (
    listener: (payload: { sessionId: string; exitCode: number }) => void,
  ) => () => void;

  onBridgeRequest: (
    listener: (payload: {
      id: number;
      method: string;
      params: Record<string, unknown>;
    }) => void,
  ) => () => void;
  bridgeRespond: (payload: { id: number; result: unknown }) => void;
  bridgeTakeover: (key: string) => void;

  webviewPreloadPath: () => Promise<string>;
  browserPrepareProfile: (profileId: string) => Promise<string>;
  browserRecordHistory: (input: {
    profileId: string;
    url: string;
    title: string;
  }) => Promise<void>;
  browserRetitleHistory: (input: {
    profileId: string;
    url: string;
    title: string;
  }) => Promise<void>;
  browserRecentHistory: (input: {
    profileId: string;
    limit?: number;
  }) => Promise<{ url: string; title: string }[]>;
  browserSuggest: (input: {
    profileId: string;
    query: string;
  }) => Promise<BrowserSuggestions>;
  onBrowserOpenUrl: (listener: (url: string) => void) => () => void;
  /** Close browser tabs whose URL starts with `prefix` (OAuth callback). */
  onBrowserCloseUrl: (listener: (prefix: string) => void) => () => void;
  onBrowserFocusAddress: (
    listener: (webContentsId: number) => void,
  ) => () => void;
  onBrowserGuestKey: (
    listener: (key: {
      webContentsId: number;
      key: string;
      meta: boolean;
      control: boolean;
      alt: boolean;
      shift: boolean;
    }) => void,
  ) => () => void;

  profilesList: () => Promise<ProfilesData>;
  profilesCreate: (name: string) => Promise<Profile>;
  profilesUpdate: (
    id: string,
    patch: { name?: string; color?: string; defaultProjectId?: string },
  ) => Promise<Profile | undefined>;
  profilesSetDefault: (id: string) => Promise<void>;
  profilesRemove: (id: string) => Promise<boolean>;
  profilesClaimProject: (profileId: string, projectId: string) => Promise<void>;
  profilesForProject: (projectId: string) => Promise<Profile>;
  profilesReleaseProject: (projectId: string) => Promise<void>;
  onProfilesChanged: (listener: (data: ProfilesData) => void) => () => void;

  vaultList: (input: {
    profileId: string;
    origin?: string;
  }) => Promise<SavedCredential[]>;
  vaultReveal: (input: {
    profileId: string;
    id: string;
  }) => Promise<CredentialWithSecret | null>;
  vaultSave: (input: {
    profileId: string;
    origin: string;
    username: string;
    password: string;
  }) => Promise<SavedCredential>;
  vaultRemove: (input: { profileId: string; id: string }) => Promise<void>;
  deviceAuthAvailable: () => Promise<boolean>;

  bookmarksGet: (input: {
    projectId: string;
    profileId: string;
  }) => Promise<BookmarksData>;
  bookmarksAdd: (input: {
    projectId: string;
    profileId: string;
    label: string;
    url: string;
    folderId?: string;
  }) => Promise<Bookmark>;
  bookmarksAddFolder: (input: {
    projectId: string;
    profileId: string;
    label: string;
  }) => Promise<BookmarkFolder>;
  bookmarksUpdate: (input: {
    projectId: string;
    profileId: string;
    id: string;
    label?: string;
    url?: string;
    folderId?: string | null;
  }) => Promise<void>;
  bookmarksRemove: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }) => Promise<void>;
  bookmarksPin: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }) => Promise<void>;
  bookmarksUnpin: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }) => Promise<void>;
  bookmarksRemovePinned: (input: {
    projectId: string;
    profileId: string;
    id: string;
  }) => Promise<void>;
  bookmarksRename: (input: {
    projectId: string;
    profileId: string;
    id: string;
    label: string;
  }) => Promise<void>;
  onBookmarksChanged: (listener: (data: BookmarksChange) => void) => () => void;

  getTheme: () => Promise<ResolvedTheme>;
  setTheme: (config: ThemeConfig) => Promise<ResolvedTheme>;
  themePresets: () => Promise<ThemePreset[]>;
  themeFile: () => Promise<string>;
  onThemeChanged: (listener: (theme: ResolvedTheme) => void) => () => void;

  gitOverview: (projectId: string) => Promise<GitOverview>;
  gitFileDiff: (
    projectId: string,
    worktreePath: string,
    filePath: string,
    mode: GitDiffMode,
  ) => Promise<GitFileDiff>;
  prList: (projectId: string) => Promise<PullRequestSummary[]>;
  prFiles: (projectId: string, number: number) => Promise<PullRequestFile[]>;

  sidebarConfigGet: (projectId?: string) => Promise<ResolvedSidebarConfig>;
  sidebarConfigFile: () => Promise<string>;
  sidebarConfigSource: () => Promise<string>;
  sidebarConfigReset: () => Promise<void>;
  /** Change signal only — refetch with the active project to resolve. */
  onSidebarConfigChanged: (listener: () => void) => () => void;
}

declare global {
  interface Window {
    catamorphicDesktop: CatamorphicDesktopApi;
  }
}

export const desktopApi = window.catamorphicDesktop;
