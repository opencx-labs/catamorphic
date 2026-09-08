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
  private cached: StoredGithubConnection | null | undefined;

  constructor(private readonly file: string) {}

  async get(): Promise<StoredGithubConnection | null> {
    if (this.cached !== undefined) return this.cached;

    let stored: StoredFile;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, "utf-8"));
    } catch {
      this.cached = null;
      return this.cached;
    }
    let raw: string | null = null;
    if (stored.connectionEncrypted) {
      try {
        raw = safeStorage.decryptString(
          Buffer.from(stored.connectionEncrypted, "base64"),
        );
      } catch {
        this.cached = null;
        return this.cached;
      }
    } else {
      raw = stored.connectionPlaintext ?? null;
    }
    if (!raw) {
      this.cached = null;
      return this.cached;
    }
    try {
      const parsed = JSON.parse(raw) as StoredGithubConnection;
      this.cached =
        typeof parsed.tokens?.accessToken === "string" ? parsed : null;
      return this.cached;
    } catch {
      this.cached = null;
      return this.cached;
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
    this.cached = connection;
  }

  async delete(): Promise<void> {
    fs.rmSync(this.file, { force: true });
    this.cached = null;
  }
}
