import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import type { AppBundleStore } from "./app-bundle-store.js";
import type { CredentialRef, CredentialVault } from "./credential-vault.js";

const envelopeSchema = z.object({
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

/** Host-injected encrypted storage. The wrapping key never enters the store. */
export class EncryptedCredentialVault implements CredentialVault {
  private readonly key: Buffer;
  constructor(
    private readonly options: { store: AppBundleStore; key: Uint8Array },
  ) {
    if (options.key.byteLength !== 32)
      throw new Error("Vault key must contain 32 bytes");
    this.key = Buffer.from(options.key);
  }
  async put(args: {
    tenantId: string;
    material: Uint8Array;
  }): Promise<CredentialRef> {
    const ref = { id: randomUUID() };
    const key = recordKey(args.tenantId, ref);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([
      cipher.update(args.material),
      cipher.final(),
    ]);
    await this.options.store.put(
      key,
      Buffer.from(
        JSON.stringify({
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        }),
      ),
    );
    return ref;
  }
  async withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: Uint8Array) => Promise<T> | T;
  }): Promise<T> {
    const key = recordKey(args.tenantId, args.ref);
    const stored = await this.options.store.get(key);
    if (!stored) throw new Error("Credential not found");
    const envelope = envelopeSchema.parse(
      JSON.parse(new TextDecoder().decode(stored.data)),
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(key));
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
    await this.options.store.deletePrefix(recordKey(args.tenantId, args.ref));
  }
}

function recordKey(tenantId: string, ref: CredentialRef): string {
  // Each segment is encoded independently; callers cannot escape the vault prefix.
  return `credentials/${encodeURIComponent(tenantId)}/${encodeURIComponent(ref.id)}/record`;
}
