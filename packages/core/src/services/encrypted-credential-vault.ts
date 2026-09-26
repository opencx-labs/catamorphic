import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import type { AppBundleStore } from "./app-bundle-store.js";
import type { CredentialRef, CredentialVault } from "./credential-vault.js";

const envelopeSchema = z.object({
  /** Which key sealed the record; absent on records sealed before keyrings. */
  kid: z.string().optional(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

interface VaultKey {
  id: string;
  key: Buffer;
}

/**
 * Host-injected encrypted storage. The wrapping keys never enter the store.
 * The first key seals new records; later keys only open older records, so a
 * rotation keeps them until every credential has been rewritten.
 */
export class EncryptedCredentialVault implements CredentialVault {
  private readonly keys: VaultKey[];
  constructor(
    private readonly options: {
      store: AppBundleStore;
      keys: readonly Uint8Array[];
    },
  ) {
    if (options.keys.length === 0)
      throw new Error("Vault needs at least one key");
    this.keys = options.keys.map((key) => {
      if (key.byteLength !== 32)
        throw new Error("Vault key must contain 32 bytes");
      return { id: vaultKeyId(key), key: Buffer.from(key) };
    });
  }

  /** The identifier of the key sealing new records (never the key). */
  get currentKeyId(): string {
    return this.current.id;
  }

  /** Identifiers of every key this vault can open, current first. */
  get keyIds(): string[] {
    return this.keys.map((key) => key.id);
  }

  private get current(): VaultKey {
    const [current] = this.keys;
    if (!current) throw new Error("Vault needs at least one key");
    return current;
  }
  async put(args: {
    tenantId: string;
    material: Uint8Array;
  }): Promise<CredentialRef> {
    const ref = { id: randomUUID() };
    const key = recordKey(args.tenantId, ref);
    const nonce = randomBytes(12);
    const current = this.current;
    const cipher = createCipheriv("aes-256-gcm", current.key, nonce);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([
      cipher.update(args.material),
      cipher.final(),
    ]);
    await this.options.store.put(
      key,
      Buffer.from(
        JSON.stringify({
          kid: current.id,
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
    const material = this.open(key, envelope);
    try {
      return await args.use(material);
    } finally {
      material.fill(0);
    }
  }
  private open(recordKey: string, envelope: z.infer<typeof envelopeSchema>) {
    const candidates = envelope.kid
      ? this.keys.filter((candidate) => candidate.id === envelope.kid)
      : this.keys;
    if (candidates.length === 0) {
      throw new Error("Credential was sealed with a key this vault lacks");
    }
    for (const candidate of candidates) {
      try {
        const tag = Buffer.from(envelope.tag, "base64");
        if (tag.byteLength !== 16) throw new Error("Malformed credential tag");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          candidate.key,
          Buffer.from(envelope.nonce, "base64"),
          { authTagLength: 16 },
        );
        decipher.setAAD(Buffer.from(recordKey));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]);
      } catch {
        // GCM authentication fails for the wrong key; try the next one.
      }
    }
    throw new Error("Credential could not be decrypted");
  }

  async delete(args: { tenantId: string; ref: CredentialRef }): Promise<void> {
    await this.options.store.deletePrefix(recordKey(args.tenantId, args.ref));
  }
}

function recordKey(tenantId: string, ref: CredentialRef): string {
  // Each segment is encoded independently; callers cannot escape the vault prefix.
  return `credentials/${encodeURIComponent(tenantId)}/${encodeURIComponent(ref.id)}/record`;
}

/** A stable, non-secret identifier for one vault key. */
export function vaultKeyId(key: Uint8Array): string {
  return createHash("sha256")
    .update("catamorphic/vault-key-id/v1\0")
    .update(key)
    .digest("hex")
    .slice(0, 16);
}
