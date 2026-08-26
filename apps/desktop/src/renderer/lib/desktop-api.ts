import type { UsageSummary } from "../../shared/usage.js";

export type { UsageSummary };

export interface ServerInfo {
  url: string | null;
  hasCodingAgent: boolean;
}

export interface SessionCheckoutInfo {
  sessionId: string;
  kind: "managed" | "external";
  branch: string | null;
}

export type AgentHarness = "ai-sdk" | "claude-code" | "codex";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentAuthMode = "local" | "account" | "api-key";

/**
 * Normalized operating mode (ADR 0056), mapped per harness — Claude Code
 * permission modes, Codex sandbox modes. Not applicable to the sandboxed
 * built-in harness.
 */
export type AgentMode = "read-only" | "edit" | "full-access";
export type AgentCoordinationStrategy =
  | "shared-first"
  | "isolate-on-contention"
  | "isolation-required";

/**
 * Which of the profile's MCP connections an agent gets: every current and
 * future connection, or a pinned subset.
 */
export type AgentConnectionsSetting =
  | { mode: "all" }
  | { mode: "picked"; connectionIds: string[] };

/** Which skills an agent is offered: every skill, or a pinned set of names. */
export type AgentSkillsSetting =
  | { mode: "all" }
  | { mode: "picked"; names: string[] };

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
  /** The agent's own main prompt ("" when none). */
  instructions: string;
  mode: AgentMode;
  coordination: AgentCoordinationStrategy;
  /** Claude Code auto-memory — opt-in, default off (others ignore it). */
  memory: boolean;
  connections: AgentConnectionsSetting;
  skills: AgentSkillsSetting;
  /** Per-connection tool policies layered on the profile's (by id). */
  toolPolicies: Record<string, McpToolPolicy>;
}

export interface AgentsData {
  agents: AgentInfo[];
  defaultAgentId: string | null;
  /** This user's per-project default overrides: project id → agent id. */
  projectDefaults: Record<string, string>;
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
  /** Normalized operating mode; null = the "edit" default. */
  mode: AgentMode | null;
  /** Checkout-coordination doctrine; null means shared-first. */
  coordination: AgentCoordinationStrategy | null;
  /** Claude Code auto-memory; null = the definition doesn't say (off). */
  memory: boolean | null;
  credentialsSource: "profile" | "secret" | "local";
  secretName: string | null;
  /** Declared connector names — enforced by name match (ADR 0056). */
  connections: string[];
  /** Picked skill names; null = every skill. */
  skills: string[] | null;
  promptPreview: string | null;
  consent: "not-required" | "none" | "stale" | "ok";
  invalid: string | null;
}

export interface ProjectAgentsData {
  agents: ProjectAgentInfo[];
  /** The project's committed default agent slug, when declared. */
  projectDefaultSlug: string | null;
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
    instructions: "",
    mode: agent.mode ?? "edit",
    coordination: agent.coordination ?? "shared-first",
    memory: agent.memory === true,
    connections: { mode: "all" },
    skills: agent.skills
      ? { mode: "picked", names: agent.skills }
      : { mode: "all" },
    toolPolicies: {},
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
  instructions?: string;
  mode?: AgentMode;
  coordination?: AgentCoordinationStrategy;
  memory?: boolean;
  connections?: AgentConnectionsSetting;
  skills?: AgentSkillsSetting;
}

export interface UpdateAgentInput {
  name?: string;
  provider?: "anthropic" | "openai" | "openrouter";
  model?: string;
  effort?: AgentEffort;
  auth?: AgentAuthMode;
  /** New key; omit to keep the stored one, null to clear it. */
  apiKey?: string | null;
  /** New instructions; "" clears them. */
  instructions?: string;
  mode?: AgentMode;
  coordination?: AgentCoordinationStrategy;
  memory?: boolean;
  connections?: AgentConnectionsSetting;
  skills?: AgentSkillsSetting;
  /** Per-connection tool policies (null clears). */
  toolPolicies?: Record<string, McpToolPolicy> | null;
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
  /** The profile's ceiling for this connection's tools (undefined = auto). */
  toolPolicy?: McpToolPolicy;
  /** A ceiling set by whoever provisioned the connection (an org sharing
   * a credential); layer zero, read-only here. */
  ceiling?: { policy: McpToolPolicy; source: string };
  /** Tools last seen on the server. */
  tools?: Array<{
    name: string;
    description: string;
    annotations?: ToolAnnotations;
  }>;
}

export type ToolPermission = "allow" | "ask" | "deny";
export interface McpToolPolicy {
  default?: ToolPermission | "auto";
  tools?: Record<string, ToolPermission>;
}
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
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
  ceiling?: { policy: McpToolPolicy; source: string };
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
  tools?: Array<{
    name: string;
    description: string;
    annotations?: ToolAnnotations;
  }>;
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

// --- Remote projects (ADR 0055) ---
export interface ConnectLink {
  serverUrl: string;
  remoteProjectId: string;
  remoteProjectName?: string;
}
export interface RemoteCapabilities {
  builder: boolean;
  source: { remoteUrl: string; defaultBranch: string } | null;
  permissions: Array<"memberships:manage" | "roles:manage">;
  agents: string[];
  documents: Array<{ path: string; access: "read" | "write" }>;
  features: {
    publications: "public" | "members" | false;
    proposals: boolean;
    proposalsOpenPullRequests: boolean;
    mcp: boolean;
    agentSessions: boolean;
    storeUploadMaxBytes: number;
  };
}
export interface RemoteSyncReport {
  pulled: string[];
  removed: string[];
  conflicts: Array<{ path: string; serverCopy: string; serverVersion: number }>;
  unchanged: number;
}
export interface RemoteShipReport {
  shipped: string[];
  deleted: string[];
  conflicts: Array<{
    path: string;
    serverCopy: string;
    currentVersion: number;
  }>;
  notShippable: string[];
  failed: Array<{ path: string; error: string }>;
}
export interface RemoteProjectStatus {
  serverUrl: string;
  remoteProjectId: string;
  remoteProjectName: string;
  lastSyncAt: string | null;
  capabilities?: RemoteCapabilities;
  connection: {
    state: "connected" | "sign_in_required" | "access_removed" | "unreachable";
    checkedAt: string;
    message: string;
  };
  local: { modified: string[]; deleted: string[]; programEdits: string[] };
}
export interface RemoteDocumentVersion {
  version: number;
  deleted: boolean;
  contentType: string;
  size: number;
  writtenBy: string;
  writtenAt: string;
}

export interface RemoteProjectRole {
  slug: string;
  definition?: { name: string };
}

export interface RemoteProjectMember {
  externalUserId: string;
  name: string | null;
  email: string | null;
  roles: string[];
}

export interface RemoteProjectAccessRequest {
  id: string;
  externalUserId: string;
  email: string;
  emailVerified: boolean;
  status: string;
  requestedAt: string;
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
  type:
    | "workflows"
    | "apps"
    | "chats"
    | "bookmarks"
    | "git"
    | "prs"
    | "remote"
    | "custom";
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
  /** Absolute path of a pasted/dropped File; "" when it has none. */
  pathForFile: (file: File) => string;
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
  /** Continue on mobile: mint a QR pairing (single-use, ~2 min). */
  mobilePairingStart: (context?: {
    projectId?: string;
    sessionId?: string;
  }) => Promise<{
    url: string;
    alternates: string[];
    expiresAt: string;
    /** Same project on its linked remote server's PWA origin. */
    remote?: { url: string; host: string };
  }>;
  /** Mark a just-created session incognito (desktop-local, ADR 0062). */
  sessionSetIncognito: (sessionId: string, incognito: boolean) => Promise<void>;
  /** Project policy (ADR 0062): may members open incognito chats here? */
  projectAllowIncognito: (projectId: string) => Promise<boolean>;
  /** This profile's paired phones (for the management list). */
  mobilePairingDevices: () => Promise<
    Array<{
      id: string;
      label: string;
      createdAt: string;
      lastSeenAt: string | null;
    }>
  >;
  /** Cut a paired phone off; its token dies on the next request. */
  mobilePairingRevoke: (deviceId: string) => Promise<boolean>;
  remoteParseLink: (link: string) => Promise<ConnectLink | null>;
  remoteConnect: (input: {
    serverUrl: string;
    remoteProjectId: string;
    name: string;
    rootPath: string;
  }) => Promise<{ id: string; name: string; report: RemoteSyncReport }>;
  remoteStatus: (projectId: string) => Promise<RemoteProjectStatus | null>;
  remoteMembers: (projectId: string) => Promise<{
    roles: RemoteProjectRole[];
    members: RemoteProjectMember[];
    requests: RemoteProjectAccessRequest[];
  }>;
  remoteAdmissionDecide: (input: {
    projectId: string;
    requestId: string;
    decision: "approved" | "denied";
  }) => Promise<void>;
  remoteMemberSetRoles: (input: {
    projectId: string;
    externalUserId: string;
    roles: string[];
  }) => Promise<void>;
  remoteMemberInvite: (input: {
    projectId: string;
    email?: string;
    roles: string[];
  }) => Promise<{
    id: string;
    expiresAt: string;
    connectLinks: string[];
    webLinks: string[];
  }>;
  remoteSync: (projectId: string) => Promise<RemoteSyncReport>;
  remoteShip: (projectId: string) => Promise<RemoteShipReport>;
  remoteHistory: (input: {
    projectId: string;
    path: string;
  }) => Promise<RemoteDocumentVersion[]>;
  remoteReadVersion: (input: {
    projectId: string;
    path: string;
    version: number;
  }) => Promise<{
    entry: { path: string; contentType: string; version?: number };
    text: string | null;
  }>;
  remotePublish: (input: {
    projectId: string;
    path: string;
    audience: "public" | "members";
  }) => Promise<{
    slug: string;
    url: string;
    absoluteUrl: string;
    audience: string;
  }>;
  remotePropose: (input: {
    projectId: string;
    title: string;
    body?: string;
  }) => Promise<{
    branch: string;
    pullRequest?: { url: string; number: number };
  }>;
  remoteReconnect: (projectId: string) => Promise<{ ok: true }>;
  remoteDisconnect: (projectId: string) => Promise<void>;
  remoteTakePendingLink: () => Promise<string | null>;
  onConnectLink: (listener: (link: string) => void) => () => void;
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
  /** Set (null = clear) this user's per-project default-agent override. */
  agentsSetProjectDefault: (
    projectId: string,
    agentId: string | null,
  ) => Promise<void>;
  /** Set (null = clear) the project's committed default agent slug. */
  projectAgentsSetDefault: (
    projectId: string,
    slug: string | null,
  ) => Promise<void>;
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
  agentAuthHealth: (
    id: string,
  ) => Promise<{ health: "ok" | "expired" | "missing"; reauth: boolean }>;
  usageSummary: (days: number) => Promise<UsageSummary>;
  agentCommands: (
    projectId: string,
    agentId: string,
  ) => Promise<
    Array<{ name: string; description: string; argumentHint: string }>
  >;
  onAgentAuthMaybeChanged: (listener: () => void) => () => void;
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
  /** Tools of the project's workflow-tools MCP server (agent policy editor). */
  projectWorkflowTools: (
    projectId: string,
  ) => Promise<
    Array<{ name: string; description: string; annotations?: ToolAnnotations }>
  >;
  /** Replace the profile's tool policy for a connection (null = auto). */
  connectionsSetPolicy: (
    id: string,
    policy: McpToolPolicy | null,
  ) => Promise<boolean>;
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
  createDefaultProject: () => Promise<{ id: string; name: string }>;
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
  sessionCheckouts: (projectId: string) => Promise<SessionCheckoutInfo[]>;
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
