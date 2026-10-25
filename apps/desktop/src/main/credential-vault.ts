import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CredentialRef, CredentialVault } from "@catamorphic/core";
import { safeStorage } from "electron";
import { z } from "zod";
import { credentialEncryptionAvailable } from "./credential-encryption.js";

const VaultFileSchema = z.strictObject({
  version: z.literal(1),
  records: z.record(z.string(), z.string().min(1)),
});
type VaultFile = z.infer<typeof VaultFileSchema>;

export class DesktopCredentialVault implements CredentialVault {
  private data: VaultFile;

  constructor(private readonly file: string) {
    try {
      this.data = VaultFileSchema.parse(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        this.data = { version: 1, records: {} };
      else
        throw new Error("Credential vault could not be opened", {
          cause: error,
        });
    }
  }

  async put(args: {
    tenantId: string;
    material: Uint8Array;
  }): Promise<CredentialRef> {
    const ref = { id: randomUUID() };
    this.set(args.tenantId, ref, args.material);
    return ref;
  }

  async withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: Uint8Array) => Promise<T> | T;
  }): Promise<T> {
    if (!credentialEncryptionAvailable())
      throw new Error("OS credential encryption is unavailable");
    const ciphertext = this.data.records[key(args.tenantId, args.ref)];
    if (!ciphertext) throw new Error("Credential not found");
    const material = safeStorage.decryptString(
      Buffer.from(ciphertext, "base64"),
    );
    const bytes = Buffer.from(material, "base64");
    try {
      return await args.use(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  async delete(args: { tenantId: string; ref: CredentialRef }): Promise<void> {
    delete this.data.records[key(args.tenantId, args.ref)];
    this.save();
  }

  private set(
    tenantId: string,
    ref: CredentialRef,
    material: Uint8Array,
  ): void {
    if (!credentialEncryptionAvailable()) {
      throw new Error("OS credential encryption is unavailable");
    }
    this.data.records[key(tenantId, ref)] = safeStorage
      .encryptString(Buffer.from(material).toString("base64"))
      .toString("base64");
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }
}

function key(tenantId: string, ref: CredentialRef): string {
  return `${tenantId}:${z.uuid().parse(ref.id)}`;
}
