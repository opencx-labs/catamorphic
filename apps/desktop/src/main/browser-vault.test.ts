import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({
  encrypt: vi.fn<(value: string) => Promise<Buffer>>(),
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptStringAsync: encryption.encrypt,
    decryptStringAsync: vi.fn(),
  },
  systemPreferences: {
    canPromptTouchID: () => false,
  },
}));

const directories: string[] = [];

afterEach(() => {
  encryption.encrypt.mockReset();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PasswordVault", () => {
  it("coalesces concurrent profile unlocks into one Keychain access", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "cat-browser-vault-"),
    );
    directories.push(directory);
    let resolveEncryption: ((value: Buffer) => void) | undefined;
    encryption.encrypt.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEncryption = resolve;
        }),
    );
    const { PasswordVault } = await import("./browser-vault.js");
    const vault = new PasswordVault(directory);

    const first = vault.list("profile-1");
    const second = vault.list("profile-1");
    await vi.waitFor(() => expect(encryption.encrypt).toHaveBeenCalledOnce());

    resolveEncryption?.(Buffer.from("sealed-key"));
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(encryption.encrypt).toHaveBeenCalledOnce();
  });
});
