import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EncryptedCredentialVault } from "@catamorphic/core";

/**
 * Work server filesystem storage over the shared encryption implementation.
 * Without configured keys it generates and keeps an owner-only key beside the
 * records (standalone installs); configured keys come first when present.
 */
export class EncryptedFileCredentialVault extends EncryptedCredentialVault {
  constructor(directory: string, configuredKeys: readonly Uint8Array[] = []) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const keyFile = path.join(directory, "vault.key");
    try {
      fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    fs.chmodSync(keyFile, 0o600);
    const records = path.join(directory, "records");
    fs.mkdirSync(records, { recursive: true, mode: 0o700 });
    fs.chmodSync(records, 0o700);
    const file = (key: string) =>
      path.join(
        records,
        `${createHash("sha256").update(key).digest("hex")}.json`,
      );
    super({
      keys: [...configuredKeys, fs.readFileSync(keyFile)],
      store: {
        get: async (key) => {
          try {
            const data = fs.readFileSync(file(key));
            return {
              data,
              etag: createHash("sha256").update(data).digest("hex"),
            };
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return null;
            throw error;
          }
        },
        put: async (key, data) => {
          const target = file(key);
          const temporary = `${target}.${randomUUID()}.tmp`;
          fs.writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, target);
        },
        // The vault deletes an exact record key, never a broad storage prefix.
        deletePrefix: async (key) => {
          fs.rmSync(file(key), { force: true });
        },
      },
    });
  }
}
