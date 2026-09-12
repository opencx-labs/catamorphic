import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromiumImporter } from "../chromium.js";
import { BROWSER_IMPORTERS } from "../index.js";
import {
  decryptBrowserPassword,
  importBrowserPasswords,
  type PasswordImportCredential,
  passwordImportSupport,
  readBrowserKey,
} from "../password-native.js";

const temporary: string[] = [];
const key = pbkdf2Sync("synthetic-fixture", "saltysalt", 1003, 16, "sha1");
const nativeDir = path.resolve(
  import.meta.dirname,
  "../../../../native/browser-import",
);
function temp() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "catamorphic-password-import-"),
  );
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function encrypt(password: string | Buffer) {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(password),
    cipher.final(),
  ]);
}
function fixture() {
  const root = temp();
  const file = path.join(root, "Login Data");
  const database = new DatabaseSync(file);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER DEFAULT 0)",
  );
  const insert = database.prepare("INSERT INTO logins VALUES (?, ?, ?, ?)");
  insert.run(
    "https://example.com/login",
    "alice",
    encrypt("synthetic-password"),
    0,
  );
  insert.run("https://example.com/other", "alice", encrypt("duplicate"), 0);
  insert.run("https://kept.example", "bob", encrypt("do-not-replace"), 0);
  insert.run(
    "https://unsupported.example",
    "u",
    Buffer.from("v20unsupported-format"),
    0,
  );
  insert.run("android://app", "u", encrypt("invalid-origin"), 0);
  insert.run("https://never-save.example", "u", encrypt("blocked"), 1);
  return {
    database,
    source: {
      files: [file],
      keychainService: "Chrome Safe Storage",
      keychainAccount: "Chrome",
    },
  };
}

describe("direct password import", () => {
  it("reads live WAL entries without modifying the source and preserves existing accounts", async () => {
    const { source, database } = fixture();
    const before = database.prepare("SELECT * FROM logins").all();
    const importedKey = Buffer.from(key);
    const received: PasswordImportCredential[] = [];
    const save = vi.fn(async (credentials: PasswordImportCredential[]) => {
      received.push(...credentials);
      return { imported: credentials.length, existing: 0 };
    });
    try {
      const result = await importBrowserPasswords({
        source,
        existing: [{ origin: "https://kept.example", username: "bob" }],
        readKey: async () => importedKey,
        save,
      });
      expect(result).toEqual({
        imported: 1,
        existing: 2,
        failed: 1,
        invalid: 1,
        cancelled: false,
      });
      expect(save).toHaveBeenCalledOnce();
      expect(received).toEqual([
        {
          origin: "https://example.com",
          username: "alice",
          password: "synthetic-password",
        },
      ]);
      expect(importedKey.every((byte) => byte === 0)).toBe(true);
      expect(database.prepare("SELECT * FROM logins").all()).toEqual(before);
    } finally {
      database.close();
    }
  });
  it("does not save anything when Keychain access is cancelled", async () => {
    const { source, database } = fixture();
    const save = vi.fn();
    try {
      const result = await importBrowserPasswords({
        source,
        existing: [],
        readKey: async () => null,
        save,
      });
      expect(result.cancelled).toBe(true);
      expect(save).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
  it("clears the derived key even if the vault write fails", async () => {
    const { source, database } = fixture();
    const importedKey = Buffer.from(key);
    try {
      await expect(
        importBrowserPasswords({
          source,
          existing: [],
          readKey: async () => importedKey,
          save: async () => {
            throw new Error("disk full");
          },
        }),
      ).rejects.toThrow("disk full");
      expect(importedKey.every((byte) => byte === 0)).toBe(true);
    } finally {
      database.close();
    }
  });
  it("accepts supported Unicode passwords and rejects newer formats, corrupt padding and invalid UTF-8", () => {
    expect(
      decryptBrowserPassword({ encrypted: encrypt("秘密,\n🔐"), key }),
    ).toBe("秘密,\n🔐");
    expect(
      decryptBrowserPassword({ encrypted: encrypt(Buffer.from([0xff])), key }),
    ).toBeNull();
    expect(
      decryptBrowserPassword({ encrypted: Buffer.from("v20unknown"), key }),
    ).toBeNull();
    expect(
      decryptBrowserPassword({
        encrypted: encrypt("value").subarray(0, 18),
        key,
      }),
    ).toBeNull();
  });
  it("does not prompt when every login already exists", async () => {
    const { source, database } = fixture();
    database.exec(
      "DELETE FROM logins WHERE origin_url != 'https://example.com/login'",
    );
    const readKey = vi.fn();
    try {
      const result = await importBrowserPasswords({
        source,
        existing: [{ origin: "https://example.com", username: "alice" }],
        readKey,
        save: vi.fn(),
      });
      expect(result.existing).toBe(1);
      expect(readKey).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});

describe("profile discovery and platform gating", () => {
  it("includes Chrome, Edge, Opera, Brave, Arc and Chromium", () => {
    for (const id of ["chrome", "edge", "opera", "brave", "arc", "chromium"]) {
      expect(
        BROWSER_IMPORTERS.find((browser) => browser.id === id)?.passwordSource,
      ).toBeTypeOf("function");
    }
  });
  it("discovers password-only and Opera root profiles; refuses traversal and symlinked stores", () => {
    const root = temp();
    const importer = chromiumImporter({
      id: "test",
      label: "Test",
      darwinDir: "unused",
      baseDirOverride: root,
      keychainService: "Test Safe Storage",
      keychainAccount: "Test",
    });
    fs.writeFileSync(path.join(root, "Login Data"), "fixture");
    fs.mkdirSync(path.join(root, "Default"));
    fs.writeFileSync(
      path.join(root, "Default", "Login Data For Account"),
      "fixture",
    );
    expect(
      importer
        .detect()
        ?.profiles.map(({ id, hasPasswords }) => ({ id, hasPasswords })),
    ).toEqual([
      { id: ".", hasPasswords: true },
      { id: "Default", hasPasswords: true },
    ]);
    for (const id of ["..", "../Default", "/tmp", "Default\\other", "\0"])
      expect(importer.passwordSource?.(id)).toBeNull();
    fs.symlinkSync(temp(), path.join(root, "Escape"));
    expect(importer.passwordSource?.("Escape")).toBeNull();
    fs.unlinkSync(path.join(root, "Login Data"));
    fs.symlinkSync(
      path.join(root, "Default", "Login Data For Account"),
      path.join(root, "Login Data"),
    );
    expect(importer.passwordSource?.(".")).toBeNull();
  });
  it("gates by OS, architecture, OS version and helper availability", () => {
    const helperPath = path.join(temp(), "helper");
    fs.writeFileSync(helperPath, "fixture", { mode: 0o755 });
    for (const platform of ["linux", "win32"])
      expect(
        passwordImportSupport({
          helperPath,
          platform,
          arch: "arm64",
          darwinMajor: 25,
        }).available,
      ).toBe(false);
    expect(
      passwordImportSupport({
        helperPath,
        platform: "darwin",
        arch: "arm64",
        darwinMajor: 19,
      }).available,
    ).toBe(false);
    expect(
      passwordImportSupport({
        helperPath,
        platform: "darwin",
        arch: "ia32",
        darwinMajor: 25,
      }).available,
    ).toBe(false);
    expect(
      passwordImportSupport({
        helperPath,
        platform: "darwin",
        arch: "x64",
        darwinMajor: 20,
      }).available,
    ).toBe(true);
    fs.unlinkSync(helperPath);
    expect(
      passwordImportSupport({
        helperPath,
        platform: "darwin",
        arch: "arm64",
        darwinMajor: 25,
      }).available,
    ).toBe(false);
  });
  it("ships a prebuilt artifact matching its source manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(nativeDir, "manifest.json"), "utf8"),
    );
    const digest = (name: string) =>
      createHash("sha256")
        .update(fs.readFileSync(path.join(nativeDir, name)))
        .digest("hex");
    expect(digest("keychain.m")).toBe(manifest.sourceSha256);
    expect(digest("bin/browser-keychain")).toBe(manifest.binarySha256);
    expect(
      fs.statSync(path.join(nativeDir, "bin/browser-keychain")).size,
    ).toBeLessThan(256 * 1024);
  });
  it.skipIf(process.platform === "win32")(
    "sanitizes helper failures so process output cannot leak",
    async () => {
      const helperPath = path.join(temp(), "helper");
      fs.writeFileSync(
        helperPath,
        '#!/bin/sh\nprintf "synthetic-secret"\nprintf "synthetic-secret" >&2\nexit 4\n',
        { mode: 0o755 },
      );
      await expect(
        readBrowserKey({
          helperPath,
          source: {
            files: [],
            keychainService: "Test Safe Storage",
            keychainAccount: "Test",
          },
        }),
      ).rejects.toThrow(/^Could not unlock/);
    },
  );
});
