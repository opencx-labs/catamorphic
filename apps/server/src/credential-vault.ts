import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CredentialRef, CredentialVault } from "@catamorphic/core";

interface Envelope {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export class EncryptedFileCredentialVault implements CredentialVault {
  private readonly key: Buffer;
  private readonly recordsDir: string;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const keyFile = path.join(directory, "vault.key");
    if (fs.existsSync(keyFile)) {
      this.key = fs.readFileSync(keyFile);
    } else {
      this.key = randomBytes(32);
      fs.writeFileSync(keyFile, this.key, { mode: 0o600, flag: "wx" });
    }
    if (this.key.length !== 32)
      throw new Error("Credential vault key is invalid");
    fs.chmodSync(keyFile, 0o600);
    this.recordsDir = path.join(directory, "records");
    fs.mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.recordsDir, 0o700);
  }

  async put(args: {
    tenantId: string;
    material: Uint8Array;
  }): Promise<CredentialRef> {
    const ref = { id: randomUUID() };
    this.write(args.tenantId, ref, args.material);
    return ref;
  }

  async withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: Uint8Array) => Promise<T> | T;
  }): Promise<T> {
    const envelope = JSON.parse(
      fs.readFileSync(this.file(args.tenantId, args.ref), "utf8"),
    ) as Envelope;
    if (envelope.version !== 1)
      throw new Error("Unsupported credential envelope");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(args.tenantId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const material = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    try {
      return await args.use(material);
    } finally {
      material.fill(0);
    }
  }

  async delete(args: { tenantId: string; ref: CredentialRef }): Promise<void> {
    const file = this.file(args.tenantId, args.ref);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  private write(
    tenantId: string,
    ref: CredentialRef,
    material: Uint8Array,
  ): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(tenantId));
    const ciphertext = Buffer.concat([cipher.update(material), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    const target = this.file(tenantId, ref);
    const temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  }

  private file(tenantId: string, ref: CredentialRef): string {
    const tenant = tenantId.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.recordsDir, `${tenant}.${ref.id}.json`);
  }
}
