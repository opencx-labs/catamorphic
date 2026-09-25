import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedFileCredentialVault } from "./credential-vault.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("EncryptedFileCredentialVault", () => {
  it("encrypts, authenticates, and deletes material", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-vault-"));
    directories.push(directory);
    const vault = new EncryptedFileCredentialVault(directory);
    const ref = await vault.put({
      tenantId: "tenant",
      material: new TextEncoder().encode("super-secret"),
    });
    const recordFile = fs
      .readdirSync(path.join(directory, "records"))
      .map((name) => path.join(directory, "records", name))[0]!;
    expect(fs.readFileSync(recordFile, "utf8")).not.toContain("super-secret");
    expect(fs.statSync(recordFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(directory, "vault.key")).mode & 0o777).toBe(
      0o600,
    );
    await expect(
      vault.withMaterial({
        tenantId: "tenant",
        ref,
        use: (material) => new TextDecoder().decode(material),
      }),
    ).resolves.toBe("super-secret");
    const envelope = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    fs.writeFileSync(recordFile, JSON.stringify(envelope));
    await expect(
      vault.withMaterial({
        tenantId: "tenant",
        ref,
        use: () => undefined,
      }),
    ).rejects.toThrow();
    await vault.delete({ tenantId: "tenant", ref });
    expect(fs.existsSync(recordFile)).toBe(false);
  });
});
