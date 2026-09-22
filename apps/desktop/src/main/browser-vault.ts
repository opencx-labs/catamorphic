import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage, systemPreferences } from "electron";
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

/**
 * Listing metadata. Notes can hold recovery codes and the like, so a
 * listing only says whether one exists; `reveal` returns its text.
 */
export interface SavedCredential {
  id: string;
  origin: string;
  username: string;
  hasNote: boolean;
  /** Last change, ms since epoch. */
  updatedAt: number;
}

export interface CredentialWithSecret extends SavedCredential {
  password: string;
  note: string;
}

export interface CredentialUpdate {
  origin: string;
  username: string;
  /** Omit to keep the existing password. */
  password?: string;
  /** Omit to keep the existing note. */
  note?: string;
}

/** How a submitted login relates to what the vault already holds. */
export type CredentialMatch =
  | { status: "new" }
  | { status: "same"; id: string }
  | { status: "changed"; id: string };

interface OpenVault {
  db: kdbx.Kdbx;
  file: string;
  deviceAuthed: boolean;
}

const VAULT_GROUP = "Work Browser";
/** Meta custom data key: origins the user chose never to save for. */
const NEVER_SAVE_KEY = "work.never-save";

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

  releaseProfile(profileId: string): void {
    this.open.delete(profileId);
    this.opening.delete(profileId);
  }

  dispose(): void {
    this.open.clear();
    this.opening.clear();
  }

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
      const vault = await unlockPromise;
      if (this.opening.get(profileId) === unlockPromise)
        this.open.set(profileId, vault);
      return vault;
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
    return vault;
  }

  private async persist(vault: OpenVault): Promise<void> {
    const data = await vault.db.save();
    const temporary = `${vault.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, Buffer.from(data), { mode: 0o600 });
      fs.renameSync(temporary, vault.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  /**
   * Local device auth (Touch ID with password fallback), once per app run
   * per profile. Off-macOS or headless failures fall back to allowing —
   * the vault is already gated by the OS user account via safeStorage.
   */
  private async deviceAuth(vault: OpenVault, reason: string): Promise<boolean> {
    if (vault.deviceAuthed) return true;
    // Development seam (see main/index.ts): an unpackaged app driven over
    // CDP cannot answer a Touch ID sheet. Packaged builds always prompt.
    if (
      process.env.CATAMORPHIC_DEV_NO_SYSTEM_PROMPTS === "1" &&
      !app.isPackaged
    ) {
      vault.deviceAuthed = true;
      return true;
    }
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

  private summary(entry: kdbx.KdbxEntry): SavedCredential {
    return {
      id: entry.uuid.id,
      origin: this.originOf(entry),
      username: this.fieldText(entry, "UserName"),
      hasNote: this.fieldText(entry, "Notes").length > 0,
      updatedAt: entry.times.lastModTime?.getTime() ?? 0,
    };
  }

  private setNote(entry: kdbx.KdbxEntry, note: string): void {
    if (note) entry.fields.set("Notes", kdbx.ProtectedValue.fromString(note));
    else entry.fields.delete("Notes");
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
      .map((entry) => this.summary(entry))
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
      ...this.summary(entry),
      password: this.fieldText(entry, "Password"),
      note: this.fieldText(entry, "Notes"),
    };
  }

  /**
   * Compare a submitted login with the vault without revealing anything:
   * an unchanged password is not offered again, a changed one is offered
   * as an update to the same entry (Chrome's "Update password?").
   */
  async match(
    profileId: string,
    input: { origin: string; username: string; password: string },
  ): Promise<CredentialMatch> {
    const vault = await this.unlock(profileId);
    const origin = normalizeCredentialOrigin(input.origin);
    const candidates = this.entries(vault.db).filter(
      (entry) => this.originOf(entry) === origin,
    );
    const sameUser = candidates.find(
      (entry) => this.fieldText(entry, "UserName") === input.username,
    );
    if (sameUser) {
      return this.fieldText(sameUser, "Password") === input.password
        ? { status: "same", id: sameUser.uuid.id }
        : { status: "changed", id: sameUser.uuid.id };
    }
    // A form without a username field (a password-only step) that repeats
    // a saved password is the same login, not a new one.
    if (!input.username) {
      const samePassword = candidates.find(
        (entry) => this.fieldText(entry, "Password") === input.password,
      );
      if (samePassword) return { status: "same", id: samePassword.uuid.id };
    }
    return { status: "new" };
  }

  /** Origins the user chose never to save passwords for. */
  async neverSaved(profileId: string): Promise<string[]> {
    const vault = await this.unlock(profileId);
    return this.readNeverSaved(vault);
  }

  async setNeverSave(
    profileId: string,
    origin: string,
    never: boolean,
  ): Promise<string[]> {
    const vault = await this.unlock(profileId);
    const normalized = normalizeCredentialOrigin(origin);
    const current = this.readNeverSaved(vault).filter(
      (candidate) => candidate !== normalized,
    );
    const next = never ? [...current, normalized].sort() : current;
    vault.db.meta.customData.set(NEVER_SAVE_KEY, {
      value: JSON.stringify(next),
      lastModified: new Date(),
    });
    await this.persist(vault);
    return next;
  }

  private readNeverSaved(vault: OpenVault): string[] {
    const raw = vault.db.meta.customData.get(NEVER_SAVE_KEY)?.value;
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }

  /** Import in one write, preserving accounts added or edited during Keychain auth. */
  async importMissing({
    profileId,
    credentials,
  }: {
    profileId: string;
    credentials: Array<{ origin: string; username: string; password: string }>;
  }): Promise<{ imported: number; existing: number }> {
    const vault = await this.unlock(profileId);
    const identities = new Set(
      this.entries(vault.db).map((entry) =>
        JSON.stringify([
          this.originOf(entry),
          this.fieldText(entry, "UserName"),
        ]),
      ),
    );
    const group = vault.db.getDefaultGroup();
    const created: kdbx.KdbxEntry[] = [];
    let existing = 0;
    try {
      for (const input of credentials) {
        const origin = normalizeCredentialOrigin(input.origin);
        const identity = JSON.stringify([origin, input.username]);
        if (identities.has(identity)) {
          existing++;
          continue;
        }
        const entry = vault.db.createEntry(group);
        created.push(entry);
        entry.fields.set("Title", new URL(origin).host);
        entry.fields.set("URL", origin);
        entry.fields.set("UserName", input.username);
        entry.fields.set(
          "Password",
          kdbx.ProtectedValue.fromString(input.password),
        );
        entry.times.update();
        identities.add(identity);
      }
      if (created.length) await this.persist(vault);
      return { imported: created.length, existing };
    } catch (error) {
      group.entries = group.entries.filter((entry) => !created.includes(entry));
      throw error;
    }
  }

  /** Create or update (same origin+username ⇒ update), Chrome-style. */
  async save(
    profileId: string,
    input: {
      origin: string;
      username: string;
      password: string;
      note?: string;
    },
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
    if (input.note !== undefined) this.setNote(entry, input.note);
    entry.times.update();
    await this.persist(vault);
    return this.summary(entry);
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
    if (input.note !== undefined) this.setNote(entry, input.note);
    entry.times.update();
    await this.persist(vault);
    return this.summary(entry);
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
