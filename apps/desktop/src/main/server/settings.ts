import fs from "node:fs";
import { safeStorage } from "electron";

export type ModelProvider = "anthropic" | "openai";

export interface DesktopSettings {
  provider: ModelProvider;
  model: string;
  apiKey: string | null;
}

/** Shape persisted on disk; the key is encrypted when the OS supports it. */
interface StoredSettings {
  provider: ModelProvider;
  model: string;
  apiKeyEncrypted?: string;
  apiKeyPlaintext?: string;
}

export const DEFAULT_MODELS: Record<ModelProvider, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.6-luna",
};

const DEFAULTS: DesktopSettings = {
  provider: "anthropic",
  model: DEFAULT_MODELS.anthropic,
  apiKey: null,
};

export class SettingsStore {
  constructor(private readonly file: string) {}

  load(): DesktopSettings {
    let stored: StoredSettings;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      return { ...DEFAULTS };
    }
    return {
      provider: stored.provider ?? DEFAULTS.provider,
      model: stored.model ?? DEFAULT_MODELS[stored.provider ?? "anthropic"],
      apiKey: this.decryptKey(stored),
    };
  }

  save(settings: DesktopSettings): void {
    const stored: StoredSettings = {
      provider: settings.provider,
      model: settings.model,
    };
    if (settings.apiKey) {
      if (safeStorage.isEncryptionAvailable()) {
        stored.apiKeyEncrypted = safeStorage
          .encryptString(settings.apiKey)
          .toString("base64");
      } else {
        console.warn(
          "[desktop] OS keychain encryption unavailable; storing API key in plaintext.",
        );
        stored.apiKeyPlaintext = settings.apiKey;
      }
    }
    fs.writeFileSync(this.file, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private decryptKey(stored: StoredSettings): string | null {
    if (stored.apiKeyEncrypted) {
      try {
        return safeStorage.decryptString(
          Buffer.from(stored.apiKeyEncrypted, "base64"),
        );
      } catch {
        return null;
      }
    }
    return stored.apiKeyPlaintext ?? null;
  }
}

/** Settings as exposed to the renderer: never the raw key. */
export interface PublicSettings {
  provider: ModelProvider;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
}

export function toPublicSettings(settings: DesktopSettings): PublicSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    hasApiKey: settings.apiKey !== null,
    apiKeyMasked: settings.apiKey
      ? `${settings.apiKey.slice(0, 7)}…${settings.apiKey.slice(-4)}`
      : null,
  };
}
