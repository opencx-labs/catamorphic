import { describe, expect, it } from "vitest";
import { MemoryCredentialVault } from "../services/credential-vault.js";
import {
  EncryptedCredentialVault,
  vaultKeyId,
} from "../services/encrypted-credential-vault.js";

describe("CredentialVault", () => {
  it("tenant-qualifies refs and zeroes callback copies", async () => {
    const vault = new MemoryCredentialVault();
    const ref = await vault.put({
      tenantId: "tenant-a",
      material: new TextEncoder().encode("first"),
    });
    let exposed: Uint8Array | undefined;
    await vault.withMaterial({
      tenantId: "tenant-a",
      ref,
      use: (material) => {
        exposed = material;
        expect(new TextDecoder().decode(material)).toBe("first");
      },
    });
    expect([...exposed!]).toEqual([0, 0, 0, 0, 0]);
    await expect(
      vault.withMaterial({ tenantId: "tenant-b", ref, use: () => undefined }),
    ).rejects.toThrow("not found");
    await vault.delete({ tenantId: "tenant-a", ref });
    await expect(
      vault.withMaterial({ tenantId: "tenant-a", ref, use: () => undefined }),
    ).rejects.toThrow("not found");
  });
});

describe("EncryptedCredentialVault keyring (ADR 0162)", () => {
  function memoryStore() {
    const records = new Map<string, Uint8Array>();
    return {
      records,
      get: async (key: string) => {
        const data = records.get(key);
        return data ? { data, etag: "e" } : null;
      },
      put: async (key: string, data: Uint8Array) => {
        records.set(key, data);
      },
      deletePrefix: async (key: string) => {
        records.delete(key);
      },
    };
  }
  const oldKey = new Uint8Array(32).fill(1);
  const newKey = new Uint8Array(32).fill(2);
  const read = (vault: EncryptedCredentialVault, ref: { id: string }) =>
    vault.withMaterial({
      tenantId: "tenant",
      ref,
      use: (material) => new TextDecoder().decode(material),
    });

  it("seals with the current key and still opens records of previous keys", async () => {
    const store = memoryStore();
    const before = new EncryptedCredentialVault({ store, keys: [oldKey] });
    const legacy = await before.put({
      tenantId: "tenant",
      material: new TextEncoder().encode("old secret"),
    });
    const rotated = new EncryptedCredentialVault({
      store,
      keys: [newKey, oldKey],
    });
    const fresh = await rotated.put({
      tenantId: "tenant",
      material: new TextEncoder().encode("new secret"),
    });
    expect(await read(rotated, legacy)).toBe("old secret");
    expect(await read(rotated, fresh)).toBe("new secret");
    expect(rotated.currentKeyId).toBe(vaultKeyId(newKey));
    const sealed = JSON.parse(
      new TextDecoder().decode(
        [...store.records.entries()].find(([key]) =>
          key.includes(fresh.id),
        )?.[1],
      ),
    );
    expect(sealed.kid).toBe(vaultKeyId(newKey));
    expect(JSON.stringify(sealed)).not.toContain("new secret");

    // Dropping the previous key before every record was rewritten is loud.
    const dropped = new EncryptedCredentialVault({ store, keys: [newKey] });
    await expect(read(dropped, legacy)).rejects.toThrow("key this vault lacks");
  });

  it("rejects keys that are not 32 bytes and an empty keyring", () => {
    expect(
      () =>
        new EncryptedCredentialVault({
          store: memoryStore(),
          keys: [new Uint8Array(16)],
        }),
    ).toThrow("32 bytes");
    expect(
      () => new EncryptedCredentialVault({ store: memoryStore(), keys: [] }),
    ).toThrow("at least one key");
  });
});
