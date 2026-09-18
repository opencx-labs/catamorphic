import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { readBrowserDatabase } from "./database.js";
import type { BrowserCookieSource } from "./types.js";

export interface ImportedCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}
export function decryptCookie({
  encrypted,
  key,
  host,
  version,
}: {
  encrypted: Uint8Array;
  key: Buffer;
  host: string;
  version: number;
}): string | null {
  if (Buffer.from(encrypted.subarray(0, 3)).toString() !== "v10") return null;
  let plaintext: Buffer | undefined;
  try {
    const cipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([
      cipher.update(encrypted.subarray(3)),
      cipher.final(),
    ]);
    if (version >= 24) {
      const digest = createHash("sha256").update(host).digest();
      if (
        plaintext.length < digest.length ||
        !timingSafeEqual(plaintext.subarray(0, digest.length), digest)
      )
        return null;
      return new TextDecoder("utf-8", { fatal: true }).decode(
        plaintext.subarray(digest.length),
      );
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return null;
  } finally {
    plaintext?.fill(0);
  }
}

/** Preserve host-only scope. Partitioned/container cookies cannot be flattened. */
export function readBrowserCookies({
  source,
  key,
}: {
  source: BrowserCookieSource;
  key: Buffer | null;
}): ImportedCookie[] {
  return readBrowserDatabase({
    file: source.file,
    read: (database) => {
      const firefox = source.format === "firefox";
      const versionRow = firefox
        ? undefined
        : database
            .prepare("SELECT value FROM meta WHERE key = 'version'")
            .get();
      const version = Number(versionRow?.value ?? 0);
      const rows = database.prepare(
        firefox
          ? "SELECT host AS host_key, name, value, path, expiry, isSecure AS is_secure, isHttpOnly AS is_httponly, sameSite AS samesite, originAttributes FROM moz_cookies LIMIT 20000"
          : "SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS REAL) AS expires_utc, is_secure, is_httponly, has_expires, samesite, top_frame_site_key FROM cookies LIMIT 20000",
      );
      const cookies: ImportedCookie[] = [];
      for (const row of rows.iterate()) {
        if (
          typeof row.host_key !== "string" ||
          typeof row.name !== "string" ||
          typeof row.path !== "string"
        )
          continue;
        if (row.top_frame_site_key || row.originAttributes) continue;
        const host = row.host_key;
        if (!/^\.?[a-z\d_.:\-[\]]+$/i.test(host) || !row.path.startsWith("/"))
          continue;
        const secure = row.is_secure === 1;
        const url = `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${row.path}`;
        try {
          new URL(url);
        } catch {
          continue;
        }
        const expires = firefox
          ? Number(row.expiry)
          : row.has_expires === 1
            ? Number(row.expires_utc) / 1_000_000 - 11_644_473_600
            : undefined;
        if (
          expires !== undefined &&
          (!Number.isFinite(expires) || expires <= Date.now() / 1000)
        )
          continue;
        const encrypted = row.encrypted_value;
        const value =
          encrypted instanceof Uint8Array && encrypted.length > 0
            ? key
              ? decryptCookie({ encrypted, key, host, version })
              : null
            : typeof row.value === "string"
              ? row.value
              : null;
        if (value === null) continue;
        const sameSite =
          row.samesite === 1
            ? "lax"
            : row.samesite === 2
              ? "strict"
              : row.samesite === 0
                ? "no_restriction"
                : "unspecified";
        cookies.push({
          url,
          name: row.name,
          value,
          path: row.path,
          secure,
          httpOnly: row.is_httponly === 1,
          ...(host.startsWith(".") ? { domain: host } : {}),
          ...(expires === undefined ? {} : { expirationDate: expires }),
          sameSite,
        });
      }
      return cookies;
    },
  });
}

export async function importBrowserCookies({
  cookies,
  existing,
  save,
}: {
  cookies: ImportedCookie[];
  existing: Array<{ name: string; domain?: string; path?: string }>;
  save: (cookie: ImportedCookie) => Promise<void>;
}): Promise<number> {
  const identity = (cookie: { name: string; domain?: string; path?: string }) =>
    JSON.stringify([cookie.domain, cookie.path ?? "/", cookie.name]);
  const seen = new Set(existing.map(identity));
  let imported = 0;
  for (const cookie of cookies) {
    const id = identity({
      ...cookie,
      domain: cookie.domain ?? new URL(cookie.url).hostname,
    });
    if (seen.has(id)) continue;
    try {
      await save(cookie);
      seen.add(id);
      imported++;
    } catch {
      /* Unsupported cookies stay in the source browser. */
    }
  }
  return imported;
}
