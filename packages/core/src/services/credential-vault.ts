export interface CredentialRef {
  readonly id: string;
}

export type CredentialMaterial = Uint8Array;

/**
 * What a stored record is for (ADR 0316). Core names every writer, so a
 * host vault can route each kind to its own store.
 */
export type CredentialPurpose =
  /** A connection's credential (a token, key, or host descriptor). */
  | "connection"
  /** A pending authorization's private state (a PKCE verifier). */
  | "authorization"
  /** A project secret's value, shared or one member's own. */
  | "project-secret"
  /** Values delivered to a session, kept so its transcript stays masked. */
  | "session-secrets"
  /** A member's private file for their sessions. */
  | "personal-file"
  /** A host's own setup record, such as a registered GitHub App. */
  | "host-setup";

/** Whose authority a record carries. */
export type CredentialOwner =
  | { kind: "member"; externalUserId: string }
  | { kind: "service"; name: string | null }
  | { kind: "project" }
  | { kind: "host" };

/**
 * Trusted context for one write, set by core and never by a caller of a
 * public API (ADR 0316). Reads and deletes take only the ref, so a ref must
 * identify the store that wrote it.
 */
export interface CredentialPlacement {
  purpose: CredentialPurpose;
  owner: CredentialOwner;
  /** Absent for tenant-wide records. */
  projectId?: string;
}

/**
 * Credential custody. Hosts may supply any implementation: Work never
 * requires that a secret be stored by Work itself (ADR 0316).
 */
export interface CredentialVault {
  put(args: {
    tenantId: string;
    material: CredentialMaterial;
    placement: CredentialPlacement;
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
  /**
   * Replica memory (single process): hosts with several replicas give
   * each the same shared vault.
   */
  private readonly records = new Map<string, Uint8Array>();

  async put(args: {
    tenantId: string;
    material: CredentialMaterial;
  }): Promise<CredentialRef> {
    const ref = { id: crypto.randomUUID() };
    // Copies: a Buffer's `slice` shares its memory.
    this.records.set(key(args.tenantId, ref), new Uint8Array(args.material));
    return ref;
  }

  async withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: CredentialMaterial) => Promise<T> | T;
  }): Promise<T> {
    const stored = this.records.get(key(args.tenantId, args.ref));
    if (!stored) throw new Error("Credential not found");
    const material = new Uint8Array(stored);
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
  return JSON.stringify([tenantId, ref.id]);
}

const ROUTE_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * One vault over several, chosen per write by host code (ADR 0316). Each ref
 * carries the key of the vault that wrote it, so reads, refreshes and
 * deletes reach that vault even after `select` changes; changing `select`
 * only moves new writes. Keys are lowercase letters, digits and hyphens.
 * `fallback` names the vault that holds refs written before routing (refs
 * without a known key), so an existing deployment keeps its records.
 */
export function routeCredentialVaults(args: {
  vaults: Readonly<Record<string, CredentialVault>>;
  fallback?: string;
  select: (write: {
    tenantId: string;
    placement: CredentialPlacement;
  }) => string | Promise<string>;
}): CredentialVault {
  for (const name of Object.keys(args.vaults)) {
    if (!ROUTE_KEY.test(name)) {
      throw new Error(`Invalid credential vault key '${name}'`);
    }
  }
  const vaultFor = (name: string): CredentialVault => {
    const vault = args.vaults[name];
    if (!vault) throw new Error(`No credential vault '${name}'`);
    return vault;
  };
  if (args.fallback !== undefined) vaultFor(args.fallback);
  const split = (ref: CredentialRef) => {
    const at = ref.id.indexOf(":");
    const name = at > 0 ? ref.id.slice(0, at) : undefined;
    if (name !== undefined && Object.hasOwn(args.vaults, name)) {
      return { vault: vaultFor(name), ref: { id: ref.id.slice(at + 1) } };
    }
    if (args.fallback === undefined) throw new Error("Credential not found");
    return { vault: vaultFor(args.fallback), ref };
  };
  return {
    async put(write) {
      const name = await args.select({
        tenantId: write.tenantId,
        placement: write.placement,
      });
      const ref = await vaultFor(name).put(write);
      return { id: `${name}:${ref.id}` };
    },
    async withMaterial(read) {
      const target = split(read.ref);
      return target.vault.withMaterial({ ...read, ref: target.ref });
    },
    async delete(removal) {
      const target = split(removal.ref);
      return target.vault.delete({ ...removal, ref: target.ref });
    },
  };
}
