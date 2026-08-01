export interface ServerInfo {
  url: string | null;
  hasCodingAgent: boolean;
}

export interface PublicSettings {
  provider: "anthropic" | "openai";
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
}

export interface UpdateSettingsInput {
  provider: "anthropic" | "openai";
  model?: string;
  apiKey?: string | null;
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

export interface BookmarksChange extends BookmarksData {
  projectId: string;
  profileId: string;
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
  getSettings: () => Promise<PublicSettings>;
  setSettings: (input: UpdateSettingsInput) => Promise<PublicSettings>;
  onServerChanged: (listener: (info: ServerInfo) => void) => () => void;
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
  profilesClaimProject: (
    profileId: string,
    projectId: string,
  ) => Promise<void>;
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
