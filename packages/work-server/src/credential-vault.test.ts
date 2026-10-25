import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vaultKeyId } from "@catamorphic/core";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedFileCredentialVault } from "./credential-vault.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("EncryptedFileCredentialVault", () => {
  it("uses only explicitly configured keys, without adding a local fallback", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-vault-configured-"),
    );
    directories.push(directory);
    const local = new EncryptedFileCredentialVault(directory);
    const ref = await local.put({
      tenantId: "tenant",
      material: new TextEncoder().encode("local-secret"),
    });
    const configuredKey = new Uint8Array(32).fill(7);
    const configured = new EncryptedFileCredentialVault(directory, [
      configuredKey,
    ]);
    expect(configured.keyIds).toEqual([vaultKeyId(configuredKey)]);
    await expect(
      configured.withMaterial({ tenantId: "tenant", ref, use: () => "leaked" }),
    ).rejects.toThrow("key this vault lacks");
    const freshDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-vault-no-local-"),
    );
    directories.push(freshDirectory);
    new EncryptedFileCredentialVault(freshDirectory, [configuredKey]);
    expect(fs.existsSync(path.join(freshDirectory, "vault.key"))).toBe(false);
  });
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
