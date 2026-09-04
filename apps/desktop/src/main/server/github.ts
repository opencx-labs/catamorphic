import fs from "node:fs";
import type {
  GithubAppConfig,
  GithubTokenStore,
  StoredGithubConnection,
} from "@catamorphic/github";
import { safeStorage } from "electron";

/**
 * The catamorphic GitHub App (owned by the opencx-labs org). Only the client
 * id ships with the desktop app — device flow needs no secret. Overridable so
 * forks can point at their own app registration.
 */
export const GITHUB_APP: GithubAppConfig = {
  clientId: process.env.CATAMORPHIC_GITHUB_CLIENT_ID ?? "Iv23ctJpmtmboLcXS2rE",
  appSlug: process.env.CATAMORPHIC_GITHUB_APP_SLUG ?? "catamorphic-ai",
};

/** Shape persisted on disk; encrypted when the OS supports it. */
interface StoredFile {
  connectionEncrypted?: string;
  connectionPlaintext?: string;
}

/**
 * Desktop implementation of the host-owned GitHub token store: one
 * connection in a safeStorage-encrypted file in the desktop user data. The
 * desktop is single-tenant, so the tenant/user keys are ignored.
 */
export class FileGithubTokenStore implements GithubTokenStore {
  constructor(private readonly file: string) {}

  async get(): Promise<StoredGithubConnection | null> {
    let stored: StoredFile;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      return null;
    }
    let raw: string | null = null;
    if (stored.connectionEncrypted) {
      try {
        raw = safeStorage.decryptString(
          Buffer.from(stored.connectionEncrypted, "base64"),
        );
      } catch {
        return null;
      }
    } else {
      raw = stored.connectionPlaintext ?? null;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredGithubConnection;
      return typeof parsed.tokens?.accessToken === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  async set(
    _tenantId: string,
    _externalUserId: string,
    connection: StoredGithubConnection,
  ): Promise<void> {
    const raw = JSON.stringify(connection);
    const stored: StoredFile = {};
    if (safeStorage.isEncryptionAvailable()) {
      stored.connectionEncrypted = safeStorage
        .encryptString(raw)
        .toString("base64");
    } else {
      console.warn(
        "[desktop] OS keychain encryption unavailable; storing GitHub tokens in plaintext.",
      );
      stored.connectionPlaintext = raw;
    }
    fs.writeFileSync(this.file, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async delete(): Promise<void> {
    fs.rmSync(this.file, { force: true });
  }
}
