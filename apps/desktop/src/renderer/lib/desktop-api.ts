export interface ServerInfo {
  url: string | null;
  hasCodingAgent: boolean;
}

export type AgentHarness = "ai-sdk" | "claude-code" | "codex";
export type AgentEffort = "low" | "medium" | "high";
export type AgentAuthMode = "local" | "account" | "api-key";

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
}

export interface AgentsData {
  agents: AgentInfo[];
  defaultAgentId: string | null;
}

export interface CreateAgentInput {
  name?: string;
  harness: AgentHarness;
  provider?: "anthropic" | "openai" | "openrouter";
  model?: string;
  effort?: AgentEffort;
  auth?: AgentAuthMode;
  apiKey?: string | null;
}

export interface UpdateAgentInput {
  name?: string;
  provider?: "anthropic" | "openai" | "openrouter";
  model?: string;
  effort?: AgentEffort;
  auth?: AgentAuthMode;
  /** New key; omit to keep the stored one, null to clear it. */
  apiKey?: string | null;
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
  type: "workflows" | "apps" | "chats" | "bookmarks" | "custom";
  title?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
  open?: "tab" | "replace";
  menu?: SidebarMenuEntry[];
}

export interface SidebarConfig {
  sections: SidebarSectionConfig[];
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
  agentSetupStatus: () => Promise<{ claudeCode: boolean; codex: boolean }>;
  agentLogin: (
    id: string,
  ) => Promise<{ started: boolean; command?: string; error?: string }>;
  agentLoginStatus: (id: string) => Promise<boolean>;
  onAgentsChanged: (listener: (data: AgentsData) => void) => () => void;
  onAgentLoginFinished: (
    listener: (result: { agentId: string; ok: boolean }) => void,
  ) => () => void;

  openrouterModels: () => Promise<OpenRouterCatalog>;
  browserImportList: () => Promise<ImportableBrowser[]>;
  browserImportRun: (
    input: BrowserImportRequest,
  ) => Promise<BrowserImportResult>;
  onCloseSurface: (listener: () => void) => () => void;
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
    templateId?: string;
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

  sidebarConfigGet: () => Promise<SidebarConfig>;
  sidebarConfigFile: () => Promise<string>;
  sidebarConfigSource: () => Promise<string>;
  sidebarConfigReset: () => Promise<void>;
  onSidebarConfigChanged: (
    listener: (config: SidebarConfig) => void,
  ) => () => void;
}

declare global {
  interface Window {
    catamorphicDesktop: CatamorphicDesktopApi;
  }
}

export const desktopApi = window.catamorphicDesktop;
