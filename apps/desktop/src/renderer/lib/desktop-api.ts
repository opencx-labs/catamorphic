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
}

declare global {
  interface Window {
    catamorphicDesktop: CatamorphicDesktopApi;
  }
}

export const desktopApi = window.catamorphicDesktop;
