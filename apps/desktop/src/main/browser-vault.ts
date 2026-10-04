import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage, systemPreferences } from "electron";
import * as kdbx from "kdbxweb";
import "./kdbx-argon2.js";
import { fromBase64Url, toBase64Url } from "./webauthn.js";

/**
 * Per-profile password vault, Chrome-style: the user never types a master
 * password. Each profile owns a standard KDBX4 database (kdbxweb — the
 * battle-tested KeePass format, portable to KeePassXC/Strongbox) whose
 * random master key is encrypted with the OS keychain (safeStorage).
 * Sensitive operations (revealing or filling a password for a new site
 * session) are gated behind local device auth (Touch ID / account password)
 * once per app run per profile, mirroring Chrome's behavior on macOS.
 */

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

/**
 * A passkey in the vault, as listings show it. The private key never
 * leaves main: `passkeySecret` hands it to the WebAuthn code there.
 */
export interface SavedPasskey {
  id: string;
  rpId: string;
  username: string;
  /** The credential id, base64url, as sites know it. */
  credentialId: string;
  /** Only listed for a sign-in that names it (allowCredentials). */
  discoverable: boolean;
  /** Last change, ms since epoch. */
  updatedAt: number;
}

export interface PasskeySecret extends SavedPasskey {
  privateKeyPem: string;
  userHandle: Buffer | null;
  counter: number;
  backupEligible: boolean;
  backedUp: boolean;
}

/** A passkey arriving from a site (create) or an export (import). */
export interface PasskeyInput {
  rpId: string;
  username: string;
  credentialId: Buffer;
  userHandle: Buffer | null;
  privateKeyPem: string;
  /** Imported passkeys keep counting where their old home left off. */
  counter?: number;
  discoverable?: boolean;
}

/** How a user verification attempt ended. */
export type UserVerification = "verified" | "unavailable" | "refused";

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

/**
 * Passkeys use KeePassXC's entry attributes, so a KeePassXC database
 * imports as it is and entries Work writes read the same way there. The
 * counter and discoverability are Work's own (KeePassXC keeps neither).
 */
export const PASSKEY_FIELD = {
  username: "KPEX_PASSKEY_USERNAME",
  credentialId: "KPEX_PASSKEY_CREDENTIAL_ID",
  privateKey: "KPEX_PASSKEY_PRIVATE_KEY_PEM",
  relyingParty: "KPEX_PASSKEY_RELYING_PARTY",
  userHandle: "KPEX_PASSKEY_USER_HANDLE",
  backupEligible: "KPEX_PASSKEY_FLAG_BE",
  backedUp: "KPEX_PASSKEY_FLAG_BS",
  counter: "WORK_PASSKEY_COUNTER",
  discoverable: "WORK_PASSKEY_DISCOVERABLE",
} as const;
const PASSKEY_TAG = "Passkey";

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

  /**
   * Fresh user verification for one passkey use (Touch ID, every time,
   * as the system passkey sheets do). Unlike `deviceAuth` it is never
   * cached; a Mac without Touch ID reports "unavailable", so the passkey
   * answers without the user-verified flag where a site allows that.
   */
  async verifyUser(reason: string): Promise<UserVerification> {
    if (
      process.env.CATAMORPHIC_DEV_NO_SYSTEM_PROMPTS === "1" &&
      !app.isPackaged
    )
      return "verified";
    if (process.platform !== "darwin" || !systemPreferences.canPromptTouchID())
      return "unavailable";
    try {
      await systemPreferences.promptTouchID(reason);
      return "verified";
    } catch {
      return "refused";
    }
  }

  /** Whether `verifyUser` can verify at all on this machine. */
  canVerifyUser(): boolean {
    if (
      process.env.CATAMORPHIC_DEV_NO_SYSTEM_PROMPTS === "1" &&
      !app.isPackaged
    )
      return true;
    return (
      process.platform === "darwin" && systemPreferences.canPromptTouchID()
    );
  }

  private entries(db: kdbx.Kdbx): kdbx.KdbxEntry[] {
    const root = db.getDefaultGroup();
    const all: kdbx.KdbxEntry[] = [];
    // Older vaults moved deleted logins to the recycle bin; they stay gone.
    const bin = db.meta.recycleBinUuid?.id;
    const walk = (group: kdbx.KdbxGroup) => {
      if (bin && group.uuid.id === bin) return;
      all.push(...group.entries);
      for (const child of group.groups) walk(child);
    };
    walk(root);
    return all;
  }

  private isPasskey(entry: kdbx.KdbxEntry): boolean {
    return entry.fields.has(PASSKEY_FIELD.privateKey);
  }

  /** Saved logins: every entry that is not a passkey. */
  private logins(db: kdbx.Kdbx): kdbx.KdbxEntry[] {
    return this.entries(db).filter((entry) => !this.isPasskey(entry));
  }

  private passkeys(db: kdbx.Kdbx): kdbx.KdbxEntry[] {
    return this.entries(db).filter((entry) => this.isPasskey(entry));
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
    return this.logins(vault.db)
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
    const entry = this.logins(vault.db).find(
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
    const candidates = this.logins(vault.db).filter(
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

  /**
   * Import in one write, preserving accounts added or edited during
   * Keychain auth. A login is known by its site and username, a passkey
   * by its relying party and credential id.
   */
  async importMissing({
    profileId,
    credentials,
    passkeys = [],
  }: {
    profileId: string;
    credentials: Array<{ origin: string; username: string; password: string }>;
    passkeys?: PasskeyInput[];
  }): Promise<{
    imported: number;
    importedPasskeys: number;
    existing: number;
  }> {
    const vault = await this.unlock(profileId);
    const identities = new Set(
      this.logins(vault.db).map((entry) =>
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
      const imported = created.length;
      const known = new Set(
        this.passkeys(vault.db).map((entry) =>
          JSON.stringify([
            this.fieldText(entry, PASSKEY_FIELD.relyingParty),
            this.fieldText(entry, PASSKEY_FIELD.credentialId),
          ]),
        ),
      );
      for (const input of passkeys) {
        const identity = JSON.stringify([
          input.rpId,
          toBase64Url(input.credentialId),
        ]);
        if (known.has(identity)) {
          existing++;
          continue;
        }
        const entry = vault.db.createEntry(group);
        created.push(entry);
        this.writePasskey(entry, input);
        known.add(identity);
      }
      if (created.length) await this.persist(vault);
      return {
        imported,
        importedPasskeys: created.length - imported,
        existing,
      };
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
    const existing = this.logins(vault.db).find(
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
    const entry = this.logins(vault.db).find(
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
    // Deleted for good: the recycle bin would keep a passkey's private key.
    vault.db.move(entry, null);
    await this.persist(vault);
  }

  // --- passkeys ---

  private passkeySummary(entry: kdbx.KdbxEntry): SavedPasskey {
    return {
      id: entry.uuid.id,
      rpId: this.fieldText(entry, PASSKEY_FIELD.relyingParty),
      username: this.fieldText(entry, PASSKEY_FIELD.username),
      credentialId: this.fieldText(entry, PASSKEY_FIELD.credentialId),
      discoverable: this.fieldText(entry, PASSKEY_FIELD.discoverable) !== "0",
      updatedAt: entry.times.lastModTime?.getTime() ?? 0,
    };
  }

  /** Passkeys, all or one relying party's. Nothing secret. */
  async listPasskeys(
    profileId: string,
    rpId?: string,
  ): Promise<SavedPasskey[]> {
    const vault = await this.unlock(profileId);
    return this.passkeys(vault.db)
      .map((entry) => this.passkeySummary(entry))
      .filter((passkey) => !rpId || passkey.rpId === rpId)
      .sort((a, b) =>
        `${a.rpId}\n${a.username}`.localeCompare(`${b.rpId}\n${b.username}`),
      );
  }

  /**
   * A passkey's private key, for signing in main. Callers verify the
   * user first (`verifyUser`); nothing here reaches IPC.
   */
  async passkeySecret(
    profileId: string,
    id: string,
  ): Promise<PasskeySecret | null> {
    const vault = await this.unlock(profileId);
    const entry = this.passkeys(vault.db).find(
      (candidate) => candidate.uuid.id === id,
    );
    if (!entry) return null;
    const handle = this.fieldText(entry, PASSKEY_FIELD.userHandle);
    const flag = (name: string, fallback: boolean) => {
      const value = this.fieldText(entry, name).toLowerCase();
      return value ? value === "1" || value === "true" : fallback;
    };
    return {
      ...this.passkeySummary(entry),
      privateKeyPem: this.fieldText(entry, PASSKEY_FIELD.privateKey),
      userHandle: handle ? fromBase64Url(handle) : null,
      counter: Number(this.fieldText(entry, PASSKEY_FIELD.counter)) || 0,
      backupEligible: flag(PASSKEY_FIELD.backupEligible, true),
      backedUp: flag(PASSKEY_FIELD.backedUp, false),
    };
  }

  /**
   * The next signature counter for a passkey that counts. Passkeys Work
   * creates stay at zero, as synced passkeys do; an imported one that
   * counted keeps rising past where its old home left it.
   */
  async nextPasskeyCounter(profileId: string, id: string): Promise<number> {
    const vault = await this.unlock(profileId);
    const entry = this.passkeys(vault.db).find(
      (candidate) => candidate.uuid.id === id,
    );
    const current = entry
      ? Number(this.fieldText(entry, PASSKEY_FIELD.counter)) || 0
      : 0;
    if (!entry || current === 0) return 0;
    const next = current + 1;
    entry.fields.set(PASSKEY_FIELD.counter, String(next));
    await this.persist(vault);
    return next;
  }

  private writePasskey(entry: kdbx.KdbxEntry, input: PasskeyInput): void {
    entry.fields.set("Title", `${input.rpId} (Passkey)`);
    entry.fields.set("URL", `https://${input.rpId}`);
    entry.fields.set("UserName", input.username);
    entry.fields.set(PASSKEY_FIELD.username, input.username);
    entry.fields.set(
      PASSKEY_FIELD.credentialId,
      kdbx.ProtectedValue.fromString(toBase64Url(input.credentialId)),
    );
    entry.fields.set(
      PASSKEY_FIELD.privateKey,
      kdbx.ProtectedValue.fromString(input.privateKeyPem),
    );
    entry.fields.set(PASSKEY_FIELD.relyingParty, input.rpId);
    if (input.userHandle)
      entry.fields.set(
        PASSKEY_FIELD.userHandle,
        kdbx.ProtectedValue.fromString(toBase64Url(input.userHandle)),
      );
    else entry.fields.delete(PASSKEY_FIELD.userHandle);
    // Backup eligible: the vault is a file that can be copied. Not backed
    // up: nothing syncs it.
    entry.fields.set(PASSKEY_FIELD.backupEligible, "1");
    entry.fields.set(PASSKEY_FIELD.backedUp, "0");
    if (input.counter)
      entry.fields.set(PASSKEY_FIELD.counter, String(input.counter));
    else entry.fields.delete(PASSKEY_FIELD.counter);
    if (input.discoverable === false)
      entry.fields.set(PASSKEY_FIELD.discoverable, "0");
    else entry.fields.delete(PASSKEY_FIELD.discoverable);
    if (!entry.tags.includes(PASSKEY_TAG))
      entry.tags = [...entry.tags, PASSKEY_TAG];
    entry.times.update();
  }

  /**
   * Save a passkey a site just created. One account keeps one passkey
   * per site: a new one for the same user handle replaces the old.
   */
  async savePasskey(
    profileId: string,
    input: PasskeyInput,
  ): Promise<SavedPasskey> {
    const vault = await this.unlock(profileId);
    const handle = input.userHandle ? toBase64Url(input.userHandle) : null;
    const existing = handle
      ? this.passkeys(vault.db).find(
          (entry) =>
            this.fieldText(entry, PASSKEY_FIELD.relyingParty) === input.rpId &&
            this.fieldText(entry, PASSKEY_FIELD.userHandle) === handle,
        )
      : undefined;
    const entry = existing ?? vault.db.createEntry(vault.db.getDefaultGroup());
    this.writePasskey(entry, input);
    await this.persist(vault);
    return this.passkeySummary(entry);
  }
}
