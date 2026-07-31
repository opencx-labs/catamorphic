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

export interface CatamorphicDesktopApi {
  getServerState: () => Promise<ServerInfo>;
  getSettings: () => Promise<PublicSettings>;
  setSettings: (input: UpdateSettingsInput) => Promise<PublicSettings>;
  onServerChanged: (listener: (info: ServerInfo) => void) => () => void;
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
}

declare global {
  interface Window {
    catamorphicDesktop: CatamorphicDesktopApi;
  }
}

export const desktopApi = window.catamorphicDesktop;
