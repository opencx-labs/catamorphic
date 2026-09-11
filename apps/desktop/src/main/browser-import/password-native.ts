import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { BrowserPasswordSource } from "./types.js";

export interface PasswordImportSupport {
  available: boolean;
  reason: string | null;
}

export interface PasswordImportCounts {
  imported: number;
  existing: number;
  invalid: number;
  failed: number;
}

export interface PasswordImportCredential {
  origin: string;
  username: string;
  password: string;
}

export function passwordImportSupport({
  helperPath,
  platform = process.platform,
  arch = process.arch,
  darwinMajor = Number(os.release().split(".")[0]),
}: {
  helperPath: string;
  platform?: string;
  arch?: string;
  darwinMajor?: number;
}): PasswordImportSupport {
  if (
    platform !== "darwin" ||
    !["arm64", "x64"].includes(arch) ||
    darwinMajor < 20
  ) {
    return {
      available: false,
      reason:
        "Direct password import requires macOS 11 or later on an Apple Silicon or Intel Mac. Use a password CSV on this device.",
    };
  }
  try {
    fs.accessSync(helperPath, fs.constants.X_OK);
    return { available: true, reason: null };
  } catch {
    return {
      available: false,
      reason:
        "Direct password import is unavailable in this installation. Use a password CSV instead.",
    };
  }
}

/** Errors intentionally exclude execFile's stdout/stderr and arguments. */
export function readBrowserKey({
  helperPath,
  source,
  signal,
}: {
  helperPath: string;
  source: BrowserPasswordSource;
  signal?: AbortSignal;
}): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    execFile(
      helperPath,
      [source.keychainService, source.keychainAccount],
      {
        encoding: "buffer",
        maxBuffer: 4096,
        timeout: 120_000,
        signal,
      },
      (error, stdout, stderr) => {
        stderr.fill(0);
        if (error || stdout.length !== 16) {
          stdout.fill(0);
          if (error?.code === 2) return resolve(null);
          return reject(
            new Error(
              error?.code === 3
                ? "This browser's encryption key was not found. Export a password CSV from the browser instead."
                : "Could not unlock this browser's passwords. Allow macOS Keychain access and try again, or import a password CSV.",
            ),
          );
        }
        resolve(stdout);
      },
    );
  });
}

interface EncryptedLogin {
  origin: string;
  username: string;
  encrypted: Uint8Array;
}

function readLogins(source: BrowserPasswordSource): {
  logins: EncryptedLogin[];
  invalid: number;
} {
  const logins: EncryptedLogin[] = [];
  let invalid = 0;
  let size = 0;
  let rowsRead = 0;
  for (const file of source.files) {
    // Recheck immediately before open; never follow a linked login database.
    if (!fs.lstatSync(file).isFile())
      throw new Error(
        "The browser profile changed. Scan again before importing.",
      );
    const database = new DatabaseSync(file, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
      const rows = database.prepare(
        "SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user = 0",
      );
      for (const row of rows.iterate()) {
        if (++rowsRead > 20_000)
          throw new Error("Password store is too large.");
        if (
          typeof row.origin_url !== "string" ||
          typeof row.username_value !== "string" ||
          !(row.password_value instanceof Uint8Array)
        ) {
          invalid++;
          continue;
        }
        let origin: string;
        try {
          const url = new URL(row.origin_url);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            invalid++;
            continue;
          }
          origin = url.origin;
        } catch {
          invalid++;
          continue;
        }
        size += row.password_value.length;
        if (logins.length >= 20_000 || size > 16 * 1024 * 1024) {
          throw new Error(
            "This password store is too large for direct import. Export a password CSV instead.",
          );
        }
        logins.push({
          origin,
          username: row.username_value,
          encrypted: row.password_value,
        });
      }
    } catch {
      throw new Error(
        "Could not read the browser's password store. Close that browser and try again, or export a password CSV.",
      );
    } finally {
      database.close();
    }
  }
  return { logins, invalid };
}

/** Chromium macOS v10: PBKDF2-derived AES-128-CBC, space IV, PKCS#7. */
export function decryptBrowserPassword({
  encrypted,
  key,
}: {
  encrypted: Uint8Array;
  key: Uint8Array;
}): string | null {
  if (
    encrypted.length < 19 ||
    Buffer.from(encrypted.subarray(0, 3)).toString() !== "v10"
  )
    return null;
  let plaintext: Buffer | undefined;
  try {
    const cipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([
      cipher.update(encrypted.subarray(3)),
      cipher.final(),
    ]);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext) || null;
  } catch {
    return null;
  } finally {
    plaintext?.fill(0);
  }
}

export async function importBrowserPasswords({
  source,
  existing,
  readKey,
  save,
}: {
  source: BrowserPasswordSource;
  existing: Array<{ origin: string; username: string }>;
  readKey: () => Promise<Buffer | null>;
  save: (
    credentials: PasswordImportCredential[],
  ) => Promise<{ imported: number; existing: number }>;
}): Promise<PasswordImportCounts & { cancelled: boolean }> {
  const { logins, invalid } = readLogins(source);
  const counts = {
    imported: 0,
    existing: 0,
    invalid,
    failed: 0,
    cancelled: false,
  };
  const seen = new Set(
    existing.map(({ origin, username }) => JSON.stringify([origin, username])),
  );
  const candidates = logins.filter((login) => {
    if (!seen.has(JSON.stringify([login.origin, login.username]))) return true;
    counts.existing++;
    return false;
  });
  if (!candidates.length) return counts;
  const key = await readKey();
  if (!key) return { ...counts, cancelled: true };
  const credentials: PasswordImportCredential[] = [];
  try {
    for (const login of candidates) {
      const identity = JSON.stringify([login.origin, login.username]);
      if (seen.has(identity)) {
        counts.existing++;
        continue;
      }
      const password = decryptBrowserPassword({
        encrypted: login.encrypted,
        key,
      });
      if (password === null) {
        counts.failed++;
        continue;
      }
      credentials.push({
        origin: login.origin,
        username: login.username,
        password,
      });
      seen.add(identity);
    }
    const saved = await save(credentials);
    counts.imported = saved.imported;
    counts.existing += saved.existing;
    return counts;
  } finally {
    key.fill(0);
    credentials.length = 0;
  }
}
