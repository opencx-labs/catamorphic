import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    getSelectedStorageBackend: () => "gnome_libsecret",
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, ""),
  },
}));

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("DesktopCredentialVault", () => {
  it("preserves a corrupt vault and refuses to replace it with an empty one", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-desktop-vault-"),
    );
    directories.push(directory);
    const file = path.join(directory, "credentials.json");
    const { DesktopCredentialVault } = await import("./credential-vault.js");
    for (const contents of [
      "{broken",
      '{"version":2,"records":{}}',
      '{"version":1,"records":null}',
    ]) {
      fs.writeFileSync(file, contents);
      expect(() => new DesktopCredentialVault(file)).toThrow(
        "Credential vault could not be opened",
      );
      expect(fs.readFileSync(file, "utf8")).toBe(contents);
    }
  });
  it("persists only OS-encrypted material with restrictive permissions", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-desktop-vault-"),
    );
    directories.push(directory);
    const file = path.join(directory, "credentials.json");
    const { DesktopCredentialVault } = await import("./credential-vault.js");
    const vault = new DesktopCredentialVault(file);
    const ref = await vault.put({
      tenantId: "tenant",
      material: new TextEncoder().encode("desktop-secret"),
    });
    expect(fs.readFileSync(file, "utf8")).not.toContain("desktop-secret");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await expect(
      vault.withMaterial({
        tenantId: "tenant",
        ref,
        use: (material) => new TextDecoder().decode(material),
      }),
    ).resolves.toBe("desktop-secret");
  });
});
