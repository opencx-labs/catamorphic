import { randomBytes } from "node:crypto";
import * as kdbx from "kdbxweb";
import { describe, expect, it } from "vitest";
import "../../kdbx-argon2.js";
import { generatePasskeyKey, toBase64Url } from "../../webauthn.js";
import {
  PasswordFileError,
  passwordFileKind,
  readBitwardenExport,
  readKeepassDatabase,
  readPasswordFile,
  WrongDatabaseKey,
} from "../password-file.js";

const pkcs8 = (pem: string) =>
  Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");

describe("Bitwarden JSON exports", () => {
  const key = generatePasskeyKey(-7).privateKeyPem;
  const exported = {
    encrypted: false,
    folders: [],
    items: [
      {
        type: 1,
        name: "Example",
        login: {
          username: "ada@example.com",
          password: "fixture-password",
          uris: [
            { uri: "android://app" },
            { uri: "https://example.com/login" },
          ],
          fido2Credentials: [
            {
              // New Bitwarden passkeys use a GUID as the credential id.
              credentialId: "6b1f5c2a-1f1e-4b1a-9d3c-0123456789ab",
              keyType: "public-key",
              keyAlgorithm: "ECDSA",
              keyCurve: "P-256",
              keyValue: toBase64Url(pkcs8(key)),
              rpId: "example.com",
              userHandle: toBase64Url(Buffer.from("user-1")),
              userName: "ada@example.com",
              counter: "3",
              discoverable: "true",
            },
          ],
        },
      },
      {
        type: 1,
        name: "Imported elsewhere",
        login: {
          username: "",
          password: "",
          uris: [],
          fido2Credentials: [
            {
              credentialId: `b64.${toBase64Url(Buffer.from("raw-id"))}`,
              keyValue: toBase64Url(pkcs8(key)),
              rpId: "github.com",
              userHandle: toBase64Url(Buffer.from("user-2")),
              userName: "grace",
              counter: "0",
              discoverable: "false",
            },
          ],
        },
      },
      { type: 2, name: "A secure note" },
      {
        type: 1,
        name: "Broken",
        login: {
          fido2Credentials: [
            {
              credentialId: "6b1f5c2a-1f1e-4b1a-9d3c-0123456789ab",
              keyValue: "not-a-key",
              rpId: "example.com",
            },
          ],
        },
      },
    ],
  };

  it("reads logins and passkeys, as Bitwarden encodes them", () => {
    const result = readBitwardenExport(JSON.stringify(exported));
    expect(result.logins).toEqual([
      {
        origin: "https://example.com",
        username: "ada@example.com",
        password: "fixture-password",
      },
    ]);
    expect(result.passkeys).toEqual([
      {
        rpId: "example.com",
        username: "ada@example.com",
        credentialId: Buffer.from("6b1f5c2a1f1e4b1a9d3c0123456789ab", "hex"),
        userHandle: Buffer.from("user-1"),
        privateKeyPem: expect.stringContaining("BEGIN PRIVATE KEY"),
        counter: 3,
        discoverable: true,
        backupEligible: true,
      },
      {
        rpId: "github.com",
        username: "grace",
        credentialId: Buffer.from("raw-id"),
        userHandle: Buffer.from("user-2"),
        privateKeyPem: expect.stringContaining("BEGIN PRIVATE KEY"),
        counter: 0,
        discoverable: false,
        backupEligible: true,
      },
    ]);
    expect(result.skipped).toBe(2);
  });

  it("explains an encrypted export instead of failing quietly", () => {
    // A password-protected export carries only ciphertext, no items.
    expect(() =>
      readBitwardenExport(
        JSON.stringify({
          encrypted: true,
          passwordProtected: true,
          salt: "c2FsdA==",
          kdfType: 0,
          kdfIterations: 600000,
          encKeyValidation_DO_NOT_EDIT: "2.x|y|z",
          data: "2.a|b|c",
        }),
      ),
    ).toThrow(/is encrypted/);
    // An account-restricted export keeps encrypted items.
    expect(() =>
      readBitwardenExport(
        JSON.stringify({ encrypted: true, items: [{ login: "2.a|b|c" }] }),
      ),
    ).toThrow(/is encrypted/);
    expect(() => readBitwardenExport('{"hello":1}')).toThrow(
      /not a Bitwarden export/,
    );
  });
});

describe("KeePass databases", () => {
  async function database(options: { keyFile?: Uint8Array } = {}) {
    const db = kdbx.Kdbx.create(
      new kdbx.Credentials(
        kdbx.ProtectedValue.fromString("correct horse"),
        // kdbxweb wipes the key bytes it is given.
        options.keyFile ? new Uint8Array(options.keyFile) : null,
      ),
      "KeePassXC",
    );
    const group = db.getDefaultGroup();
    // A KeePassXC passkey entry, as its browser integration writes one.
    const passkeyEntry = db.createEntry(group);
    passkeyEntry.fields.set("Title", "Example (Passkey)");
    passkeyEntry.fields.set("UserName", "ada");
    passkeyEntry.fields.set("URL", "https://example.com");
    passkeyEntry.fields.set("KPEX_PASSKEY_USERNAME", "ada");
    passkeyEntry.fields.set(
      "KPEX_PASSKEY_CREDENTIAL_ID",
      kdbx.ProtectedValue.fromString(toBase64Url(Buffer.from("kpxc-id"))),
    );
    // KeePassXC's Bitwarden import leaves the PEM on one line.
    const pem = generatePasskeyKey(-8).privateKeyPem.replace(/\n/g, "");
    passkeyEntry.fields.set(
      "KPEX_PASSKEY_PRIVATE_KEY_PEM",
      kdbx.ProtectedValue.fromString(pem),
    );
    passkeyEntry.fields.set("KPEX_PASSKEY_RELYING_PARTY", "example.com");
    passkeyEntry.fields.set(
      "KPEX_PASSKEY_USER_HANDLE",
      kdbx.ProtectedValue.fromString(toBase64Url(Buffer.from("user-1"))),
    );
    const login = db.createEntry(group);
    login.fields.set("URL", "https://news.example.org/login");
    login.fields.set("UserName", "grace");
    login.fields.set("Password", kdbx.ProtectedValue.fromString("pw"));
    const nested = db.createGroup(group, "Work");
    const noWebsite = db.createEntry(nested);
    noWebsite.fields.set("Title", "Wi-Fi");
    noWebsite.fields.set("Password", kdbx.ProtectedValue.fromString("pw"));
    const trashed = db.createEntry(group);
    trashed.fields.set("URL", "https://deleted.example");
    trashed.fields.set("Password", kdbx.ProtectedValue.fromString("pw"));
    db.remove(trashed);
    return new Uint8Array(await db.save());
  }

  it("reads KeePassXC passkeys and website logins, leaving the recycle bin", async () => {
    const bytes = await database();
    expect(passwordFileKind(bytes)).toBe("kdbx");
    const result = await readKeepassDatabase({
      bytes,
      password: "correct horse",
    });
    // The passkey entry has no password, so it is not also a login.
    expect(result.logins).toEqual([
      {
        origin: "https://news.example.org",
        username: "grace",
        password: "pw",
      },
    ]);
    expect(result.passkeys).toEqual([
      expect.objectContaining({
        rpId: "example.com",
        username: "ada",
        credentialId: Buffer.from("kpxc-id"),
        userHandle: Buffer.from("user-1"),
        privateKeyPem: expect.stringMatching(/^-----BEGIN PRIVATE KEY-----\n/),
      }),
    ]);
    expect(result.skipped).toBe(1);
  });

  it("tells a wrong password from an unreadable file", async () => {
    const bytes = await database();
    await expect(
      readKeepassDatabase({ bytes, password: "wrong" }),
    ).rejects.toBeInstanceOf(WrongDatabaseKey);
    const broken = bytes.slice(0, 200);
    await expect(
      readKeepassDatabase({ bytes: broken, password: "correct horse" }),
    ).rejects.toBeInstanceOf(PasswordFileError);
  });

  it("opens a database that also needs its key file", async () => {
    const keyFile = randomBytes(32);
    const bytes = await database({ keyFile });
    await expect(
      readKeepassDatabase({ bytes, password: "correct horse" }),
    ).rejects.toBeInstanceOf(WrongDatabaseKey);
    // A wrong password with the key file, then the right one: the same
    // bytes serve every attempt.
    await expect(
      readKeepassDatabase({ bytes, password: "wrong", keyFile }),
    ).rejects.toBeInstanceOf(WrongDatabaseKey);
    const result = await readKeepassDatabase({
      bytes,
      password: "correct horse",
      keyFile,
    });
    expect(result.passkeys).toHaveLength(1);
  });
});

describe("KeePass variants", () => {
  async function save(db: kdbx.Kdbx): Promise<Uint8Array> {
    return new Uint8Array(await db.save());
  }

  it("opens a database protected by a key file alone", async () => {
    const keyFile = randomBytes(32);
    const db = kdbx.Kdbx.create(
      new kdbx.Credentials(null, new Uint8Array(keyFile)),
      "Key only",
    );
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("URL", "https://example.com");
    entry.fields.set("Password", kdbx.ProtectedValue.fromString("pw"));
    const result = await readKeepassDatabase({
      bytes: await save(db),
      password: "",
      keyFile,
    });
    expect(result.logins).toHaveLength(1);
  });

  it("reads StrongBox's passkey names and keeps backup eligibility", async () => {
    const db = kdbx.Kdbx.create(
      new kdbx.Credentials(kdbx.ProtectedValue.fromString("pw")),
      "StrongBox",
    );
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("KPXC_PASSKEY_USERNAME", "strong");
    entry.fields.set(
      "KPEX_PASSKEY_GENERATED_USER_ID",
      toBase64Url(Buffer.from("sb-id")),
    );
    entry.fields.set(
      "KPEX_PASSKEY_PRIVATE_KEY_PEM",
      kdbx.ProtectedValue.fromString(generatePasskeyKey(-7).privateKeyPem),
    );
    entry.fields.set("KPEX_PASSKEY_RELYING_PARTY", "example.com");
    entry.fields.set("KPEX_PASSKEY_FLAG_BE", "0");
    const result = await readKeepassDatabase({
      bytes: await save(db),
      password: "pw",
    });
    expect(result.passkeys).toEqual([
      expect.objectContaining({
        username: "strong",
        credentialId: Buffer.from("sb-id"),
        backupEligible: false,
      }),
    ]);
  });
});

describe("file detection", () => {
  it("knows a file by its contents", () => {
    expect(passwordFileKind(Buffer.from('﻿  {"items": []}'))).toBe("bitwarden");
    expect(passwordFileKind(Buffer.from("name,url,username,password"))).toBe(
      "csv",
    );
  });

  it("reads Bitwarden's CSV columns", () => {
    const csv =
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n" +
      ",,login,Example,,,0,https://example.com,ada,secret,\n" +
      // Several URIs arrive joined by commas.
      ',,login,Mail,,,0,"android://app,https://mail.example.org/login,https://other.example",grace,pw,\n';
    expect(readPasswordFile(Buffer.from(csv))).toEqual({
      logins: [
        { origin: "https://example.com", username: "ada", password: "secret" },
        {
          origin: "https://mail.example.org",
          username: "grace",
          password: "pw",
        },
      ],
      passkeys: [],
      skipped: 0,
    });
  });

  it("says what files it takes when given something else", () => {
    expect(() => readPasswordFile(Buffer.from("hello\nworld"))).toThrow(
      /CSV, Bitwarden JSON or KeePass/,
    );
  });
});
