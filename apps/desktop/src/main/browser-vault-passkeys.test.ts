import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as kdbx from "kdbxweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSKEY_FIELD, PasswordVault } from "./browser-vault.js";
import { generatePasskeyKey, toBase64Url } from "./webauthn.js";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    }),
  },
  systemPreferences: { canPromptTouchID: () => false },
}));

const directories: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-passkeys-"));
  directories.push(dir);
  return { dir, vault: new PasswordVault(dir) };
}
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const passkey = (
  overrides: Partial<Parameters<PasswordVault["savePasskey"]>[1]> = {},
) => ({
  rpId: "example.com",
  username: "ada@example.com",
  credentialId: Buffer.from("credential-one"),
  userHandle: Buffer.from("user-1"),
  privateKeyPem: generatePasskeyKey(-7).privateKeyPem,
  ...overrides,
});

/** The vault file as KeePassXC would open it. */
async function openFile(dir: string) {
  const key = fs.readFileSync(path.join(dir, "profile/vault.key")).toString();
  const bytes = fs.readFileSync(path.join(dir, "profile/vault.kdbx"));
  return kdbx.Kdbx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    new kdbx.Credentials(kdbx.ProtectedValue.fromString(key)),
  );
}

describe("passkeys in the vault", () => {
  it("keeps passkeys apart from passwords and stores them as KeePassXC does", async () => {
    const { dir, vault } = fixture();
    await vault.save("profile", {
      origin: "https://example.com",
      username: "ada@example.com",
      password: "fixture-password",
    });
    const saved = await vault.savePasskey("profile", passkey());
    expect(await vault.list("profile")).toHaveLength(1);
    expect(await vault.listPasskeys("profile")).toEqual([
      expect.objectContaining({
        id: saved.id,
        rpId: "example.com",
        username: "ada@example.com",
        credentialId: toBase64Url(Buffer.from("credential-one")),
        discoverable: true,
      }),
    ]);
    expect(await vault.listPasskeys("profile", "other.com")).toEqual([]);

    const db = await openFile(dir);
    const entry = db
      .getDefaultGroup()
      .entries.find((candidate) => candidate.uuid.id === saved.id);
    if (!entry) throw new Error("Passkey entry missing");
    expect(entry.fields.get(PASSKEY_FIELD.relyingParty)).toBe("example.com");
    expect(entry.fields.get(PASSKEY_FIELD.username)).toBe("ada@example.com");
    expect(entry.fields.get(PASSKEY_FIELD.privateKey)).toBeInstanceOf(
      kdbx.ProtectedValue,
    );
    expect(entry.tags).toContain("Passkey");
    // The private key is encrypted in the file, never plain text.
    const bytes = fs.readFileSync(path.join(dir, "profile/vault.kdbx"));
    expect(bytes.includes(Buffer.from("BEGIN PRIVATE KEY"))).toBe(false);
  });

  it("hands main the secret it signs with, and only main", async () => {
    const { vault } = fixture();
    const input = passkey();
    const saved = await vault.savePasskey("profile", input);
    const secret = await vault.passkeySecret("profile", saved.id);
    expect(secret?.privateKeyPem).toBe(input.privateKeyPem);
    expect(secret?.userHandle).toEqual(Buffer.from("user-1"));
    expect(secret?.counter).toBe(0);
    expect(secret?.backupEligible).toBe(true);
    expect(secret?.backedUp).toBe(false);
    // A password's id is not a passkey.
    const login = await vault.save("profile", {
      origin: "https://example.com",
      username: "ada",
      password: "fixture",
    });
    expect(await vault.passkeySecret("profile", login.id)).toBeNull();
    expect(await vault.reveal("profile", saved.id)).toBeNull();
  });

  it("replaces an account's passkey for the same site, as authenticators do", async () => {
    const { vault } = fixture();
    await vault.savePasskey("profile", passkey());
    await vault.savePasskey(
      "profile",
      passkey({ credentialId: Buffer.from("credential-two") }),
    );
    await vault.savePasskey(
      "profile",
      passkey({
        userHandle: Buffer.from("user-2"),
        credentialId: Buffer.from("credential-three"),
        username: "grace@example.com",
      }),
    );
    const listed = await vault.listPasskeys("profile");
    expect(listed.map((item) => item.credentialId).sort()).toEqual(
      [
        toBase64Url(Buffer.from("credential-two")),
        toBase64Url(Buffer.from("credential-three")),
      ].sort(),
    );
  });

  it("counts on only for passkeys that already counted", async () => {
    const { vault } = fixture();
    const fresh = await vault.savePasskey("profile", passkey());
    expect(await vault.nextPasskeyCounter("profile", fresh.id)).toBe(0);
    const counting = await vault.savePasskey(
      "profile",
      passkey({
        userHandle: Buffer.from("user-9"),
        credentialId: Buffer.from("counting"),
        counter: 7,
      }),
    );
    expect(await vault.nextPasskeyCounter("profile", counting.id)).toBe(8);
    expect(await vault.nextPasskeyCounter("profile", counting.id)).toBe(9);
    expect((await vault.passkeySecret("profile", counting.id))?.counter).toBe(
      9,
    );
  });

  it("imports passkeys once, next to passwords", async () => {
    const { vault } = fixture();
    const first = await vault.importMissing({
      profileId: "profile",
      credentials: [
        {
          origin: "https://example.com",
          username: "ada",
          password: "fixture",
        },
      ],
      passkeys: [passkey(), passkey({ discoverable: false })],
    });
    expect(first).toEqual({ imported: 1, importedPasskeys: 1, existing: 1 });
    const again = await vault.importMissing({
      profileId: "profile",
      credentials: [],
      passkeys: [passkey()],
    });
    expect(again).toEqual({ imported: 0, importedPasskeys: 0, existing: 1 });
    expect(await vault.list("profile")).toHaveLength(1);
    expect(await vault.listPasskeys("profile")).toHaveLength(1);
  });

  it("deletes for good, with nothing left in a recycle bin", async () => {
    const { dir, vault } = fixture();
    const saved = await vault.savePasskey("profile", passkey());
    const login = await vault.save("profile", {
      origin: "https://example.com",
      username: "ada",
      password: "fixture",
    });
    await vault.remove("profile", saved.id);
    await vault.remove("profile", login.id);
    expect(await vault.listPasskeys("profile")).toEqual([]);
    expect(await vault.list("profile")).toEqual([]);
    const db = await openFile(dir);
    const all: kdbx.KdbxEntry[] = [];
    const walk = (group: kdbx.KdbxGroup) => {
      all.push(...group.entries);
      group.groups.forEach(walk);
    };
    walk(db.getDefaultGroup());
    expect(all).toEqual([]);
  });

  it("no longer lists logins an older version moved to the recycle bin", async () => {
    const { dir, vault } = fixture();
    const login = await vault.save("profile", {
      origin: "https://example.com",
      username: "ada",
      password: "fixture",
    });
    // What remove() used to do.
    const db = await openFile(dir);
    const entry = db
      .getDefaultGroup()
      .entries.find((candidate) => candidate.uuid.id === login.id);
    if (!entry) throw new Error("Login missing");
    db.remove(entry);
    fs.writeFileSync(
      path.join(dir, "profile/vault.kdbx"),
      Buffer.from(await db.save()),
    );
    const reopened = new PasswordVault(dir);
    expect(await reopened.list("profile")).toEqual([]);
  });
});
