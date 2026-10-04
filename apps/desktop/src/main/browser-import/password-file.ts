import * as kdbx from "kdbxweb";
import "../kdbx-argon2.js";
import type { PasskeyInput } from "../browser-vault.js";
import {
  fromBase64Url,
  pemFromPkcs8,
  readPrivateKey,
  validRelyingParty,
} from "../webauthn.js";
import { type ImportedPassword, parsePasswordCsv } from "./password-csv.js";

/**
 * Password and passkey files from other managers (ADR 0201): a CSV export
 * (Chrome, Firefox, Safari, Bitwarden), Bitwarden's unencrypted JSON
 * export, and a KeePassXC (or any KeePass) database. Only Bitwarden and
 * KeePassXC write a passkey's private key into an export; Apple, Google
 * and 1Password keep theirs out of files.
 */

export interface ImportedVault {
  logins: ImportedPassword[];
  passkeys: PasskeyInput[];
  /** Items that hold neither a website login nor a usable passkey. */
  skipped: number;
}

export type PasswordFileKind = "csv" | "bitwarden" | "kdbx";

const KDBX_SIGNATURE = [0x03, 0xd9, 0xa2, 0x9a];

/** What a file holds, by its contents rather than its name. */
export function passwordFileKind(bytes: Uint8Array): PasswordFileKind {
  if (KDBX_SIGNATURE.every((byte, index) => bytes[index] === byte))
    return "kdbx";
  const start = Buffer.from(bytes.subarray(0, 64))
    .toString("utf8")
    .replace(/^﻿/, "")
    .trimStart();
  return start.startsWith("{") ? "bitwarden" : "csv";
}

/** An error the person can act on, shown as it is. */
export class PasswordFileError extends Error {}

function httpOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`,
    );
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** A relying party id Work could ever be asked for. */
function usableRpId(rpId: string): boolean {
  const id = rpId.trim().toLowerCase();
  const origin =
    id === "localhost" || id.endsWith(".localhost")
      ? `http://${id}`
      : `https://${id}`;
  return validRelyingParty(origin, id);
}

function passkey(input: {
  rpId: unknown;
  username: unknown;
  credentialId: Buffer | null;
  userHandle: Buffer | null;
  privateKeyPem: string | null;
  counter?: unknown;
  discoverable?: unknown;
  backupEligible?: boolean;
}): PasskeyInput | null {
  if (
    typeof input.rpId !== "string" ||
    !usableRpId(input.rpId) ||
    !input.credentialId?.length ||
    !input.privateKeyPem ||
    !readPrivateKey(input.privateKeyPem)
  )
    return null;
  const counter = Number(input.counter);
  return {
    rpId: input.rpId.trim().toLowerCase(),
    username: typeof input.username === "string" ? input.username : "",
    credentialId: input.credentialId,
    userHandle: input.userHandle?.length ? input.userHandle : null,
    privateKeyPem: input.privateKeyPem,
    counter: Number.isSafeInteger(counter) && counter > 0 ? counter : 0,
    discoverable: !(
      input.discoverable === false || input.discoverable === "false"
    ),
    backupEligible: input.backupEligible ?? true,
  };
}

/** Bitwarden writes new credential ids as GUIDs and others as `b64.<id>`. */
function bitwardenCredentialId(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value) return null;
  if (value.startsWith("b64.")) return fromBase64Url(value.slice(4));
  const hex = value.replace(/-/g, "");
  return /^[\da-f]{32}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Bitwarden's "JSON" export (not the encrypted one). */
export function readBitwardenExport(text: string): ImportedVault {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new PasswordFileError("This file is not a password export.");
  }
  // A password-protected export has no items at all, only ciphertext.
  if (isObject(parsed) && parsed.encrypted === true)
    throw new PasswordFileError(
      "This Bitwarden export is encrypted. Export again as JSON, not encrypted JSON, and delete the file after importing.",
    );
  if (!isObject(parsed) || !Array.isArray(parsed.items))
    throw new PasswordFileError(
      "This JSON file is not a Bitwarden export. Export your vault from Bitwarden as JSON.",
    );
  const result: ImportedVault = { logins: [], passkeys: [], skipped: 0 };
  for (const item of parsed.items) {
    const login = isObject(item) ? item.login : null;
    if (!isObject(login)) {
      result.skipped++;
      continue;
    }
    let used = false;
    const username = typeof login.username === "string" ? login.username : "";
    const password = typeof login.password === "string" ? login.password : "";
    const uris = Array.isArray(login.uris) ? login.uris : [];
    const origin = uris
      .map((uri) => (isObject(uri) ? httpOrigin(String(uri.uri ?? "")) : null))
      .find(Boolean);
    if (origin && password) {
      result.logins.push({ origin, username, password });
      used = true;
    }
    const credentials = Array.isArray(login.fido2Credentials)
      ? login.fido2Credentials
      : [];
    for (const credential of credentials) {
      if (!isObject(credential)) continue;
      const key =
        typeof credential.keyValue === "string"
          ? pemFromPkcs8(fromBase64Url(credential.keyValue))
          : null;
      const imported = passkey({
        rpId: credential.rpId,
        username: credential.userName || username,
        credentialId: bitwardenCredentialId(credential.credentialId),
        userHandle:
          typeof credential.userHandle === "string"
            ? fromBase64Url(credential.userHandle)
            : null,
        privateKeyPem: key,
        counter: credential.counter,
        discoverable: credential.discoverable,
      });
      if (imported) {
        result.passkeys.push(imported);
        used = true;
      }
    }
    if (!used) result.skipped++;
  }
  return result;
}

function fieldText(entry: kdbx.KdbxEntry, name: string): string {
  const value = entry.fields.get(name);
  if (typeof value === "string") return value;
  if (value instanceof kdbx.ProtectedValue) return value.getText();
  return "";
}

/** A KeePass database, opened with its password and optional key file. */
export async function readKeepassDatabase({
  bytes,
  password,
  keyFile,
}: {
  bytes: Uint8Array;
  password: string;
  keyFile?: Uint8Array | null;
}): Promise<ImportedVault> {
  // An empty field means no password, as KeePassXC reads it; a database
  // whose password really is empty is tried next.
  const attempts = password ? [password] : keyFile ? [null, ""] : [""];
  let db: kdbx.Kdbx | null = null;
  for (const attempt of attempts) {
    const credentials = new kdbx.Credentials(
      attempt === null ? null : kdbx.ProtectedValue.fromString(attempt),
      // kdbxweb wipes the key bytes it is given, so each attempt gets a copy.
      keyFile ? toArrayBuffer(keyFile) : null,
    );
    const data = toArrayBuffer(bytes);
    try {
      db = await kdbx.Kdbx.load(data, credentials);
      break;
    } catch (error) {
      if (
        !(
          error instanceof kdbx.KdbxError &&
          error.code === kdbx.Consts.ErrorCodes.InvalidKey
        )
      )
        throw new PasswordFileError(
          "This KeePass database could not be read. Check that it is a KDBX file.",
        );
    } finally {
      new Uint8Array(data).fill(0);
    }
  }
  if (!db) throw new WrongDatabaseKey();
  const bin = db.meta.recycleBinUuid?.id;
  const result: ImportedVault = { logins: [], passkeys: [], skipped: 0 };
  const walk = (group: kdbx.KdbxGroup) => {
    if (bin && group.uuid.id === bin) return;
    for (const entry of group.entries) {
      let used = false;
      const username = fieldText(entry, "UserName");
      const origin = httpOrigin(fieldText(entry, "URL"));
      const secret = fieldText(entry, "Password");
      if (origin && secret) {
        result.logins.push({ origin, username, password: secret });
        used = true;
      }
      const pem = fieldText(entry, "KPEX_PASSKEY_PRIVATE_KEY_PEM");
      if (pem) {
        const handle = fieldText(entry, "KPEX_PASSKEY_USER_HANDLE");
        // StrongBox writes the older names; KeePassXC reads them first.
        const credentialId =
          fieldText(entry, "KPEX_PASSKEY_GENERATED_USER_ID") ||
          fieldText(entry, "KPEX_PASSKEY_CREDENTIAL_ID");
        const eligible = fieldText(entry, "KPEX_PASSKEY_FLAG_BE").toLowerCase();
        const imported = passkey({
          rpId: fieldText(entry, "KPEX_PASSKEY_RELYING_PARTY"),
          username:
            fieldText(entry, "KPXC_PASSKEY_USERNAME") ||
            fieldText(entry, "KPEX_PASSKEY_USERNAME") ||
            username,
          credentialId: credentialId ? fromBase64Url(credentialId) : null,
          backupEligible: eligible
            ? eligible === "1" || eligible === "true"
            : true,
          userHandle: handle ? fromBase64Url(handle) : null,
          privateKeyPem: normalizePem(pem),
          counter: fieldText(entry, "WORK_PASSKEY_COUNTER"),
          discoverable: fieldText(entry, "WORK_PASSKEY_DISCOVERABLE") !== "0",
        });
        if (imported) {
          result.passkeys.push(imported);
          used = true;
        }
      }
      if (!used) result.skipped++;
    }
    for (const child of group.groups) walk(child);
  };
  walk(db.getDefaultGroup());
  return result;
}

/** The database's password (or key file) did not open it. */
export class WrongDatabaseKey extends Error {
  constructor() {
    super("That password does not open this database.");
  }
}

/** KeePassXC's Bitwarden import writes the PEM without line breaks. */
function normalizePem(pem: string): string {
  const body = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  return pemFromPkcs8(Buffer.from(body, "base64"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** A CSV or Bitwarden file; KeePass databases go through `readKeepassDatabase`. */
export function readPasswordFile(bytes: Uint8Array): ImportedVault {
  const kind = passwordFileKind(bytes);
  const text = Buffer.from(bytes).toString("utf8");
  if (kind === "bitwarden") return readBitwardenExport(text);
  if (kind === "kdbx")
    throw new Error("KeePass databases need their password first");
  try {
    return { logins: parsePasswordCsv(text), passkeys: [], skipped: 0 };
  } catch {
    throw new PasswordFileError(
      "This file is not a password export. Choose a CSV, Bitwarden JSON or KeePass database.",
    );
  }
}
