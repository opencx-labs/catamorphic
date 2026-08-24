import { describe, expect, it } from "vitest";
import { MemoryCredentialVault } from "../services/credential-vault.js";

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
