import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EncryptedCredentialVault } from "@catamorphic/core";

/** Stock filesystem/key provisioning over the shared encryption implementation. */
export class EncryptedFileCredentialVault extends EncryptedCredentialVault {
  constructor(directory: string) {
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
      key: fs.readFileSync(keyFile),
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
