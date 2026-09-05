import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeStorage, systemPreferences } from "electron";
import { argon2d, argon2id } from "hash-wasm";
import * as kdbx from "kdbxweb";

/**
 * Per-profile password vault, Chrome-style: the user never types a master
 * password. Each profile owns a standard KDBX4 database (kdbxweb — the
 * battle-tested KeePass format, portable to KeePassXC/Strongbox) whose
 * random master key is encrypted with the OS keychain (safeStorage).
 * Sensitive operations (revealing or filling a password for a new site
 * session) are gated behind local device auth (Touch ID / account password)
 * once per app run per profile, mirroring Chrome's behavior on macOS.
 */

// kdbxweb needs an external Argon2; hash-wasm is small and WASM-based.
kdbx.CryptoEngine.setArgon2Impl(
  async (password, salt, memory, iterations, length, parallelism, type) => {
    const fn =
      type === kdbx.CryptoEngine.Argon2TypeArgon2d ? argon2d : argon2id;
    const hash = await fn({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      memorySize: memory,
      iterations,
      hashLength: length,
      parallelism,
      outputType: "binary",
    });
    return hash.buffer as ArrayBuffer;
  },
);

export interface SavedCredential {
  id: string;
  origin: string;
  username: string;
}

export interface CredentialWithSecret extends SavedCredential {
  password: string;
}

export interface CredentialUpdate {
  origin: string;
  username: string;
  /** Omit to keep the existing password. */
  password?: string;
}

interface OpenVault {
  db: kdbx.Kdbx;
  file: string;
  deviceAuthed: boolean;
}

const VAULT_GROUP = "Catamorphic Browser";

export function normalizeCredentialOrigin(raw: string): string {
  const value = raw.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Saved passwords require an HTTP or HTTPS website");
  }
  return url.origin;
}

export class PasswordVault {
  private open = new Map<string, OpenVault>();
  private opening = new Map<string, Promise<OpenVault>>();

  constructor(private readonly profilesDir: string) {}

  private vaultFile(profileId: string): string {
    return path.join(this.profilesDir, profileId, "vault.kdbx");
  }

  private keyFile(profileId: string): string {
    return path.join(this.profilesDir, profileId, "vault.key");
  }

  /** Load or create the profile's vault; key comes from the OS keychain. */
  private async unlock(profileId: string): Promise<OpenVault> {
    const opened = this.open.get(profileId);
    if (opened) return opened;

    const opening = this.opening.get(profileId);
    if (opening) return opening;

    const unlockPromise = this.openVault(profileId);
    this.opening.set(profileId, unlockPromise);
    try {
      return await unlockPromise;
    } finally {
      if (this.opening.get(profileId) === unlockPromise) {
        this.opening.delete(profileId);
      }
    }
  }

  private async openVault(profileId: string): Promise<OpenVault> {
    const dir = path.join(this.profilesDir, profileId);
    fs.mkdirSync(dir, { recursive: true });
    const keyFile = this.keyFile(profileId);
    const vaultFile = this.vaultFile(profileId);

    let keyHex: string;
    if (fs.existsSync(keyFile)) {
      const decrypted = await safeStorage.decryptStringAsync(
        fs.readFileSync(keyFile),
      );
      keyHex = decrypted.result;
      if (decrypted.shouldReEncrypt) {
        fs.writeFileSync(keyFile, await safeStorage.encryptStringAsync(keyHex));
      }
    } else {
      keyHex = randomBytes(32).toString("hex");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("OS keychain encryption unavailable");
      }
      fs.writeFileSync(keyFile, await safeStorage.encryptStringAsync(keyHex));
    }

    const credentials = new kdbx.Credentials(
      kdbx.ProtectedValue.fromString(keyHex),
    );

    let db: kdbx.Kdbx;
    if (fs.existsSync(vaultFile)) {
      const bytes = fs.readFileSync(vaultFile);
      db = await kdbx.Kdbx.load(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        credentials,
      );
    } else {
      db = kdbx.Kdbx.create(credentials, VAULT_GROUP);
      await this.persist({ db, file: vaultFile, deviceAuthed: false });
    }

    const vault: OpenVault = { db, file: vaultFile, deviceAuthed: false };
    this.open.set(profileId, vault);
    return vault;
  }

  private async persist(vault: OpenVault): Promise<void> {
    const data = await vault.db.save();
    fs.writeFileSync(vault.file, Buffer.from(data));
  }

  /**
   * Local device auth (Touch ID with password fallback), once per app run
   * per profile. Off-macOS or headless failures fall back to allowing —
   * the vault is already gated by the OS user account via safeStorage.
   */
  private async deviceAuth(vault: OpenVault, reason: string): Promise<boolean> {
    if (vault.deviceAuthed) return true;
    if (process.platform === "darwin") {
      try {
        if (systemPreferences.canPromptTouchID()) {
          await systemPreferences.promptTouchID(reason);
        }
      } catch {
        return false;
      }
    }
    vault.deviceAuthed = true;
    return true;
  }

  private entries(db: kdbx.Kdbx): kdbx.KdbxEntry[] {
    const root = db.getDefaultGroup();
    const all: kdbx.KdbxEntry[] = [];
    const walk = (group: kdbx.KdbxGroup) => {
      all.push(...group.entries);
      for (const child of group.groups) walk(child);
    };
    walk(root);
    return all;
  }

  private originOf(entry: kdbx.KdbxEntry): string {
    const url = entry.fields.get("URL");
    return typeof url === "string" ? url : "";
  }

  private fieldText(entry: kdbx.KdbxEntry, name: string): string {
    const value = entry.fields.get(name);
    if (typeof value === "string") return value;
    if (value instanceof kdbx.ProtectedValue) return value.getText();
    return "";
  }

  /** Non-secret listing (origin + username) — safe without device auth. */
  async list(profileId: string, origin?: string): Promise<SavedCredential[]> {
    const vault = await this.unlock(profileId);
    const normalizedOrigin = origin
      ? normalizeCredentialOrigin(origin)
      : undefined;
    return this.entries(vault.db)
      .filter(
        (entry) =>
          !normalizedOrigin || this.originOf(entry) === normalizedOrigin,
      )
      .map((entry) => ({
        id: entry.uuid.id,
        origin: this.originOf(entry),
        username: this.fieldText(entry, "UserName"),
      }))
      .sort((a, b) =>
        `${a.origin}\n${a.username}`.localeCompare(
          `${b.origin}\n${b.username}`,
        ),
      );
  }

  /** Secret retrieval — requires device auth (Touch ID) once per run. */
  async reveal(
    profileId: string,
    id: string,
  ): Promise<CredentialWithSecret | null> {
    const vault = await this.unlock(profileId);
    const authed = await this.deviceAuth(
      vault,
      "unlock saved passwords for autofill",
    );
    if (!authed) return null;
    const entry = this.entries(vault.db).find(
      (candidate) => candidate.uuid.id === id,
    );
    if (!entry) return null;
    return {
      id: entry.uuid.id,
      origin: this.originOf(entry),
      username: this.fieldText(entry, "UserName"),
      password: this.fieldText(entry, "Password"),
    };
  }

  /** Create or update (same origin+username ⇒ update), Chrome-style. */
  async save(
    profileId: string,
    input: { origin: string; username: string; password: string },
  ): Promise<SavedCredential> {
    const vault = await this.unlock(profileId);
    const origin = normalizeCredentialOrigin(input.origin);
    const existing = this.entries(vault.db).find(
      (entry) =>
        this.originOf(entry) === origin &&
        this.fieldText(entry, "UserName") === input.username,
    );
    const entry = existing ?? vault.db.createEntry(vault.db.getDefaultGroup());
    entry.fields.set("Title", new URL(origin).host);
    entry.fields.set("URL", origin);
    entry.fields.set("UserName", input.username);
    entry.fields.set(
      "Password",
      kdbx.ProtectedValue.fromString(input.password),
    );
    entry.times.update();
    await this.persist(vault);
    return {
      id: entry.uuid.id,
      origin,
      username: input.username,
    };
  }

  async update(
    profileId: string,
    id: string,
    input: CredentialUpdate,
  ): Promise<SavedCredential | null> {
    const vault = await this.unlock(profileId);
    const entry = this.entries(vault.db).find(
      (candidate) => candidate.uuid.id === id,
    );
    if (!entry) return null;
    const origin = normalizeCredentialOrigin(input.origin);
    entry.fields.set("Title", new URL(origin).host);
    entry.fields.set("URL", origin);
    entry.fields.set("UserName", input.username);
    if (input.password !== undefined) {
      entry.fields.set(
        "Password",
        kdbx.ProtectedValue.fromString(input.password),
      );
    }
    entry.times.update();
    await this.persist(vault);
    return { id, origin, username: input.username };
  }

  async remove(profileId: string, id: string): Promise<void> {
    const vault = await this.unlock(profileId);
    const entry = this.entries(vault.db).find(
      (candidate) => candidate.uuid.id === id,
    );
    if (!entry) return;
    vault.db.remove(entry);
    await this.persist(vault);
  }
}
