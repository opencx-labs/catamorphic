import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CredentialRef, CredentialVault } from "@catamorphic/core";
import { safeStorage } from "electron";

interface VaultFile {
  version: 1;
  records: Record<string, string>;
}

export class DesktopCredentialVault implements CredentialVault {
  private data: VaultFile;

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VaultFile;
      this.data = parsed.version === 1 ? parsed : { version: 1, records: {} };
    } catch {
      this.data = { version: 1, records: {} };
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
    if (!safeStorage.isEncryptionAvailable()) {
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
    });
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
  }
}

function key(tenantId: string, ref: CredentialRef): string {
  return `${tenantId}:${ref.id}`;
}
