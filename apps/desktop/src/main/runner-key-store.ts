import fs from "node:fs";
import path from "node:path";
import {
  type ExecutorKeyPair,
  executorPublicKey,
  generateExecutorKeyPair,
} from "@catamorphic/sandbox";
import { safeStorage } from "electron";

interface StoredKey {
  version: 1;
  publicKey: string;
  privateKeyEncrypted: string;
}

/**
 * The key a Work server seals this machine's operations to (ADR 0207):
 * `<userData>/profiles/<id>/runner-key.json`, owner-only, its private half
 * encrypted at rest via safeStorage like remote credentials. Created on
 * first use; the This machine runner registers its public half every time
 * it connects, so it never leaves the profile. Without OS encryption the
 * key lasts only for this session, which costs nothing but a new
 * registration.
 */
export class RunnerKeyStore {
  private current: ExecutorKeyPair | undefined;

  constructor(private readonly file: string) {}

  /** This profile's key pair, created and stored on first use. */
  keyPair(): ExecutorKeyPair {
    if (this.current) return this.current;
    const keys = this.load() ?? this.create();
    this.current = keys;
    return keys;
  }

  private create(): ExecutorKeyPair {
    const keys = generateExecutorKeyPair();
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        "[desktop] OS keychain encryption unavailable; this machine's runner key will last only for this session.",
      );
      return keys;
    }
    const stored: StoredKey = {
      version: 1,
      publicKey: keys.publicKey,
      privateKeyEncrypted: safeStorage
        .encryptString(keys.privateKey)
        .toString("base64"),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
    return keys;
  }

  /** The stored pair, or undefined when absent, unreadable, or altered. */
  private load(): ExecutorKeyPair | undefined {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("version" in raw) ||
        raw.version !== 1 ||
        !("publicKey" in raw) ||
        typeof raw.publicKey !== "string" ||
        !("privateKeyEncrypted" in raw) ||
        typeof raw.privateKeyEncrypted !== "string"
      )
        return undefined;
      const privateKey = safeStorage.decryptString(
        Buffer.from(raw.privateKeyEncrypted, "base64"),
      );
      if (executorPublicKey(privateKey) !== raw.publicKey) return undefined;
      return { publicKey: raw.publicKey, privateKey };
    } catch {
      // Missing, unreadable, or sealed by another keychain: start anew.
      return undefined;
    }
  }
}
