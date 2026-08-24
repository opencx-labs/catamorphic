export interface CredentialRef {
  readonly id: string;
}

export type CredentialMaterial = Uint8Array;

export interface CredentialVault {
  put(args: {
    tenantId: string;
    material: CredentialMaterial;
  }): Promise<CredentialRef>;
  withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: CredentialMaterial) => Promise<T> | T;
  }): Promise<T>;
  delete(args: { tenantId: string; ref: CredentialRef }): Promise<void>;
}

/** Test and ephemeral-host implementation. Stored bytes are never returned. */
export class MemoryCredentialVault implements CredentialVault {
  private readonly records = new Map<string, Uint8Array>();

  async put(args: {
    tenantId: string;
    material: CredentialMaterial;
  }): Promise<CredentialRef> {
    const ref = { id: crypto.randomUUID() };
    this.records.set(key(args.tenantId, ref), args.material.slice());
    return ref;
  }

  async withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: CredentialMaterial) => Promise<T> | T;
  }): Promise<T> {
    const stored = this.records.get(key(args.tenantId, args.ref));
    if (!stored) throw new Error("Credential not found");
    const material = stored.slice();
    try {
      return await args.use(material);
    } finally {
      material.fill(0);
    }
  }

  async delete(args: { tenantId: string; ref: CredentialRef }): Promise<void> {
    const recordKey = key(args.tenantId, args.ref);
    const stored = this.records.get(recordKey);
    stored?.fill(0);
    this.records.delete(recordKey);
  }
}

function key(tenantId: string, ref: CredentialRef): string {
  return `${tenantId}:${ref.id}`;
}
